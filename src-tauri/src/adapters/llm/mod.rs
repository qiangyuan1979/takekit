//! LLM 适配器契约：统一请求 / 响应模型 + `LlmProvider` trait（spec §9.2、§9.4）。
//!
//! 前端只构造 [`LlmRequest`]（消息数组 + 可选生成参数），不知道任何厂商字段；
//! 各实现把统一模型翻译成自家请求体，并把自家错误归一化为 [`AppError`]。

pub mod openai_compat;

use crate::error::AppResult;
use futures_util::future::BoxFuture;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

/// 消息角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmRole {
    System,
    User,
    Assistant,
}

/// 一条对话消息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: String,
}

impl LlmMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::System,
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::User,
            content: content.into(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::Assistant,
            content: content.into(),
        }
    }
}

/// 统一请求模型。
///
/// `temperature` / `max_tokens` 为 `None` 时由命令层用设置里的默认值补齐，
/// 保证"出题层不感知配置来源"。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlmRequest {
    pub messages: Vec<LlmMessage>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

/// token 用量；服务商未返回时全为 0。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlmUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// 统一非流式响应。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlmResponse {
    pub content: String,
    pub model: String,
    pub usage: LlmUsage,
}

/// 流式增量片段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChunk {
    /// 本次新增文本，可能为空串。
    pub delta: String,
    /// 是否已是最后一个片段；此后流即结束。
    pub done: bool,
}

/// 流式输出：`'static`，不借用 provider，便于跨 await 持有。
pub type LlmStream = Pin<Box<dyn Stream<Item = AppResult<LlmChunk>> + Send + 'static>>;

/// 文本模型适配器契约。
pub trait LlmProvider: Send + Sync {
    /// 适配器标识，用于错误信息。
    fn name(&self) -> &'static str;

    /// 一次性拿到完整回答。
    fn complete<'a>(&'a self, request: &'a LlmRequest) -> BoxFuture<'a, AppResult<LlmResponse>>;

    /// 增量拿回答。
    fn stream<'a>(&'a self, request: &'a LlmRequest) -> BoxFuture<'a, AppResult<LlmStream>>;
}

#[cfg(test)]
mod tests {
    //! 只覆盖请求模型的字段名映射（错误分类与截断已在父模块测试）。

    use super::*;

    #[test]
    fn request_roundtrip_uses_frontend_field_names() {
        let req = LlmRequest {
            messages: vec![LlmMessage::user("hi")],
            temperature: Some(0.5),
            max_tokens: Some(128),
        };
        let value = serde_json::to_value(&req).unwrap();
        assert_eq!(value["temperature"], 0.5);
        assert_eq!(value["maxTokens"], 128);
        assert_eq!(value["messages"][0]["role"], "user");
    }
}
