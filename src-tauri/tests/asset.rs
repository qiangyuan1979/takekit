//! 集成测试：即梦（Ark）图片适配器（spec §9.3、§9.4、§10）。
//!
//! 用 wiremock 起一个假的即梦服务，锁死五类行为：
//! 请求体翻译（含负向提示词的降级与参考图注入）、URL / b64 双通道出图、
//! 限流退避重试、错误归一化码、配置缺失时快速失败。
//!
//! 请求体断言一律走「抓取已收到的请求」而不是 wiremock 的 body 匹配器，
//! 这样「某个键必须不存在」也能被严格锁死。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use takekit_lib::adapters::image::jimeng::JimengProvider;
use takekit_lib::adapters::image::{ImageProvider, ImageRequest};

const API_KEY: &str = "ak-test";
const MODEL: &str = "jimeng-test";
const GENERATE_PATH: &str = "/images/generations";

/// 带 PNG 文件头的最小字节序列；适配器只按文件头 / content-type 识别类型。
fn png_bytes() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    bytes.extend_from_slice(b"fake-image-body");
    bytes
}

fn provider(server: &MockServer) -> JimengProvider {
    JimengProvider::new(&server.uri(), API_KEY, MODEL, Duration::from_secs(5))
        .expect("provider should build")
}

fn request() -> ImageRequest {
    ImageRequest {
        prompt: "雨中撑伞的女孩".into(),
        negative_prompt: Some("多余的手指".into()),
        width: 1024,
        height: 1024,
        count: 1,
        seed: None,
        ref_images: Vec::new(),
    }
}

/// 抓取发往生成端点的请求体（并校验条数由调用方断言）。
async fn generate_bodies(server: &MockServer) -> Vec<Value> {
    server
        .received_requests()
        .await
        .expect("requests should be recorded")
        .iter()
        .filter(|request| request.url.path() == GENERATE_PATH)
        .map(|request| serde_json::from_slice::<Value>(&request.body).expect("body should be JSON"))
        .collect()
}

/// URL 通道：拿回图片地址后必须自己下载，并按响应头归一化 mime。
#[tokio::test]
async fn generate_posts_then_downloads_the_returned_url() {
    let server = MockServer::start().await;
    let image_url = format!("{}/img/0.png", server.uri());

    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .and(header("authorization", format!("Bearer {API_KEY}")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "data": [{ "url": image_url }] })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/img/0.png"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "image/jpeg; charset=binary")
                .set_body_bytes(png_bytes()),
        )
        .mount(&server)
        .await;

    let outputs = provider(&server)
        .generate(&request())
        .await
        .expect("generate should succeed");

    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].mime, "image/jpeg");
    assert_eq!(outputs[0].bytes, png_bytes());

    let bodies = generate_bodies(&server).await;
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["model"], MODEL);
    assert_eq!(bodies[0]["prompt"], "雨中撑伞的女孩");
    assert_eq!(bodies[0]["size"], "1024x1024");
    assert_eq!(bodies[0]["response_format"], "url");
    assert_eq!(bodies[0]["watermark"], false);
    assert_eq!(bodies[0]["n"], 1);
}

/// b64 通道：不下载，直接解码；mime 由文件头嗅探得出。
#[tokio::test]
async fn generate_decodes_inline_base64_and_sniffs_mime() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [{ "b64_json": BASE64.encode(png_bytes()) }]
        })))
        .mount(&server)
        .await;

    let outputs = provider(&server)
        .generate(&request())
        .await
        .expect("generate should succeed");

    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].mime, "image/png");
    assert_eq!(outputs[0].bytes, png_bytes());
    // 没有 url 就一次下载都不该发生。
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

/// 多张候选：`n` 张就要落 `n` 份字节，顺序保持服务端返回顺序。
#[tokio::test]
async fn generate_returns_every_candidate_in_order() {
    let server = MockServer::start().await;
    let encoded = BASE64.encode(png_bytes());
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [{ "b64_json": encoded }, { "b64_json": encoded }, { "b64_json": encoded }]
        })))
        .mount(&server)
        .await;

    let mut req = request();
    req.count = 3;
    let outputs = provider(&server).generate(&req).await.unwrap();
    assert_eq!(outputs.len(), 3);
}

/// 即梦不支持负向提示词：适配器必须降级为不下发；参考图与 seed 照常翻译。
#[tokio::test]
async fn negative_prompt_is_dropped_while_reference_image_and_seed_are_forwarded() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [{ "b64_json": BASE64.encode(png_bytes()) }]
        })))
        .mount(&server)
        .await;

    let mut req = request();
    req.ref_images = vec!["data:image/png;base64,AAAA".into()];
    req.seed = Some(42);
    provider(&server).generate(&req).await.unwrap();

    let bodies = generate_bodies(&server).await;
    assert_eq!(bodies.len(), 1);
    let body = &bodies[0];
    assert!(
        body.get("negative_prompt").is_none(),
        "即梦没有负向提示词字段，适配器必须降级为不下发：{body}"
    );
    assert_eq!(body["image"], "data:image/png;base64,AAAA");
    assert_eq!(body["seed"], 42);
}

/// 宽高 / 张数为 0 时回落默认值；超过上限的 `n` 被压到 4。
#[tokio::test]
async fn zero_size_and_count_fall_back_to_defaults_and_n_is_capped() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [{ "b64_json": BASE64.encode(png_bytes()) }]
        })))
        .mount(&server)
        .await;

    let bare = ImageRequest {
        prompt: "空镜".into(),
        ..ImageRequest::default()
    };
    provider(&server).generate(&bare).await.unwrap();

    let mut huge = ImageRequest {
        prompt: "空镜".into(),
        width: 512,
        height: 768,
        count: 99,
        ..ImageRequest::default()
    };
    huge.width = 512;
    provider(&server).generate(&huge).await.unwrap();

    let bodies = generate_bodies(&server).await;
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0]["size"], "1024x1024");
    assert_eq!(bodies[0]["n"], 4);
    assert_eq!(bodies[1]["size"], "512x768");
    assert_eq!(bodies[1]["n"], 4);
    assert!(bodies[0].get("seed").is_none());
    assert!(bodies[0].get("image").is_none());
}

/// 429 应退避重试，前两次失败后第三次成功。
#[tokio::test]
async fn rate_limit_is_retried_then_succeeds() {
    let server = MockServer::start().await;
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);

    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(move |_req: &wiremock::Request| {
            if counter.fetch_add(1, Ordering::SeqCst) < 2 {
                ResponseTemplate::new(429).set_body_string("slow down")
            } else {
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "data": [{ "b64_json": BASE64.encode(png_bytes()) }] }))
            }
        })
        .mount(&server)
        .await;

    let outputs = provider(&server)
        .generate(&request())
        .await
        .expect("third attempt should succeed");

    assert_eq!(outputs.len(), 1);
    assert_eq!(hits.load(Ordering::SeqCst), 3, "应在两次 429 后才成功");
}

/// 一直限流时，重试次数用尽后返回 `rate_limit`。
#[tokio::test]
async fn persistent_rate_limit_reports_rate_limit() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
        .mount(&server)
        .await;

    let error = provider(&server).generate(&request()).await.unwrap_err();
    assert_eq!(error.code(), "rate_limit");
}

/// 401 不重试，直接归一到 `auth`。
#[tokio::test]
async fn unauthorized_is_reported_as_auth_without_retry() {
    let server = MockServer::start().await;
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);

    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(move |_req: &wiremock::Request| {
            counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(401).set_body_string("invalid api key")
        })
        .mount(&server)
        .await;

    let error = provider(&server).generate(&request()).await.unwrap_err();
    assert_eq!(error.code(), "auth");
    assert_eq!(hits.load(Ordering::SeqCst), 1, "鉴权失败不应重试");
}

/// 空提示词在发请求前就被拦下。
#[tokio::test]
async fn blank_prompt_is_rejected_without_request() {
    let server = MockServer::start().await;
    let blank = ImageRequest {
        prompt: "   ".into(),
        ..ImageRequest::default()
    };

    let error = provider(&server).generate(&blank).await.unwrap_err();
    assert_eq!(error.code(), "validation");
    assert!(server.received_requests().await.unwrap().is_empty());
}

/// 服务端返回空 `data`：报 `provider`，而不是当成成功但没图。
#[tokio::test]
async fn empty_data_is_reported_as_provider() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": [] })))
        .mount(&server)
        .await;

    let error = provider(&server).generate(&request()).await.unwrap_err();
    assert_eq!(error.code(), "provider");
}

/// 200 但不是合法 JSON，报 `provider` 而不是 panic。
#[tokio::test]
async fn malformed_body_is_reported_as_provider() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_raw("<html>oops</html>", "text/html"))
        .mount(&server)
        .await;

    let error = provider(&server).generate(&request()).await.unwrap_err();
    assert_eq!(error.code(), "provider");
}

/// 配置缺失在第一处就报错，而不是发一个注定失败的请求。
#[test]
fn misconfigured_provider_fails_fast() {
    let blank_base = JimengProvider::new("  ", API_KEY, MODEL, Duration::from_secs(5))
        .err()
        .expect("empty base url must fail");
    assert_eq!(blank_base.code(), "validation");

    let blank_model =
        JimengProvider::new("http://localhost:1", API_KEY, "", Duration::from_secs(5))
            .err()
            .expect("empty model must fail");
    assert_eq!(blank_model.code(), "validation");

    let blank_key = JimengProvider::new("http://localhost:1", "", MODEL, Duration::from_secs(5))
        .err()
        .expect("empty api key must fail");
    assert_eq!(blank_key.code(), "auth");
}
