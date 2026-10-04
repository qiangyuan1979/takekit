//! OpenAI 兼容协议的语音合成适配器（spec §5.8.1）。
//!
//! 用户填 `base_url + api_key + model` 即可对接 OpenAI / 豆包 / 通义等
//! 提供 `/audio/speech` 的服务；本文件是唯一知道该报文格式的地方。

use super::{
    build_client, estimate_duration_ms, non_empty, normalize_content_type, send_with_retry,
    sniff_audio_mime, AudioOutput, TtsCredentials, TtsGenerator, TtsRequest,
};
use crate::error::{AppError, AppResult};
use futures_util::future::BoxFuture;
use reqwest::Client;
use serde_json::json;
use std::time::Duration;

/// 适配器标识。
pub const NAME: &str = "openai";

/// 未填 model 时的兜底模型。
pub const DEFAULT_MODEL: &str = "tts-1";

/// 未填音色时的兜底音色。
pub const DEFAULT_VOICE: &str = "alloy";

/// OpenAI 兼容语音合成 provider。
pub struct OpenAiTtsGenerator {
    client: Client,
    endpoint: String,
    api_key: String,
    model: String,
    timeout: Duration,
}

impl OpenAiTtsGenerator {
    /// 构造适配器；配置缺失在第一处就明确报错，而不是等到发请求。
    pub fn new(credentials: &TtsCredentials) -> AppResult<Self> {
        let base = credentials.base_url.trim();
        if base.is_empty() {
            return Err(AppError::Validation {
                field: "baseUrl".into(),
                detail: "TTS base URL is required".into(),
            });
        }
        if credentials.api_key.trim().is_empty() {
            return Err(AppError::Auth("TTS API key is not configured".into()));
        }
        let model =
            non_empty(&Some(credentials.model.clone())).unwrap_or_else(|| DEFAULT_MODEL.into());

        Ok(Self {
            client: build_client()?,
            endpoint: format!("{}/audio/speech", base.trim_end_matches('/')),
            api_key: credentials.api_key.clone(),
            model,
            timeout: credentials.timeout,
        })
    }

    /// 组装请求体。
    fn build_body(&self, request: &TtsRequest) -> serde_json::Value {
        let voice = non_empty(&Some(request.voice.clone())).unwrap_or_else(|| DEFAULT_VOICE.into());
        let mut body = json!({
            "model": self.model,
            "input": request.text,
            "voice": voice,
            "speed": super::clamp_speed(request.speed),
            "response_format": "mp3",
        });
        // 情绪是可选能力，多数 OpenAI 兼容服务不认这个字段，留空则不下发。
        if let Some(emotion) = non_empty(&Some(request.emotion.clone())) {
            body["emotion"] = json!(emotion);
        }
        body
    }
}

impl TtsGenerator for OpenAiTtsGenerator {
    fn name(&self) -> &'static str {
        NAME
    }

    fn synthesize<'a>(&'a self, request: &'a TtsRequest) -> BoxFuture<'a, AppResult<AudioOutput>> {
        Box::pin(async move {
            if request.text.trim().is_empty() {
                return Err(AppError::Validation {
                    field: "text".into(),
                    detail: "speech text is required".into(),
                });
            }
            let body = self.build_body(request);
            let response = send_with_retry(NAME, || {
                self.client
                    .post(&self.endpoint)
                    .bearer_auth(&self.api_key)
                    .timeout(self.timeout)
                    .json(&body)
            })
            .await?;

            // 先看响应头，再看文件头，最后按请求的 mp3 兜底。
            let header_mime = normalize_content_type(
                response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok()),
            );
            let bytes = response
                .bytes()
                .await
                .map_err(|e| crate::adapters::classify_transport(NAME, &e))?
                .to_vec();
            if bytes.is_empty() {
                return Err(AppError::Provider {
                    provider: NAME.into(),
                    detail: "empty audio response".into(),
                });
            }
            let mime = header_mime
                .or_else(|| sniff_audio_mime(&bytes).map(str::to_string))
                .unwrap_or_else(|| "audio/mpeg".into());

            Ok(AudioOutput {
                bytes,
                mime,
                duration_ms: estimate_duration_ms(&request.text, request.speed),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials(base_url: &str, api_key: &str, model: &str) -> TtsCredentials {
        TtsCredentials {
            base_url: base_url.into(),
            api_key: api_key.into(),
            model: model.into(),
            timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn empty_base_url_is_rejected() {
        let error = OpenAiTtsGenerator::new(&credentials("  ", "sk-x", "tts-1"))
            .err()
            .unwrap();
        assert_eq!(error.code(), "validation");
    }

    #[test]
    fn empty_api_key_is_rejected() {
        let error = OpenAiTtsGenerator::new(&credentials("https://api.example.com", "", "tts-1"))
            .err()
            .unwrap();
        assert_eq!(error.code(), "auth");
    }

    #[test]
    fn model_falls_back_to_default_and_endpoint_is_joined() {
        let generator =
            OpenAiTtsGenerator::new(&credentials("https://api.example.com/", "sk-x", "  "))
                .unwrap();
        assert_eq!(generator.model, DEFAULT_MODEL);
        assert_eq!(generator.endpoint, "https://api.example.com/audio/speech");
    }

    #[test]
    fn voice_falls_back_to_default_in_body() {
        let generator =
            OpenAiTtsGenerator::new(&credentials("https://api.example.com", "sk-x", "tts-1"))
                .unwrap();
        let body = generator.build_body(&TtsRequest {
            text: "你好".into(),
            voice: String::new(),
            emotion: String::new(),
            speed: 1.0,
        });
        assert_eq!(body["voice"], DEFAULT_VOICE);
        assert!(body.get("emotion").is_none());
    }

    #[tokio::test]
    async fn blank_text_is_rejected() {
        let generator =
            OpenAiTtsGenerator::new(&credentials("https://api.example.com", "sk-x", "tts-1"))
                .unwrap();
        let error = generator
            .synthesize(&TtsRequest {
                text: "   ".into(),
                voice: "alloy".into(),
                emotion: String::new(),
                speed: 1.0,
            })
            .await
            .err()
            .unwrap();
        assert_eq!(error.code(), "validation");
    }
}
