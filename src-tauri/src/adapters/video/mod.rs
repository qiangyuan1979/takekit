//! 视频适配器契约（spec §9.2、§9.4）：把统一提示词模型翻译成各家可用的请求体。
//!
//! M6（出题）阶段只做**翻译**：`translate` 是纯函数，不发网络请求、也不校验密钥，
//! 这样用户还没配 API Key 也能先看到"改成这个参数，可灵那条会变成什么"。
//! 真正调用厂商 API 生成视频是 M7（生成环节），届时在本层之上再补 HTTP 实现。
//!
//! 每家适配器是唯一知道自家报文格式的地方：字段改名、取值域收敛（如可灵只吃 5s/10s）、
//! 长度截断、以及"这家不支持该字段"的降级说明，全部收敛在这里，
//! 出题层永远只产出 [`VideoRequest`]。

pub mod jimeng;
pub mod kling;

use crate::project::VideoParams;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 未指定时长时的兜底（毫秒）：5 秒，与两家默认值一致。
pub const DEFAULT_DURATION_MS: u64 = 5_000;

/// 运动强度的"未改动"默认值；某家不支持该字段时，改动过才提示，避免常驻噪声。
pub const DEFAULT_MOTION_STRENGTH: f32 = 0.5;

/// 统一的视频生成请求：出题层拼好的提示词 + 参数层（spec §5.6 第二层）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoRequest {
    /// 已拼装好的提示词（中文或英文，由调用方选择传哪条）。
    pub prompt: String,
    /// 参数层：时长 / 画幅 / 分辨率 / 帧率 / 运动强度 / 种子 / 负向提示词 / 参考图 / 首尾帧。
    pub params: VideoParams,
}

/// 翻译产物：厂商名 + 该家可用的请求体 + 逐条降级说明。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Translated {
    pub provider: String,
    pub body: Value,
    /// 供前端原样展示的"降级 / 截断"说明；为空表示完全等价映射。
    pub notes: Vec<String>,
}

/// 视频模型适配器契约。
pub trait VideoProvider: Send + Sync {
    /// 适配器标识，用于错误信息与 `perProvider` 的键。
    fn name(&self) -> &'static str;

    /// 把统一请求翻译成自家请求体（纯函数）。
    fn translate(&self, request: &VideoRequest) -> Translated;
}

/// 已支持的视频 provider 标识，供前端下拉与校验共用。
pub const SUPPORTED: [&str; 2] = [kling::NAME, jimeng::NAME];

/// 按 provider 名构造适配器；`model` 为空时用该家默认版本。
///
/// 未知 provider 返回 `None`，由调用方决定如何降级（前端会提示"这家还没支持"）。
pub fn provider(name: &str, model: &str) -> Option<Box<dyn VideoProvider>> {
    match name.trim() {
        kling::NAME => Some(Box::new(kling::KlingProvider::new(model))),
        jimeng::NAME => Some(Box::new(jimeng::JimengVideoProvider::new(model))),
        _ => None,
    }
}

/// 按字符截断，并给出"信息可能丢失"的说明；未超长时说明为空。
pub(crate) fn truncate_prompt(text: &str, max_chars: usize, label: &str) -> (String, Vec<String>) {
    if text.chars().count() <= max_chars {
        return (text.to_string(), Vec::new());
    }
    let kept = crate::adapters::truncate(text, max_chars).to_string();
    (
        kept,
        vec![format!(
            "{label}超过 {max_chars} 字上限，已截断；结尾信息可能丢失。"
        )],
    )
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

    #[test]
    fn truncate_prompt_keeps_short_text_silently() {
        let (kept, notes) = truncate_prompt("你好", 10, "提示词");
        assert_eq!(kept, "你好");
        assert!(notes.is_empty());
    }

    #[test]
    fn truncate_prompt_cuts_on_char_boundary_and_warns() {
        let (kept, notes) = truncate_prompt("你好世界", 2, "提示词");
        assert_eq!(kept, "你好");
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("2"));
    }

    #[test]
    fn provider_registry_covers_supported_names_and_rejects_unknown() {
        for name in SUPPORTED {
            assert!(provider(name, "").is_some(), "{name} 未注册");
        }
        assert!(provider("mystery", "").is_none());
        assert!(provider("  kling  ", "").is_some());
    }

    #[test]
    fn non_empty_trims_and_treats_blank_as_absent() {
        assert_eq!(non_empty(&Some("  x ".into())), Some("x".into()));
        assert_eq!(non_empty(&Some("   ".into())), None);
        assert_eq!(non_empty(&None), None);
    }
}
