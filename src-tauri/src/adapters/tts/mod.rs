//! 语音合成适配器契约（spec §5.8.1）：把"一句台词 / 旁白"翻译成可合成的请求。
//!
//! 与视频适配器的差异：TTS 是**一段式**（一次请求直接拿回音频字节），
//! 因此契约只有一个 [`TtsGenerator::synthesize`]，没有提交 / 轮询 / 取回三步。
//!
//! 每家适配器是唯一知道自家报文格式的地方（音色取值域、情绪字段、语速表达），
//! 命令层永远只产出 [`TtsRequest`]。

pub mod mock;
pub mod openai;

use crate::adapters::{classify_status, classify_transport};
use crate::error::{AppError, AppResult};
use futures_util::future::BoxFuture;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 未指定语速时的兜底倍率。
pub const DEFAULT_SPEED: f32 = 1.0;

/// 语速的合法区间；越界一律收敛到边界（各厂商支持范围更窄时在适配器内再收敛）。
pub const MIN_SPEED: f32 = 0.5;
pub const MAX_SPEED: f32 = 2.0;

/// 估算时长用的中文语速基准（字/秒，正常语速）。
const CHARS_PER_SECOND: f32 = 4.0;

/// 统一的语音合成请求：一句台词或旁白。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TtsRequest {
    /// 待合成文本（一句）。
    pub text: String,
    /// 音色（取自角色卡「音色」字段；旁白取立项卡默认音色）。
    pub voice: String,
    /// 情绪标注（可空，如"平静 / 激动"）。
    pub emotion: String,
    /// 语速倍率。
    pub speed: f32,
}

/// 合成产物。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioOutput {
    pub bytes: Vec<u8>,
    pub mime: String,
    /// 音频时长（毫秒）。模拟器为精确值，真机按文本长度估算（字幕可逐句微调）。
    pub duration_ms: u64,
}

/// 建生成器所需的接入配置（api_key 只在这一处流入内存）。
#[derive(Debug, Clone)]
pub struct TtsCredentials {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub timeout: Duration,
}

/// 语音合成器契约：适配器**不碰文件系统**，只把字节交回命令层。
pub trait TtsGenerator: Send + Sync {
    /// 适配器标识，用于错误信息与任务归属。
    fn name(&self) -> &'static str;

    /// 合成一段语音。
    fn synthesize<'a>(&'a self, request: &'a TtsRequest) -> BoxFuture<'a, AppResult<AudioOutput>>;
}

/// 已支持的**真机** provider 标识，供前端下拉与校验共用。
pub const SUPPORTED: [&str; 1] = [openai::NAME];

/// 可用于**生成**的 provider：比 [`SUPPORTED`] 多一个本地模拟器，无 Key 也能跑通全流程。
pub const GENERATORS: [&str; 2] = [openai::NAME, mock::NAME];

/// 按 provider 名构造生成器；未知 provider 返回 `Validation`，由命令层转成用户可见提示。
pub fn generator(name: &str, credentials: &TtsCredentials) -> AppResult<Box<dyn TtsGenerator>> {
    match name.trim() {
        openai::NAME => Ok(Box::new(openai::OpenAiTtsGenerator::new(credentials)?)),
        mock::NAME => Ok(Box::new(mock::MockTtsGenerator::new(credentials))),
        other => Err(AppError::Validation {
            field: "provider".into(),
            detail: format!("tts provider `{other}` is not supported"),
        }),
    }
}

/// 把语速收敛到合法区间；非有限值（NaN）按默认值处理。
pub(crate) fn clamp_speed(speed: f32) -> f32 {
    if !speed.is_finite() || speed <= 0.0 {
        return DEFAULT_SPEED;
    }
    speed.clamp(MIN_SPEED, MAX_SPEED)
}

/// 按文本长度估算音频时长（毫秒）：中文按 [`CHARS_PER_SECOND`] 字/秒折算，再除以语速。
///
/// 真机不返回时长，这里给出**可预期**的估算值供字幕与时间线对齐；
/// 与视频 mock 产出占位图一样，这是有意的诚实妥协（字幕支持逐句微调）。
pub(crate) fn estimate_duration_ms(text: &str, speed: f32) -> u64 {
    let chars = text.chars().filter(|c| !c.is_whitespace()).count() as f32;
    let speed = clamp_speed(speed);
    let seconds = chars / (CHARS_PER_SECOND * speed);
    (seconds * 1000.0).round().max(200.0) as u64
}

// ---------- 共用 HTTP 助手 ----------

/// 建连超时；与整体超时分开，避免连不上时长时间干等。
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 最大尝试次数（含首次）。
pub(crate) const MAX_ATTEMPTS: u32 = 3;

/// 指数退避基数：400ms → 800ms。
const BASE_BACKOFF_MS: u64 = 400;

/// 建 HTTP 客户端；各适配器的客户端配置保持一致。
pub(crate) fn build_client() -> AppResult<Client> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| AppError::Internal(format!("failed to build HTTP client: {e}")))
}

/// 发送请求并内建指数退避：可重试 429/5xx 与超时/连接类传输错误。
///
/// 传入闭包而非 `RequestBuilder` 本身，是因为重试需要重建请求（builder 消费即失效）。
pub(crate) async fn send_with_retry(
    provider: &str,
    build: impl Fn() -> reqwest::RequestBuilder,
) -> AppResult<reqwest::Response> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match build().send().await {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let status = response.status();
                let retryable = status.as_u16() == 429 || status.is_server_error();
                let text = response.text().await.unwrap_or_default();
                let error = classify_status(provider, status.as_u16(), &text);
                if !retryable || attempt >= MAX_ATTEMPTS {
                    return Err(error);
                }
            }
            Err(err) => {
                let retryable = err.is_timeout() || err.is_connect() || err.is_request();
                let error = classify_transport(provider, &err);
                if !retryable || attempt >= MAX_ATTEMPTS {
                    return Err(error);
                }
            }
        }
        tokio::time::sleep(backoff(attempt)).await;
    }
}

/// 指数退避：第 1 次失败后等 400ms，第 2 次后等 800ms。
fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(BASE_BACKOFF_MS * 2u64.pow(attempt.saturating_sub(1)))
}

/// 归一化 content-type：去掉 `;charset=` 之类的参数，仅接受 `audio/`。
pub(crate) fn normalize_content_type(raw: Option<&str>) -> Option<String> {
    let value = raw?.split(';').next()?.trim().to_ascii_lowercase();
    if value.starts_with("audio/") {
        Some(value)
    } else {
        None
    }
}

/// 从文件头识别音频容器；识别不出返回 `None`（由调用方兜底）。
pub(crate) fn sniff_audio_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return Some("audio/wav");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some("audio/mp4");
    }
    if bytes.starts_with(b"fLaC") {
        return Some("audio/flac");
    }
    if bytes.starts_with(b"OggS") {
        return Some("audio/ogg");
    }
    if bytes.starts_with(b"ID3") {
        return Some("audio/mpeg");
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0 {
        return Some("audio/mpeg");
    }
    None
}

/// 去掉 `Option<String>` 两端的空白；空串视同不存在。
pub(crate) fn non_empty(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> TtsCredentials {
        TtsCredentials {
            base_url: "https://api.example.com".into(),
            api_key: "sk-test".into(),
            model: "tts-1".into(),
            timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn generator_registry_covers_all_names_and_rejects_unknown() {
        for name in GENERATORS {
            assert!(generator(name, &credentials()).is_ok(), "{name} 未注册");
        }
        assert!(generator("  mock  ", &credentials()).is_ok());
        assert_eq!(
            generator("mystery", &credentials()).err().unwrap().code(),
            "validation"
        );
    }

    #[test]
    fn supported_covers_real_providers() {
        for name in SUPPORTED {
            assert!(GENERATORS.contains(&name), "{name} 必须在 GENERATORS 中");
        }
    }

    #[test]
    fn speed_is_clamped_to_documented_range() {
        assert_eq!(clamp_speed(1.0), 1.0);
        assert_eq!(clamp_speed(0.1), MIN_SPEED);
        assert_eq!(clamp_speed(9.0), MAX_SPEED);
        assert_eq!(clamp_speed(f32::NAN), DEFAULT_SPEED);
        assert_eq!(clamp_speed(0.0), DEFAULT_SPEED);
    }

    #[test]
    fn duration_estimate_scales_with_text_and_speed() {
        let short = estimate_duration_ms("你好", 1.0);
        let long = estimate_duration_ms("你好，我今天真的很不高兴。", 1.0);
        assert!(long > short);
        // 语速翻倍 → 时长减半。
        assert!(
            estimate_duration_ms("你好你好你好你好", 2.0)
                < estimate_duration_ms("你好你好你好你好", 1.0)
        );
        // 空文本也有下限，避免 0 时长。
        assert_eq!(estimate_duration_ms("", 1.0), 200);
    }

    #[test]
    fn audio_mime_is_sniffed_from_headers() {
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&[0u8; 4]);
        wav.extend_from_slice(b"WAVE");
        assert_eq!(sniff_audio_mime(&wav), Some("audio/wav"));
        assert_eq!(sniff_audio_mime(b"ID3\x04\x00\x00"), Some("audio/mpeg"));
        assert_eq!(
            sniff_audio_mime(b"fLaC\x00\x00\x00\x22"),
            Some("audio/flac")
        );
        assert_eq!(sniff_audio_mime(b"OggS\x00\x02"), Some("audio/ogg"));
        assert_eq!(
            sniff_audio_mime(&[0xFF, 0xFB, 0x90, 0x00]),
            Some("audio/mpeg")
        );
        assert_eq!(sniff_audio_mime(&[0x00, 0x01, 0x02]), None);
    }

    #[test]
    fn content_type_is_normalized_and_filtered() {
        assert_eq!(
            normalize_content_type(Some("audio/mpeg")),
            Some("audio/mpeg".into())
        );
        assert_eq!(
            normalize_content_type(Some("Audio/WAV; charset=utf-8")),
            Some("audio/wav".into())
        );
        assert_eq!(normalize_content_type(Some("text/html")), None);
        assert_eq!(normalize_content_type(None), None);
    }

    #[test]
    fn non_empty_trims_and_treats_blank_as_absent() {
        assert_eq!(non_empty(&Some("  x ".into())), Some("x".into()));
        assert_eq!(non_empty(&Some("   ".into())), None);
        assert_eq!(non_empty(&None), None);
    }
}
