//! 本地模拟语音适配器（M9）：没有 API Key 也能把「配音」这一步走完。
//!
//! 它不联网、不读磁盘，只按请求文本现算一段 16-bit 单声道 PCM WAV 交差：
//! 频率取自文本哈希（220–495Hz），带 10ms 淡入淡出避免起止爆音。
//! 时长用与真机一致的 [`estimate_duration_ms`] 估算，保证字幕与时间线自洽。
//!
//! 产物是**真正可播放的 WAV**而非假字节，这是与视频模拟器（画 PNG 占位图）
//! 同一取向的诚实妥协：编一段非法音频只会让播放器报错。
//!
//! 提示词含 `#fail` 时返回合成失败，用于演示失败重试分支。

use super::{estimate_duration_ms, AudioOutput, TtsCredentials, TtsGenerator, TtsRequest};
use crate::error::{AppError, AppResult};
use futures_util::future::BoxFuture;

/// 适配器标识。
pub const NAME: &str = "mock";

/// 采样率；16kHz 足够听清且体积小。
const SAMPLE_RATE: u32 = 16_000;

/// 提示词含该标记时演示失败分支。
const FAIL_MARKER: &str = "#fail";

/// 淡入淡出时长（毫秒），避免起止"咔哒"声。
const FADE_MS: u32 = 10;

/// 本地模拟语音生成器。
pub struct MockTtsGenerator;

impl MockTtsGenerator {
    /// 接入配置对模拟器无意义（免 Key 可用），签名保持与真机适配器一致。
    pub fn new(_credentials: &TtsCredentials) -> Self {
        Self
    }
}

impl TtsGenerator for MockTtsGenerator {
    fn name(&self) -> &'static str {
        NAME
    }

    fn synthesize<'a>(&'a self, request: &'a TtsRequest) -> BoxFuture<'a, AppResult<AudioOutput>> {
        Box::pin(async move {
            if request.text.contains(FAIL_MARKER) {
                return Err(AppError::Provider {
                    provider: NAME.into(),
                    detail: "模拟：语音合成失败，请重试。".into(),
                });
            }
            let duration_ms = estimate_duration_ms(&request.text, request.speed);
            let bytes = encode_wav(&request.text, duration_ms)?;
            Ok(AudioOutput {
                bytes,
                mime: "audio/wav".into(),
                duration_ms,
            })
        })
    }
}

/// 生成一段时长自洽的正弦波 WAV。
fn encode_wav(text: &str, duration_ms: u64) -> AppResult<Vec<u8>> {
    let sample_count = ((SAMPLE_RATE as u64 * duration_ms) / 1000).max(1) as usize;
    let freq = tone_hz(text);
    let fade = ((SAMPLE_RATE as u64 * FADE_MS as u64) / 1000).max(1) as usize;

    let mut samples = Vec::with_capacity(sample_count);
    for i in 0..sample_count {
        let t = i as f32 / SAMPLE_RATE as f32;
        let raw = (2.0 * std::f32::consts::PI * freq * t).sin();
        // 首尾各做一段线性淡入淡出。
        let gain = if i < fade {
            i as f32 / fade as f32
        } else if i + fade >= sample_count {
            (sample_count - i) as f32 / fade as f32
        } else {
            1.0
        };
        samples.push((raw * gain * 0.25 * i16::MAX as f32) as i16);
    }

    let data_len = samples.len() * 2;
    let mut bytes = Vec::with_capacity(44 + data_len);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // 字节率
    bytes.extend_from_slice(&2u16.to_le_bytes()); // 块对齐
    bytes.extend_from_slice(&16u16.to_le_bytes()); // 位深
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(bytes)
}

/// 按文本哈希取一个听起来不刺耳的基频（220–495Hz）。
fn tone_hz(text: &str) -> f32 {
    let hash = text.bytes().fold(0u32, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(byte as u32)
    });
    220.0 + (hash % 276) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn credentials() -> TtsCredentials {
        TtsCredentials {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            timeout: Duration::from_secs(5),
        }
    }

    fn request(text: &str) -> TtsRequest {
        TtsRequest {
            text: text.into(),
            voice: "alloy".into(),
            emotion: String::new(),
            speed: 1.0,
        }
    }

    #[tokio::test]
    async fn synthesizes_playable_wav() {
        let generator = MockTtsGenerator::new(&credentials());
        let output = generator
            .synthesize(&request("你好，世界。"))
            .await
            .unwrap();

        assert_eq!(output.mime, "audio/wav");
        assert!(output.bytes.starts_with(b"RIFF"));
        assert_eq!(&output.bytes[8..12], b"WAVE");
        assert_eq!(
            output.bytes.len(),
            44 + (output.duration_ms as usize) * SAMPLE_RATE as usize / 1000 * 2
        );
    }

    #[tokio::test]
    async fn wav_header_is_sniffed_by_parent_helper() {
        let generator = MockTtsGenerator::new(&credentials());
        let output = generator.synthesize(&request("旁白一句话")).await.unwrap();
        assert_eq!(
            super::super::sniff_audio_mime(&output.bytes),
            Some("audio/wav")
        );
    }

    #[tokio::test]
    async fn fail_marker_turns_into_provider_error() {
        let generator = MockTtsGenerator::new(&credentials());
        let error = generator
            .synthesize(&request("台词 #fail"))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code(), "provider");
    }

    #[tokio::test]
    async fn duration_matches_estimate() {
        let generator = MockTtsGenerator::new(&credentials());
        let text = "这是一句用来验证时长估算的台词";
        let output = generator.synthesize(&request(text)).await.unwrap();
        assert_eq!(output.duration_ms, estimate_duration_ms(text, 1.0));
    }
}
