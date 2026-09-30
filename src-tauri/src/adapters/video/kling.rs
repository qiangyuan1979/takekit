//! 可灵（Kling）视频适配器（spec §9.4）。
//!
//! 官方 `text2video` / `image2video` 报文的关键字段：
//! `model_name / prompt / negative_prompt / mode / duration / aspect_ratio /
//! image（首帧）/ image_tail（尾帧）`。可灵的取值域收得很紧，因此本文件是
//! "降级提示"最集中的落点：
//!
//! - 时长只接受 `"5"` / `"10"`（秒）→ 其余时长就近取整并提示；
//! - 分辨率不是独立字段，只有 `mode = std(720p) / pro(1080p)`；
//! - 不支持帧率、运动强度、固定种子、参考图权重 → 忽略并逐条提示。
//!
//! 本文件只做翻译（M6）；真正的 HTTP 调用在 M7 加。

use super::{
    non_empty, truncate_prompt, Translated, VideoProvider, VideoRequest, DEFAULT_DURATION_MS,
    DEFAULT_MOTION_STRENGTH,
};
use crate::project::VideoParams;
use serde_json::json;

/// 适配器标识。
pub const NAME: &str = "kling";

/// 默认模型版本。
pub const DEFAULT_MODEL: &str = "kling-v1";

/// 可灵提示词长度上限（字符）。
const MAX_PROMPT_CHARS: usize = 2_500;

/// 可灵支持的时长档位（秒）。
const DURATIONS_S: [u64; 2] = [5, 10];

/// 可灵 provider。
pub struct KlingProvider {
    model: String,
}

impl KlingProvider {
    /// `model` 为空时落到 [`DEFAULT_MODEL`]。
    pub fn new(model: &str) -> Self {
        let model = model.trim();
        Self {
            model: if model.is_empty() {
                DEFAULT_MODEL.into()
            } else {
                model.into()
            },
        }
    }
}

impl Default for KlingProvider {
    fn default() -> Self {
        Self::new("")
    }
}

impl VideoProvider for KlingProvider {
    fn name(&self) -> &'static str {
        NAME
    }

    fn translate(&self, request: &VideoRequest) -> Translated {
        let params = &request.params;
        let mut notes = Vec::new();

        let (prompt, mut prompt_notes) =
            truncate_prompt(&request.prompt, MAX_PROMPT_CHARS, "提示词");
        notes.append(&mut prompt_notes);

        let mut body = json!({
            "model_name": self.model,
            "prompt": prompt,
            "aspect_ratio": params.aspect_ratio.as_str(),
            "mode": mode_for(&params.resolution, &mut notes),
        });

        // 负向提示词：可灵支持，但空串会被判为非法参数，索性省略。
        let (negative, mut negative_notes) = truncate_prompt(
            params.negative_prompt.trim(),
            MAX_PROMPT_CHARS,
            "负向提示词",
        );
        if !negative.is_empty() {
            body["negative_prompt"] = json!(negative);
            notes.append(&mut negative_notes);
        }

        // 时长：就近收敛到 5 / 10 秒。
        let requested_ms = if params.duration_ms == 0 {
            DEFAULT_DURATION_MS
        } else {
            params.duration_ms
        };
        let (seconds, adjusted) = nearest_duration(requested_ms);
        body["duration"] = json!(seconds.to_string());
        if adjusted && params.duration_ms != 0 {
            notes.push(format!(
                "可灵只支持 5 秒 / 10 秒，已把 {:.1} 秒调整为 {} 秒。",
                params.duration_ms as f64 / 1000.0,
                seconds
            ));
        }

        // 首帧 / 尾帧：可灵原生的图生视频入口。
        if let Some(first) = non_empty(&params.first_frame) {
            body["image"] = json!(first);
        }
        if let Some(last) = non_empty(&params.last_frame) {
            body["image_tail"] = json!(last);
        }

        notes.extend(dropped_params(params));

        Translated {
            provider: NAME.into(),
            body,
            notes,
        }
    }
}

/// 就近取整到 5 / 10 秒；返回（秒, 是否发生了调整）。
fn nearest_duration(ms: u64) -> (u64, bool) {
    let seconds = (ms as f64 / 1000.0).round() as i64;
    let mut best = DURATIONS_S[0];
    let mut best_diff = i64::MAX;
    for candidate in DURATIONS_S {
        let diff = (seconds - candidate as i64).abs();
        if diff < best_diff {
            best_diff = diff;
            best = candidate;
        }
    }
    (best, best_diff != 0)
}

/// 分辨率 → 可灵的 `mode`；无法识别时按 std 处理并提示。
fn mode_for(resolution: &str, notes: &mut Vec<String>) -> &'static str {
    let resolution = resolution.trim();
    if resolution.is_empty() || resolution.contains("1080") {
        return "pro";
    }
    if resolution.contains("720") {
        return "std";
    }
    notes.push(format!(
        "分辨率「{resolution}」无法映射到可灵的 std(720p)/pro(1080p)，已按 std 处理。"
    ));
    "std"
}

/// 逐条收集"可灵不支持、已忽略"的参数。
fn dropped_params(params: &VideoParams) -> Vec<String> {
    let mut notes = Vec::new();
    if params.fps != 0 && params.fps != 30 {
        notes.push(format!("可灵输出固定 30 帧，已忽略帧率 {}。", params.fps));
    }
    if (params.motion_strength - DEFAULT_MOTION_STRENGTH).abs() > f32::EPSILON {
        notes.push(format!(
            "可灵不支持运动强度，已忽略该参数（{:.2}）。",
            params.motion_strength
        ));
    }
    if params.seed.is_some() {
        notes.push("可灵不支持固定种子，已忽略该参数。".into());
    }
    if !params.ref_images.is_empty() {
        notes.push(format!(
            "可灵只吃首帧 / 尾帧，已忽略 {} 张附加参考图（权重同样被忽略）。",
            params.ref_images.len()
        ));
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{AspectRatio, RefImage, VideoParams};

    fn request(patch: VideoParams) -> VideoRequest {
        VideoRequest {
            prompt: "女主推门而入".into(),
            params: patch,
        }
    }

    fn base_params() -> VideoParams {
        VideoParams {
            duration_ms: 5_000,
            aspect_ratio: AspectRatio::Portrait,
            resolution: "1080x1920".into(),
            fps: 30,
            motion_strength: DEFAULT_MOTION_STRENGTH,
            negative_prompt: "模糊".into(),
            ..VideoParams::default()
        }
    }

    #[test]
    fn maps_core_fields_for_landscape_pro() {
        let provider = KlingProvider::new("");
        let mut params = base_params();
        params.aspect_ratio = AspectRatio::Landscape;
        let out = provider.translate(&request(params));

        assert_eq!(out.provider, "kling");
        assert_eq!(out.body["model_name"], "kling-v1");
        assert_eq!(out.body["prompt"], "女主推门而入");
        assert_eq!(out.body["negative_prompt"], "模糊");
        assert_eq!(out.body["aspect_ratio"], "16:9");
        assert_eq!(out.body["mode"], "pro");
        assert_eq!(out.body["duration"], "5");
        assert!(out.notes.is_empty(), "不该有降级提示：{:?}", out.notes);
    }

    #[test]
    fn rounds_unusual_duration_and_explains() {
        let provider = KlingProvider::default();
        let mut params = base_params();
        params.duration_ms = 3_000;
        let out = provider.translate(&request(params));

        assert_eq!(out.body["duration"], "5");
        assert_eq!(out.notes.len(), 1);
        assert!(out.notes[0].contains("3.0 秒"));
    }

    #[test]
    fn empty_duration_falls_back_without_note() {
        let provider = KlingProvider::default();
        let mut params = base_params();
        params.duration_ms = 0;
        let out = provider.translate(&request(params));

        assert_eq!(out.body["duration"], "5");
        assert!(out.notes.is_empty());
    }

    #[test]
    fn std_mode_for_720p() {
        let provider = KlingProvider::default();
        let mut params = base_params();
        params.resolution = "720x1280".into();
        let out = provider.translate(&request(params));
        assert_eq!(out.body["mode"], "std");
    }

    #[test]
    fn unsupported_params_produce_degradation_notes() {
        let provider = KlingProvider::default();
        let mut params = base_params();
        params.fps = 24;
        params.motion_strength = 0.9;
        params.seed = Some(42);
        params.ref_images = vec![RefImage {
            path: "assets/characters/a.png".into(),
            weight: 0.8,
        }];
        let out = provider.translate(&request(params));

        assert!(out.body.get("seed").is_none());
        assert!(out.body.get("ref_images").is_none());
        assert_eq!(out.notes.len(), 4, "应逐条提示：{:?}", out.notes);
    }

    #[test]
    fn blank_negative_prompt_is_omitted() {
        let provider = KlingProvider::default();
        let mut params = base_params();
        params.negative_prompt = "   ".into();
        let out = provider.translate(&request(params));
        assert!(out.body.get("negative_prompt").is_none());
    }

    #[test]
    fn long_prompt_is_truncated_with_note() {
        let provider = KlingProvider::default();
        let req = VideoRequest {
            prompt: "字".repeat(MAX_PROMPT_CHARS + 5),
            params: base_params(),
        };
        let out = provider.translate(&req);
        let kept = out.body["prompt"].as_str().unwrap();
        assert_eq!(kept.chars().count(), MAX_PROMPT_CHARS);
        assert!(out.notes.iter().any(|n| n.contains("截断")));
    }

    #[test]
    fn frames_are_mapped_to_image_fields() {
        let provider = KlingProvider::default();
        let mut params = base_params();
        params.first_frame = Some("data:image/png;base64,AAA".into());
        params.last_frame = Some("data:image/png;base64,BBB".into());
        let out = provider.translate(&request(params));
        assert_eq!(out.body["image"], "data:image/png;base64,AAA");
        assert_eq!(out.body["image_tail"], "data:image/png;base64,BBB");
    }
}
