//! 集成测试：OpenAI 兼容 LLM 适配器（spec §9.3、§10）。
//!
//! 用 wiremock 起一个假的 OpenAI 服务，锁死四类行为：
//! 请求体/鉴权头的翻译、流式 SSE 解析、限流退避重试、错误归一化码。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use takekit_lib::adapters::llm::openai_compat::OpenAiCompatProvider;
use takekit_lib::adapters::llm::{LlmMessage, LlmProvider, LlmRequest};

const API_KEY: &str = "sk-test";
const MODEL: &str = "gpt-test";
const CHAT_PATH: &str = "/chat/completions";

fn provider(server: &MockServer, timeout: Duration) -> OpenAiCompatProvider {
    OpenAiCompatProvider::new(&server.uri(), API_KEY, MODEL, timeout)
        .expect("provider should build")
}

fn request() -> LlmRequest {
    LlmRequest {
        messages: vec![
            LlmMessage::system("你是编剧"),
            LlmMessage::user("写一句话故事"),
        ],
        temperature: Some(0.4),
        max_tokens: Some(128),
    }
}

fn completion_body() -> serde_json::Value {
    json!({
        "model": MODEL,
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": "雨夜，她认出了凶手。" } }],
        "usage": { "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20 }
    })
}

/// 非流式：请求体字段、鉴权头、返回值解析都要对得上。
#[tokio::test]
async fn complete_translates_request_and_parses_response() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(CHAT_PATH))
        .and(header("authorization", format!("Bearer {API_KEY}")))
        .and(body_json(json!({
            "model": MODEL,
            "stream": false,
            "temperature": 0.4,
            "max_tokens": 128,
            "messages": [
                { "role": "system", "content": "你是编剧" },
                { "role": "user", "content": "写一句话故事" },
            ],
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(completion_body()))
        .mount(&server)
        .await;

    let response = provider(&server, Duration::from_secs(5))
        .complete(&request())
        .await
        .expect("complete should succeed");

    assert_eq!(response.content, "雨夜，她认出了凶手。");
    assert_eq!(response.model, MODEL);
    assert_eq!(response.usage.total_tokens, 20);
}

/// 未下发 `temperature` / `maxTokens` 时，请求体里不应出现这两个键。
#[tokio::test]
async fn complete_omits_absent_generation_params() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(CHAT_PATH))
        .and(body_json(json!({
            "model": MODEL,
            "stream": false,
            "messages": [{ "role": "user", "content": "hi" }],
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(completion_body()))
        .mount(&server)
        .await;

    let bare = LlmRequest {
        messages: vec![LlmMessage::user("hi")],
        ..LlmRequest::default()
    };
    provider(&server, Duration::from_secs(5))
        .complete(&bare)
        .await
        .expect("complete should succeed");
}

/// 流式：多段 delta 拼接 + `[DONE]` 终止。
#[tokio::test]
async fn stream_concatenates_deltas_until_done() {
    let server = MockServer::start().await;
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"雨夜\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"，她认出了凶手。\"}}]}\n\n",
        "data: [DONE]\n\n",
    );
    Mock::given(method("POST"))
        .and(path(CHAT_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body, "text/event-stream"))
        .mount(&server)
        .await;

    let mut stream = provider(&server, Duration::from_secs(5))
        .stream(&request())
        .await
        .expect("stream should start");

    let mut text = String::new();
    let mut done = false;
    while let Some(item) = stream.next().await {
        let chunk = item.expect("chunk should be ok");
        text.push_str(&chunk.delta);
        if chunk.done {
            done = true;
            break;
        }
    }

    assert_eq!(text, "雨夜，她认出了凶手。");
    assert!(done, "流必须以 done 片段收尾");
}

/// 服务端不发 `[DONE]` 时，流自然结束也要补一个 done，否则前端会一直等。
#[tokio::test]
async fn stream_without_done_marker_still_terminates() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(CHAT_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
            "text/event-stream",
        ))
        .mount(&server)
        .await;

    let mut stream = provider(&server, Duration::from_secs(5))
        .stream(&request())
        .await
        .unwrap();

    let mut text = String::new();
    let mut done = false;
    while let Some(item) = stream.next().await {
        let chunk = item.unwrap();
        text.push_str(&chunk.delta);
        if chunk.done {
            done = true;
        }
    }

    assert_eq!(text, "ok");
    assert!(done);
}

/// 429 应退避重试，前两次失败后第三次成功。
#[tokio::test]
async fn rate_limit_is_retried_then_succeeds() {
    let server = MockServer::start().await;
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);

    Mock::given(method("POST"))
        .and(path(CHAT_PATH))
        .respond_with(move |_req: &wiremock::Request| {
            if counter.fetch_add(1, Ordering::SeqCst) < 2 {
                ResponseTemplate::new(429).set_body_string("slow down")
            } else {
                ResponseTemplate::new(200).set_body_json(completion_body())
            }
        })
        .mount(&server)
        .await;

    let response = provider(&server, Duration::from_secs(5))
        .complete(&request())
        .await
        .expect("third attempt should succeed");

    assert_eq!(response.content, "雨夜，她认出了凶手。");
    assert_eq!(hits.load(Ordering::SeqCst), 3, "应在两次 429 后才成功");
}

/// 一直限流时，重试次数用尽后返回 `rate_limit`。
#[tokio::test]
async fn persistent_rate_limit_reports_rate_limit() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(CHAT_PATH))
        .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
        .mount(&server)
        .await;

    let error = provider(&server, Duration::from_secs(5))
        .complete(&request())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "rate_limit");
}

/// 超时：整体超时应归一到 `timeout`。
#[tokio::test]
async fn timeout_is_reported_as_timeout() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(CHAT_PATH))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(1500)))
        .mount(&server)
        .await;

    let error = provider(&server, Duration::from_millis(150))
        .complete(&request())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "timeout");
}

/// 401 不重试，直接归一到 `auth`。
#[tokio::test]
async fn unauthorized_is_reported_as_auth() {
    let server = MockServer::start().await;
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);

    Mock::given(method("POST"))
        .and(path(CHAT_PATH))
        .respond_with(move |_req: &wiremock::Request| {
            counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(401).set_body_string("invalid api key")
        })
        .mount(&server)
        .await;

    let error = provider(&server, Duration::from_secs(5))
        .complete(&request())
        .await
        .unwrap_err();

    assert_eq!(error.code(), "auth");
    assert_eq!(hits.load(Ordering::SeqCst), 1, "鉴权失败不应重试");
}

/// 200 但不是合法 JSON，报 `provider` 而不是 panic。
#[tokio::test]
async fn malformed_json_body_is_reported_as_provider() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(CHAT_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_raw("<html>oops</html>", "text/html"))
        .mount(&server)
        .await;

    let error = provider(&server, Duration::from_secs(5))
        .complete(&request())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "provider");
}

/// 空消息列表在发请求前就被拦下。
#[tokio::test]
async fn empty_messages_is_rejected_without_request() {
    let server = MockServer::start().await;
    let error = provider(&server, Duration::from_secs(5))
        .complete(&LlmRequest::default())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "validation");
    assert!(server.received_requests().await.unwrap().is_empty());
}

/// 配置缺失在第一处就报错，而不是发一个注定失败的请求。
#[test]
fn misconfigured_provider_fails_fast() {
    let blank_base = OpenAiCompatProvider::new("  ", API_KEY, MODEL, Duration::from_secs(5))
        .err()
        .expect("empty base url must fail");
    assert_eq!(blank_base.code(), "validation");

    let blank_model =
        OpenAiCompatProvider::new("http://localhost:1", API_KEY, "", Duration::from_secs(5))
            .err()
            .expect("empty model must fail");
    assert_eq!(blank_model.code(), "validation");

    let blank_key =
        OpenAiCompatProvider::new("http://localhost:1", "", MODEL, Duration::from_secs(5))
            .err()
            .expect("empty api key must fail");
    assert_eq!(blank_key.code(), "auth");
}
