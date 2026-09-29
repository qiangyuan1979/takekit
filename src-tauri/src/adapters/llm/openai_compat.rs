//! OpenAI 兼容协议的 LLM 适配器（spec §9.3）。
//!
//! 用户填 `base_url + api_key + model` 即可对接豆包 / DeepSeek / 通义等；
//! 本文件是唯一知道 `/chat/completions` 与 SSE 报文格式的地方。

use super::{LlmChunk, LlmProvider, LlmRequest, LlmResponse, LlmStream, LlmUsage};
use crate::adapters::{classify_status, classify_transport, truncate};
use crate::error::{AppError, AppResult};
use futures_util::future::BoxFuture;
use futures_util::{stream, StreamExt};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

/// 适配器标识。
pub const NAME: &str = "openai-compat";

/// 最大尝试次数（含首次）。
const MAX_ATTEMPTS: u32 = 3;

/// 指数退避基数：400ms → 800ms。
const BASE_BACKOFF_MS: u64 = 400;

/// 建连超时；与整体超时分开，避免连不上时长时间干等。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// OpenAI 兼容 provider。
pub struct OpenAiCompatProvider {
    client: Client,
    endpoint: String,
    api_key: String,
    model: String,
    /// 非流式请求的整体超时；流式不设总超时以免长回答被拦腰截断。
    timeout: Duration,
}

impl OpenAiCompatProvider {
    /// 构造适配器；配置缺失在第一处就明确报错，而不是等到发请求。
    pub fn new(base_url: &str, api_key: &str, model: &str, timeout: Duration) -> AppResult<Self> {
        let base = base_url.trim();
        if base.is_empty() {
            return Err(AppError::Validation {
                field: "baseUrl".into(),
                detail: "LLM base URL is required".into(),
            });
        }
        let model = model.trim();
        if model.is_empty() {
            return Err(AppError::Validation {
                field: "model".into(),
                detail: "LLM model is required".into(),
            });
        }
        if api_key.trim().is_empty() {
            return Err(AppError::Auth("LLM API key is not configured".into()));
        }
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| AppError::Internal(format!("failed to build HTTP client: {e}")))?;

        Ok(Self {
            client,
            endpoint: format!("{}/chat/completions", base.trim_end_matches('/')),
            api_key: api_key.to_string(),
            model: model.to_string(),
            timeout,
        })
    }

    /// 组装请求体；`None` 的生成参数不下发，交给服务端默认值。
    fn build_body(&self, request: &LlmRequest, stream: bool) -> Value {
        let messages: Vec<Value> = request
            .messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect();
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": stream,
        });
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        body
    }

    /// 发一次对话请求，内建指数退避重试。
    ///
    /// 可重试：超时、连不上、429、5xx；鉴权/参数/内容类错误立即返回。
    async fn post_chat(&self, request: &LlmRequest, stream: bool) -> AppResult<reqwest::Response> {
        if request.messages.is_empty() {
            return Err(AppError::Validation {
                field: "messages".into(),
                detail: "at least one message is required".into(),
            });
        }
        let body = self.build_body(request, stream);
        let mut attempt = 0;

        loop {
            attempt += 1;
            let mut builder = self
                .client
                .post(&self.endpoint)
                .bearer_auth(&self.api_key)
                .json(&body);
            if !stream {
                builder = builder.timeout(self.timeout);
            }

            match builder.send().await {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status();
                    let retryable = status.as_u16() == 429 || status.is_server_error();
                    let text = response.text().await.unwrap_or_default();
                    let error = classify_status(NAME, status.as_u16(), &text);
                    if !retryable || attempt >= MAX_ATTEMPTS {
                        return Err(error);
                    }
                }
                Err(err) => {
                    let retryable = err.is_timeout() || err.is_connect() || err.is_request();
                    let error = classify_transport(NAME, &err);
                    if !retryable || attempt >= MAX_ATTEMPTS {
                        return Err(error);
                    }
                }
            }

            tokio::time::sleep(backoff(attempt)).await;
        }
    }
}

impl LlmProvider for OpenAiCompatProvider {
    fn name(&self) -> &'static str {
        NAME
    }

    fn complete<'a>(&'a self, request: &'a LlmRequest) -> BoxFuture<'a, AppResult<LlmResponse>> {
        Box::pin(async move {
            let response = self.post_chat(request, false).await?;
            let body = response
                .text()
                .await
                .map_err(|e| classify_transport(NAME, &e))?;
            parse_completion(&body)
        })
    }

    fn stream<'a>(&'a self, request: &'a LlmRequest) -> BoxFuture<'a, AppResult<LlmStream>> {
        Box::pin(async move {
            let response = self.post_chat(request, true).await?;
            Ok(sse_stream(response.bytes_stream()))
        })
    }
}

/// 指数退避：第 1 次失败后等 400ms，第 2 次后等 800ms。
fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(BASE_BACKOFF_MS * 2u64.pow(attempt.saturating_sub(1)))
}

/// 解析非流式响应体。
fn parse_completion(body: &str) -> AppResult<LlmResponse> {
    let value: Value = serde_json::from_str(body).map_err(|e| AppError::Provider {
        provider: NAME.into(),
        detail: format!("invalid JSON response: {}", truncate(&e.to_string(), 300)),
    })?;
    if let Some(error) = value.get("error") {
        return Err(AppError::Provider {
            provider: NAME.into(),
            detail: truncate(&error.to_string(), 300).to_string(),
        });
    }

    // 多数兼容服务走 message.content；少数只实现旧版 completions 的 text。
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/choices/0/text").and_then(Value::as_str))
        .ok_or_else(|| AppError::Provider {
            provider: NAME.into(),
            detail: "response contains no choices[0] content".into(),
        })?;

    let usage = value.get("usage").map(parse_usage).unwrap_or_default();
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&NAME)
        .to_string();

    Ok(LlmResponse {
        content: content.to_string(),
        model,
        usage,
    })
}

/// 解析 `usage`；缺失字段按 0 处理（成本估算归 M7，这里只透传）。
fn parse_usage(value: &Value) -> LlmUsage {
    let field = |name: &str| value.get(name).and_then(Value::as_u64).unwrap_or(0) as u32;
    LlmUsage {
        prompt_tokens: field("prompt_tokens"),
        completion_tokens: field("completion_tokens"),
        total_tokens: field("total_tokens"),
    }
}

/// 解析单条 SSE `data:` 负载，取出增量文本。
fn parse_delta(data: &str) -> AppResult<String> {
    let value: Value = serde_json::from_str(data).map_err(|e| AppError::Provider {
        provider: NAME.into(),
        detail: format!("invalid SSE chunk: {}", truncate(&e.to_string(), 300)),
    })?;
    if let Some(error) = value.get("error") {
        return Err(AppError::Provider {
            provider: NAME.into(),
            detail: truncate(&error.to_string(), 300).to_string(),
        });
    }
    Ok(value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

/// 把字节流按 SSE 行协议翻译成 `LlmChunk` 流。
///
/// 逐行缓冲：只认 `data:` 前缀，`[DONE]` 与流自然结束都会补一个 `done` 片段，
/// 保证前端不会一直等一个永远不来的终止信号。
fn sse_stream<S, B>(inner: S) -> LlmStream
where
    S: stream::Stream<Item = reqwest::Result<B>> + Send + 'static,
    // 用 `AsRef<[u8]>` 而不是 `bytes::Bytes`，免得为流式解析引入 bytes 依赖。
    B: AsRef<[u8]> + Send + 'static,
{
    struct State<S> {
        // Box::pin 让状态本身 Unpin，才能在 unfold 的循环里反复 `next()`。
        inner: std::pin::Pin<Box<S>>,
        buffer: Vec<u8>,
        finished: bool,
    }

    let state = State {
        inner: Box::pin(inner),
        buffer: Vec::new(),
        finished: false,
    };

    Box::pin(stream::unfold(state, |mut state| async move {
        loop {
            // 先尽量从缓冲区里取出一整行，行可能横跨多个字节块。
            if let Some(pos) = state.buffer.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = state.buffer.drain(..=pos).collect();
                line.pop(); // 去掉 '\n'
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                let text = String::from_utf8_lossy(&line);
                let Some(data) = text.trim().strip_prefix("data:") else {
                    continue; // 忽略 event: / id: / 注释行
                };
                let data = data.trim();
                if data == "[DONE]" {
                    state.finished = true;
                    return Some((Ok(chunk_done()), state));
                }
                match parse_delta(data) {
                    Ok(delta) if delta.is_empty() => continue,
                    Ok(delta) => return Some((Ok(LlmChunk { delta, done: false }), state)),
                    Err(error) => {
                        state.finished = true;
                        return Some((Err(error), state));
                    }
                }
            }

            if state.finished {
                return None;
            }

            match state.inner.next().await {
                Some(Ok(bytes)) => state.buffer.extend_from_slice(bytes.as_ref()),
                Some(Err(err)) => {
                    state.finished = true;
                    return Some((Err(classify_transport(NAME, &err)), state));
                }
                None => {
                    state.finished = true;
                    return Some((Ok(chunk_done()), state));
                }
            }
        }
    }))
}

fn chunk_done() -> LlmChunk {
    LlmChunk {
        delta: String::new(),
        done: true,
    }
}
