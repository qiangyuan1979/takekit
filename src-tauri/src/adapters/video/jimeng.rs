//! 即梦（火山方舟 Seedance）视频适配器（spec §9.4）。
//!
//! 方舟视频接口 `POST /contents/generations/tasks` 的报文是 `model` + `content[]`：
//! 参数以 `--key value` 指令拼在文本末尾（`--resolution` / `--ratio` / `--duration` /
//! `--seed` / `--watermark`），首帧、尾帧、参考图则各起一个 `image_url` 内容项
//! 并用 `role` 区分。因此本文件的翻译就是"文本 + 指令 + 图片项"。
//!
//! 与可灵的差异正好验证适配器抽象是否成立：
//! - 可灵把时长档位写死，方舟是连续取值域（2~12 秒）；
//! - 可灵没有负向提示词以外的空闲字段，方舟把分辨率编码进指令串；
//! - 方舟支持固定种子（可灵不支持）。
//!
//! 本文件只做翻译（M6）；真正的 HTTP 调用在 M7 加。

use super::{
    non_empty, truncate_prompt, Translated, VideoProvider, VideoRequest, DEFAULT_DURATION_MS,
    DEFAULT_MOTION_STRENGTH,
};
use crate::project::VideoParams;
use serde_json::json;

/// 适配器标识（与图片适配器同名，业务上都叫"即梦"）。
pub const NAME: &str = "jimeng";

/// 默认模型版本。
pub const DEFAULT_MODEL: &str = "doubao-seedance-1-0-pro-250528";

/// 方舟视频提示词长度上限（字符）。
const MAX_PROMPT_CHARS: usize = 2_000;

/// 方舟时长取值域（秒）。
const MIN_DURATION_S: u64 = 2;
const MAX_DURATION_S: u64 = 12;

/// 即梦（Seedance）视频 provider。
pub struct JimengVideoProvider {
    model: String,
}

impl JimengVideoProvider {
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

impl Default for JimengVideoProvider {
    fn default() -> Self {
        Self::new("")
    }
}

impl VideoProvider for JimengVideoProvider {
    fn name(&self) -> &'static str {
        NAME
    }

    fn translate(&self, request: &VideoRequest) -> Translated {
        let params = &request.params;
        let mut notes = Vec::new();

        let (prompt, mut prompt_notes) =
            truncate_prompt(&request.prompt, MAX_PROMPT_CHARS, "提示词");
        notes.append(&mut prompt_notes);

        let text = text_with_directives(&prompt, params, &mut notes);

        let mut content = vec![json!({ "type": "text", "text": text })];
        if let Some(first) = non_empty(&params.first_frame) {
            content.push(json!({
                "type": "image_url",
                "role": "first_frame",
                "image_url": { "url": first },
            }));
        }
        if let Some(last) = non_empty(&params.last_frame) {
            content.push(json!({
                "type": "image_url",
                "role": "last_frame",
                "image_url": { "url": last },
            }));
        }
        let refs: Vec<&str> = params
            .ref_images
            .iter()
            .map(|r| r.path.trim())
            .filter(|p| !p.is_empty())
            .collect();
        for path in &refs {
            content.push(json!({
                "type": "image_url",
                "role": "reference_image",
                "image_url": { "url": path },
            }));
        }

        notes.extend(dropped_params(params, refs.len()));

        Translated {
            provider: NAME.into(),
            body: json!({ "model": self.model, "content": content }),
            notes,
        }
    }
}

/// 把参数编码成方舟的 `--key value` 指令串，附在提示词之后。
fn text_with_directives(prompt: &str, params: &VideoParams, notes: &mut Vec<String>) -> String {
    let (resolution, resolution_note) = resolution_flag(&params.resolution);
    if let Some(note) = resolution_note {
        notes.push(note);
    }

    let requested_ms = if params.duration_ms == 0 {
        DEFAULT_DURATION_MS
    } else {
        params.duration_ms
    };
    let rounded = (requested_ms as f64 / 1000.0).round() as i64;
    let seconds = rounded.clamp(MIN_DURATION_S as i64, MAX_DURATION_S as i64);
    if seconds != rounded && params.duration_ms != 0 {
        notes.push(format!(
            "即梦时长只支持 {MIN_DURATION_S}~{MAX_DURATION_S} 秒，已把 {:.1} 秒调整为 {seconds} 秒。",
            params.duration_ms as f64 / 1000.0
        ));
    }

    let mut text = prompt.trim().to_string();
    text.push_str(&format!(" --resolution {resolution}"));
    text.push_str(&format!(" --ratio {}", params.aspect_ratio.as_str()));
    text.push_str(&format!(" --duration {seconds}"));
    text.push_str(" --watermark false");
    if let Some(seed) = params.seed {
        text.push_str(&format!(" --seed {seed}"));
    }
    text
}

/// 分辨率 → 方舟的 `--resolution` 取值；无法识别时按 1080p 处理并提示。
fn resolution_flag(resolution: &str) -> (&'static str, Option<String>) {
    let resolution = resolution.trim();
    if resolution.is_empty() || resolution.contains("1080") {
        return ("1080p", None);
    }
    for (needle, flag) in [("720", "720p"), ("480", "480p")] {
        if resolution.contains(needle) {
            return (flag, None);
        }
    }
    (
        "1080p",
        Some(format!(
            "分辨率「{resolution}」无法映射到即梦的 480p/720p/1080p，已按 1080p 处理。"
        )),
    )
}

/// 逐条收集"即梦不支持、已忽略"的参数。
fn dropped_params(params: &VideoParams, ref_count: usize) -> Vec<String> {
    let mut notes = Vec::new();
    if !params.negative_prompt.trim().is_empty() {
        notes.push("即梦没有负向提示词字段，已忽略；可把不想出现的内容写进正向提示词。".into());
    }
    if params.fps != 0 && params.fps != 30 {
        notes.push(format!("即梦输出固定 30 帧，已忽略帧率 {}。", params.fps));
    }
    if (params.motion_strength - DEFAULT_MOTION_STRENGTH).abs() > f32::EPSILON {
        notes.push(format!(
            "即梦不支持运动强度，已忽略该参数（{:.2}）。",
            params.motion_strength
        ));
    }
    if ref_count > 0 && non_empty(&params.first_frame).is_some() {
        notes.push("首帧与参考图同时下发可能不被即梦接受，建议二选一。".into());
    }
    if ref_count > 0 && params.ref_images.iter().any(|r| r.weight != 1.0) {
        notes.push("即梦不支持参考图权重，已按等权处理。".into());
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
            ..VideoParams::default()
        }
    }

    fn text_of(body: &serde_json::Value) -> String {
        body["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn encodes_params_as_directives() {
        let provider = JimengVideoProvider::new("");
        let mut params = base_params();
        params.aspect_ratio = AspectRatio::Landscape;
        params.seed = Some(7);
        let out = provider.translate(&request(params));

        assert_eq!(out.provider, "jimeng");
        assert_eq!(out.body["model"], DEFAULT_MODEL);
        let text = text_of(&out.body);
        assert!(text.starts_with("女主推门而入"));
        assert!(text.contains("--resolution 1080p"));
        assert!(text.contains("--ratio 16:9"));
        assert!(text.contains("--duration 5"));
        assert!(text.contains("--seed 7"));
        assert!(text.contains("--watermark false"));
        assert!(out.notes.is_empty(), "不该有降级提示：{:?}", out.notes);
    }

    #[test]
    fn custom_model_is_respected() {
        let provider = JimengVideoProvider::new(" my-model ");
        let out = provider.translate(&request(base_params()));
        assert_eq!(out.body["model"], "my-model");
    }

    #[test]
    fn clamps_duration_into_supported_range() {
        let provider = JimengVideoProvider::default();
        let mut params = base_params();
        params.duration_ms = 20_000;
        let out = provider.translate(&request(params));

        assert!(text_of(&out.body).contains("--duration 12"));
        assert_eq!(out.notes.len(), 1);
        assert!(out.notes[0].contains("12"));
    }

    #[test]
    fn empty_duration_uses_default_silently() {
        let provider = JimengVideoProvider::default();
        let mut params = base_params();
        params.duration_ms = 0;
        let out = provider.translate(&request(params));
        assert!(text_of(&out.body).contains("--duration 5"));
        assert!(out.notes.is_empty());
    }

    #[test]
    fn negative_prompt_is_dropped_with_note() {
        let provider = JimengVideoProvider::default();
        let mut params = base_params();
        params.negative_prompt = "模糊".into();
        let out = provider.translate(&request(params));
        assert_eq!(out.notes.len(), 1);
        assert!(out.notes[0].contains("负向提示词"));
    }

    #[test]
    fn frames_and_refs_become_image_items() {
        let provider = JimengVideoProvider::default();
        let mut params = base_params();
        params.first_frame = Some("data:image/png;base64,AAA".into());
        params.last_frame = Some("data:image/png;base64,BBB".into());
        let out = provider.translate(&request(params));

        let content = out.body["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[1]["role"], "first_frame");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAA");
        assert_eq!(content[2]["role"], "last_frame");
        // 首帧与尾帧不算"参考图"，因此不触发"二选一"提示。
        assert!(out.notes.is_empty(), "{:?}", out.notes);
    }

    #[test]
    fn reference_image_weight_is_flagged() {
        let provider = JimengVideoProvider::default();
        let mut params = base_params();
        params.ref_images = vec![RefImage {
            path: "assets/characters/a.png".into(),
            weight: 0.6,
        }];
        let out = provider.translate(&request(params));

        let content = out.body["content"].as_array().unwrap();
        assert_eq!(content[1]["role"], "reference_image");
        assert_eq!(out.notes.len(), 1);
        assert!(out.notes[0].contains("权重"));
    }

    #[test]
    fn unknown_resolution_falls_back_with_note() {
        let provider = JimengVideoProvider::default();
        let mut params = base_params();
        params.resolution = "4K".into();
        let out = provider.translate(&request(params));
        assert!(text_of(&out.body).contains("--resolution 1080p"));
        assert_eq!(out.notes.len(), 1);
    }
}
