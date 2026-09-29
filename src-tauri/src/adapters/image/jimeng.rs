//! 火山方舟即梦（Ark）图片适配器（spec §9.3、§9.4）。
//!
//! 用户填 `base_url + api_key + model` 即可对接即梦文生图；
//! 本文件是唯一知道 `/images/generations` 报文格式的地方。
//!
//! 即梦不支持负向提示词：这里**故意不下发**该字段，是"厂商差异由适配器降级"的落点之一
//! （出题层照常产出统一模型，永远不需要知道谁支持什么）。

use super::{ImageOutput, ImageProvider, ImageRequest, DEFAULT_COUNT, DEFAULT_SIZE};
use crate::adapters::{classify_status, classify_transport, truncate};
use crate::error::{AppError, AppResult};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use futures_util::future::BoxFuture;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

/// 适配器标识。
pub const NAME: &str = "jimeng";

/// 最大尝试次数（含首次）。
const MAX_ATTEMPTS: u32 = 3;

/// 指数退避基数：400ms → 800ms。
const BASE_BACKOFF_MS: u64 = 400;

/// 建连超时；与整体超时分开，避免连不上时长时间干等。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 即梦单次生成的候选张数上限。
const MAX_COUNT: u32 = 4;

/// 即梦 provider。
pub struct JimengProvider {
    client: Client,
    endpoint: String,
    api_key: String,
    model: String,
    /// 出图比对话慢得多，整体超时由命令层给足。
    timeout: Duration,
}

impl JimengProvider {
    /// 构造适配器；配置缺失在第一处就明确报错，而不是等到发请求。
    pub fn new(base_url: &str, api_key: &str, model: &str, timeout: Duration) -> AppResult<Self> {
        let base = base_url.trim();
        if base.is_empty() {
            return Err(AppError::Validation {
                field: "baseUrl".into(),
                detail: "image base URL is required".into(),
            });
        }
        let model = model.trim();
        if model.is_empty() {
            return Err(AppError::Validation {
                field: "model".into(),
                detail: "image model is required".into(),
            });
        }
        if api_key.trim().is_empty() {
            return Err(AppError::Auth("image API key is not configured".into()));
        }
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| AppError::Internal(format!("failed to build HTTP client: {e}")))?;

        Ok(Self {
            client,
            endpoint: format!("{}/images/generations", base.trim_end_matches('/')),
            api_key: api_key.to_string(),
            model: model.to_string(),
            timeout,
        })
    }

    /// 组装请求体。
    ///
    /// - `negative_prompt` 不下发（即梦无此字段，降级由适配器负责）。
    /// - 参考图只取首张，走厂商原生图生图能力（spec §13.2 #4）。
    /// - 统一要求返回 `url`：把二进制塞进 JSON 会撑爆响应体。
    fn build_body(&self, request: &ImageRequest) -> Value {
        let width = if request.width == 0 {
            DEFAULT_SIZE
        } else {
            request.width
        };
        let height = if request.height == 0 {
            DEFAULT_SIZE
        } else {
            request.height
        };
        let count = match request.count {
            0 => DEFAULT_COUNT,
            n => n.clamp(1, MAX_COUNT),
        };

        let mut body = json!({
            "model": self.model,
            "prompt": request.prompt,
            "size": format!("{width}x{height}"),
            "n": count,
            "response_format": "url",
            "watermark": false,
        });
        if let Some(seed) = request.seed {
            body["seed"] = json!(seed);
        }
        if let Some(image) = request.ref_images.first() {
            body["image"] = json!(image);
        }
        body
    }

    /// 发一次生成请求，内建指数退避重试。
    ///
    /// 可重试：超时、连不上、429、5xx；鉴权/参数/内容类错误立即返回。
    async fn post_generate(&self, request: &ImageRequest) -> AppResult<reqwest::Response> {
        if request.prompt.trim().is_empty() {
            return Err(AppError::Validation {
                field: "prompt".into(),
                detail: "prompt must not be empty".into(),
            });
        }
        let body = self.build_body(request);
        let mut attempt = 0;

        loop {
            attempt += 1;
            match self
                .client
                .post(&self.endpoint)
                .bearer_auth(&self.api_key)
                .timeout(self.timeout)
                .json(&body)
                .send()
                .await
            {
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

    /// 把一条 `data[i]` 变成字节：优先内联的 `b64_json`，否则下载 `url`。
    async fn materialize(&self, item: &Value) -> AppResult<ImageOutput> {
        if let Some(encoded) = item.get("b64_json").and_then(Value::as_str) {
            let bytes = BASE64.decode(encoded).map_err(|e| AppError::Provider {
                provider: NAME.into(),
                detail: format!("invalid base64 image: {e}"),
            })?;
            return Ok(ImageOutput {
                mime: sniff_mime(&bytes).unwrap_or("image/png").to_string(),
                bytes,
            });
        }

        let url = item
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Provider {
                provider: NAME.into(),
                detail: "image entry has neither b64_json nor url".into(),
            })?;

        let response = self
            .client
            .get(url)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| classify_transport(NAME, &e))?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(classify_status(NAME, status.as_u16(), &text));
        }

        // content-type 可能带 charset 等参数，也可能压根没有——两者都要能兜底。
        let declared = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
            .filter(|value| value.starts_with("image/"));

        let bytes = response
            .bytes()
            .await
            .map_err(|e| classify_transport(NAME, &e))?
            .to_vec();
        let mime = declared
            .or_else(|| sniff_mime(&bytes).map(str::to_string))
            .unwrap_or_else(|| "image/png".to_string());
        Ok(ImageOutput { bytes, mime })
    }
}

impl ImageProvider for JimengProvider {
    fn name(&self) -> &'static str {
        NAME
    }

    fn generate<'a>(
        &'a self,
        request: &'a ImageRequest,
    ) -> BoxFuture<'a, AppResult<Vec<ImageOutput>>> {
        Box::pin(async move {
            let response = self.post_generate(request).await?;
            let body = response
                .text()
                .await
                .map_err(|e| classify_transport(NAME, &e))?;
            let items = parse_items(&body)?;

            let mut outputs = Vec::with_capacity(items.len());
            for item in &items {
                outputs.push(self.materialize(item).await?);
            }
            if outputs.is_empty() {
                return Err(AppError::Provider {
                    provider: NAME.into(),
                    detail: "provider returned no images".into(),
                });
            }
            Ok(outputs)
        })
    }
}

/// 指数退避：第 1 次失败后等 400ms，第 2 次后等 800ms。
fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(BASE_BACKOFF_MS * 2u64.pow(attempt.saturating_sub(1)))
}

/// 解析生成响应，取出 `data[]`。
fn parse_items(body: &str) -> AppResult<Vec<Value>> {
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
    Ok(value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// 从文件头识别图片类型；识别不出返回 `None`（由调用方兜底 png）。
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
