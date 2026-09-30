//! 集成测试：视频适配器真机 HTTP 往返（spec §9.4、§10）。
//!
//! 用 wiremock 起一个假的厂商服务，锁死「提交 → 轮询 → 下载」三段链路的真实报文：
//! 端点选择（可灵按有无首帧分流 text2video / image2video）、鉴权头、请求体翻译、
//! 业务码 / 任务失败 / 未知状态 / 限流退避 / 超时 / 畸形报文 / 取消。
//!
//! 请求体断言一律走「抓取已收到的请求」而不是 wiremock 的 body 匹配器，
//! 这样「某个键必须不存在」也能被严格锁死（与 `tests/llm.rs`、`tests/asset.rs` 一致）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use takekit_lib::adapters::video::jimeng::JimengVideoGenerator;
use takekit_lib::adapters::video::kling::KlingGenerator;
use takekit_lib::adapters::video::{VideoCredentials, VideoGenerator, VideoRequest, VideoStatus};
use takekit_lib::project::{AspectRatio, VideoParams};

const API_KEY: &str = "sk-test";
const KLING_TEXT: &str = "/v1/videos/text2video";
const KLING_IMAGE: &str = "/v1/videos/image2video";
const JIMENG_TASKS: &str = "/contents/generations/tasks";

/// 带 MP4 `ftyp` 文件头的最小字节序列；适配器按响应头 / 文件头识别类型。
fn mp4_bytes() -> Vec<u8> {
    let mut bytes = vec![0u8; 4];
    bytes.extend_from_slice(b"ftyp");
    bytes.extend_from_slice(b"fake-video-body");
    bytes
}

fn credentials(server: &MockServer) -> VideoCredentials {
    VideoCredentials {
        base_url: server.uri(),
        api_key: API_KEY.into(),
        model: String::new(),
        timeout: Duration::from_secs(5),
    }
}

fn kling(server: &MockServer) -> KlingGenerator {
    KlingGenerator::new(&credentials(server)).expect("kling generator should build")
}

fn jimeng(server: &MockServer) -> JimengVideoGenerator {
    JimengVideoGenerator::new(&credentials(server)).expect("jimeng generator should build")
}

fn request() -> VideoRequest {
    VideoRequest {
        prompt: "女主推门而入".into(),
        params: VideoParams {
            duration_ms: 5_000,
            aspect_ratio: AspectRatio::Portrait,
            resolution: "1080x1920".into(),
            fps: 30,
            ..VideoParams::default()
        },
    }
}

/// 抓取发往指定路径的请求体（条数由调用方断言）。
async fn bodies(server: &MockServer, path: &str) -> Vec<Value> {
    server
        .received_requests()
        .await
        .expect("requests should be recorded")
        .iter()
        .filter(|request| request.url.path() == path)
        .map(|request| serde_json::from_slice::<Value>(&request.body).expect("body should be JSON"))
        .collect()
}

// ---------- 可灵 ----------

/// 文本驱动：提交拿 `data.task_id` + 轮询两次 + 下载字节，全链路走通。
#[tokio::test]
async fn kling_text_to_video_round_trip() {
    let server = MockServer::start().await;
    let video_url = format!("{}/clips/0.mp4", server.uri());

    Mock::given(method("POST"))
        .and(path(KLING_TEXT))
        .and(header("authorization", format!("Bearer {API_KEY}")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "code": 0, "data": { "task_id": "task-1" } })),
        )
        .mount(&server)
        .await;

    let polls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&polls);
    Mock::given(method("GET"))
        .and(path("/v1/videos/text2video/task-1"))
        .respond_with(move |_req: &wiremock::Request| {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "code": 0, "data": { "task_status": "processing" } }))
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "code": 0,
                    "data": {
                        "task_status": "succeed",
                        "task_result": { "videos": [{ "url": video_url }] }
                    }
                }))
            }
        })
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/clips/0.mp4"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "video/mp4")
                .set_body_bytes(mp4_bytes()),
        )
        .mount(&server)
        .await;

    let generator = kling(&server);
    let submitted = generator
        .submit(&request())
        .await
        .expect("submit should succeed");
    assert_eq!(submitted.task_id, "task-1");
    assert_eq!(submitted.handle, "text2video:task-1");

    let running = generator
        .poll(&submitted.handle)
        .await
        .expect("poll should succeed");
    assert_eq!(running.status, VideoStatus::Running);

    let done = generator
        .poll(&submitted.handle)
        .await
        .expect("poll should succeed");
    assert_eq!(done.status, VideoStatus::Succeeded);
    let url = done.video_url.expect("succeed must carry a download url");

    let output = generator.fetch(&url).await.expect("fetch should succeed");
    assert_eq!(output.mime, "video/mp4");
    assert_eq!(output.bytes, mp4_bytes());

    let sent = bodies(&server, KLING_TEXT).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["model_name"], "kling-v1");
    assert_eq!(sent[0]["prompt"], "女主推门而入");
    assert_eq!(sent[0]["duration"], "5");
    assert_eq!(sent[0]["mode"], "pro");
    assert!(sent[0].get("image").is_none(), "纯文本不该带首帧");
}

/// 带首帧时改走 image2video，且 handle 记住路由，轮询必须打到对应端点。
#[tokio::test]
async fn kling_first_frame_routes_to_image_endpoint() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path(KLING_IMAGE))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "code": 0, "data": { "task_id": "task-2" } })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/videos/image2video/task-2"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "code": 0, "data": { "task_status": "submitted" } })),
        )
        .mount(&server)
        .await;

    let mut req = request();
    req.params.first_frame = Some("data:image/png;base64,AAA".into());

    let generator = kling(&server);
    let submitted = generator.submit(&req).await.expect("submit should succeed");
    assert_eq!(submitted.handle, "image2video:task-2");

    let queued = generator
        .poll(&submitted.handle)
        .await
        .expect("poll should succeed");
    assert_eq!(queued.status, VideoStatus::Queued);

    let sent = bodies(&server, KLING_IMAGE).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["image"], "data:image/png;base64,AAA");
    assert!(
        bodies(&server, KLING_TEXT).await.is_empty(),
        "文本端点不该收到请求"
    );
}

/// HTTP 200 但业务码非 0，也要当作厂商错误抛出。
#[tokio::test]
async fn kling_business_code_error_is_surfaced() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(KLING_TEXT))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "code": 1101, "message": "账户余额不足" })),
        )
        .mount(&server)
        .await;

    let error = kling(&server).submit(&request()).await.unwrap_err();
    assert_eq!(error.code(), "provider");
    assert!(error.to_string().contains("1101"));
}

/// 任务失败时，厂商给的原因要原样带回给用户。
#[tokio::test]
async fn kling_failed_task_reports_its_message() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/videos/text2video/task-3"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "code": 0,
            "data": { "task_status": "failed", "task_status_msg": "内容审核未通过" }
        })))
        .mount(&server)
        .await;

    let polled = kling(&server)
        .poll("text2video:task-3")
        .await
        .expect("poll should succeed");
    assert_eq!(polled.status, VideoStatus::Failed);
    assert_eq!(polled.error.as_deref(), Some("内容审核未通过"));
    assert_eq!(polled.video_url, None);
}

/// 出现没见过的状态词时，宁可报错也不要静默当成成功。
#[tokio::test]
async fn kling_unknown_status_is_a_provider_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/videos/text2video/task-4"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "code": 0, "data": { "task_status": "莫名其妙" } })),
        )
        .mount(&server)
        .await;

    let error = kling(&server).poll("text2video:task-4").await.unwrap_err();
    assert_eq!(error.code(), "provider");
}

/// 429 应退避重试，前两次失败后第三次成功。
#[tokio::test]
async fn kling_rate_limit_is_retried_then_succeeds() {
    let server = MockServer::start().await;
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);

    Mock::given(method("POST"))
        .and(path(KLING_TEXT))
        .respond_with(move |_req: &wiremock::Request| {
            if counter.fetch_add(1, Ordering::SeqCst) < 2 {
                ResponseTemplate::new(429).set_body_string("slow down")
            } else {
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "code": 0, "data": { "task_id": "task-1" } }))
            }
        })
        .mount(&server)
        .await;

    let submitted = kling(&server)
        .submit(&request())
        .await
        .expect("third attempt should succeed");
    assert_eq!(submitted.task_id, "task-1");
    assert_eq!(hits.load(Ordering::SeqCst), 3, "应在两次 429 后才成功");
}

/// 一直限流时，重试次数用尽后返回 `rate_limit`。
#[tokio::test]
async fn kling_persistent_rate_limit_reports_rate_limit() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(KLING_TEXT))
        .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
        .mount(&server)
        .await;

    let error = kling(&server).submit(&request()).await.unwrap_err();
    assert_eq!(error.code(), "rate_limit");
}

/// 整体超时应归一到 `timeout`。
#[tokio::test]
async fn kling_timeout_is_reported_as_timeout() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(KLING_TEXT))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(1500)))
        .mount(&server)
        .await;

    let mut creds = credentials(&server);
    creds.timeout = Duration::from_millis(150);
    let generator = KlingGenerator::new(&creds).expect("generator should build");

    let error = generator.submit(&request()).await.unwrap_err();
    assert_eq!(error.code(), "timeout");
}

/// 200 但不是合法 JSON，报 `provider` 而不是 panic。
#[tokio::test]
async fn kling_malformed_json_is_reported_as_provider() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(KLING_TEXT))
        .respond_with(ResponseTemplate::new(200).set_body_raw("<html>oops</html>", "text/html"))
        .mount(&server)
        .await;

    let error = kling(&server).submit(&request()).await.unwrap_err();
    assert_eq!(error.code(), "provider");
}

/// 下载时响应头不可用时，按文件头兜底识别容器类型。
#[tokio::test]
async fn kling_fetch_sniffs_mime_when_header_is_useless() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/clips/raw.bin"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/octet-stream")
                .set_body_bytes(mp4_bytes()),
        )
        .mount(&server)
        .await;

    let url = format!("{}/clips/raw.bin", server.uri());
    let output = kling(&server)
        .fetch(&url)
        .await
        .expect("fetch should succeed");
    assert_eq!(output.mime, "video/mp4");
}

/// 只吃属性的无状态操作：可灵没有取消端点，属空操作且不发任何请求。
#[tokio::test]
async fn kling_cancel_is_a_no_op() {
    let server = MockServer::start().await;
    kling(&server)
        .cancel("text2video:task-1")
        .await
        .expect("kling cancel should always succeed");
    assert!(server
        .received_requests()
        .await
        .expect("requests should be recorded")
        .is_empty());
}

// ---------- 即梦（方舟 Seedance） ----------

/// 方舟是标准三段 REST：顶层 `id` / 顶层 `status` / `content.video_url`。
#[tokio::test]
async fn jimeng_submit_poll_fetch_round_trip() {
    let server = MockServer::start().await;
    let video_url = format!("{}/videos/0.mp4", server.uri());

    Mock::given(method("POST"))
        .and(path(JIMENG_TASKS))
        .and(header("authorization", format!("Bearer {API_KEY}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "task-9" })))
        .mount(&server)
        .await;

    let polls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&polls);
    Mock::given(method("GET"))
        .and(path("/contents/generations/tasks/task-9"))
        .respond_with(move |_req: &wiremock::Request| {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "id": "task-9", "status": "running" }))
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "id": "task-9",
                    "status": "succeeded",
                    "content": { "video_url": video_url }
                }))
            }
        })
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/videos/0.mp4"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "video/mp4")
                .set_body_bytes(mp4_bytes()),
        )
        .mount(&server)
        .await;

    let generator = jimeng(&server);
    let submitted = generator
        .submit(&request())
        .await
        .expect("submit should succeed");
    assert_eq!(submitted.task_id, "task-9");
    assert_eq!(submitted.handle, "task-9");

    assert_eq!(
        generator
            .poll(&submitted.handle)
            .await
            .expect("poll should succeed")
            .status,
        VideoStatus::Running
    );

    let done = generator
        .poll(&submitted.handle)
        .await
        .expect("poll should succeed");
    assert_eq!(done.status, VideoStatus::Succeeded);
    let url = done.video_url.expect("succeed must carry a download url");

    let output = generator.fetch(&url).await.expect("fetch should succeed");
    assert_eq!(output.mime, "video/mp4");
    assert_eq!(output.bytes, mp4_bytes());

    let sent = bodies(&server, JIMENG_TASKS).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["model"], "doubao-seedance-1-0-pro-250528");
    let text = sent[0]["content"][0]["text"]
        .as_str()
        .expect("text item should be first");
    assert!(text.starts_with("女主推门而入"));
    assert!(text.contains("--duration 5"));
    assert!(text.contains("--ratio 9:16"));
}

/// 提交阶段的失败信息在顶层 `error` 里，要归一化成厂商错误。
#[tokio::test]
async fn jimeng_submit_error_is_surfaced() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(JIMENG_TASKS))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "error": { "code": "InvalidParameter", "message": "bad prompt" }
        })))
        .mount(&server)
        .await;

    let error = jimeng(&server).submit(&request()).await.unwrap_err();
    assert_eq!(error.code(), "provider");
    assert!(error.to_string().contains("InvalidParameter"));
}

/// 轮询遇到失败态时**不**返回 Err：`已失败` 这个状态本身要能被命令层看到。
#[tokio::test]
async fn jimeng_failed_task_keeps_its_error_message() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/contents/generations/tasks/task-fail"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "task-fail",
            "status": "failed",
            "error": { "code": "InternalError", "message": "生成失败" }
        })))
        .mount(&server)
        .await;

    let polled = jimeng(&server)
        .poll("task-fail")
        .await
        .expect("poll should succeed");
    assert_eq!(polled.status, VideoStatus::Failed);
    let error = polled.error.expect("failed task must carry an error");
    assert!(error.contains("InternalError"));
    assert!(error.contains("生成失败"));
}

/// 方舟的两套取消拼写都要认。
#[tokio::test]
async fn jimeng_canceled_status_is_normalized() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/contents/generations/tasks/task-stopped"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "id": "task-stopped", "status": "canceled" })),
        )
        .mount(&server)
        .await;

    let polled = jimeng(&server)
        .poll("task-stopped")
        .await
        .expect("poll should succeed");
    assert_eq!(polled.status, VideoStatus::Canceled);
}

/// 取消走 DELETE；任务已不存在（404）等价于取消成功。
#[tokio::test]
async fn jimeng_cancel_treats_missing_task_as_success() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/contents/generations/tasks/task-gone"))
        .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
        .mount(&server)
        .await;

    jimeng(&server)
        .cancel("task-gone")
        .await
        .expect("404 means already gone");
}

/// 取消成功（204）也不该被当成错误。
#[tokio::test]
async fn jimeng_cancel_succeeds_on_no_content() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/contents/generations/tasks/task-live"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    jimeng(&server)
        .cancel("task-live")
        .await
        .expect("204 should be a successful cancel");
}

/// 取消失败时不退避重试，直接把服务端错误抛给用户。
#[tokio::test]
async fn jimeng_cancel_surfaces_server_errors() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/contents/generations/tasks/task-boom"))
        .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
        .mount(&server)
        .await;

    let error = jimeng(&server).cancel("task-boom").await.unwrap_err();
    assert_eq!(error.code(), "provider");
    assert!(error.to_string().contains("500"));
}
