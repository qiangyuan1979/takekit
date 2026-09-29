//! 图片适配器契约：统一请求 / 输出模型 + `ImageProvider` trait（spec §9.2、§9.4）。
//!
//! 出题层只构造 [`ImageRequest`]（提示词 + 尺寸 + 张数 + 参考图），不知道任何厂商字段；
//! 各实现把统一模型翻译成自家请求体，并把自家错误归一化为 [`AppError`]。
//!
//! 适配器**不碰文件系统**：本地参考图由命令层读出来编码成 data URL 再交进来，
//! 生成结果以字节 + mime 返回，落盘也由命令层负责。

pub mod jimeng;

use crate::error::AppResult;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

/// 未指定张数时的候选张数（spec §13.2 #5：出 4 张供挑选）。
pub const DEFAULT_COUNT: u32 = 4;

/// 未指定尺寸时的边长，由适配器翻译成厂商要求的尺寸字段。
pub const DEFAULT_SIZE: u32 = 1024;

/// 统一图片请求模型。
///
/// `ref_images` 里的元素既可以是 `http(s)://` URL，也可以是命令层编码好的
/// `data:{mime};base64,...`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImageRequest {
    pub prompt: String,
    /// 负向提示词；厂商不支持该字段时由适配器负责降级（不下发）。
    pub negative_prompt: Option<String>,
    /// 边长；为 0 时用 [`DEFAULT_SIZE`]。
    pub width: u32,
    pub height: u32,
    /// 期望张数；为 0 时用 [`DEFAULT_COUNT`]。
    pub count: u32,
    pub seed: Option<i64>,
    /// 参考图（角色定妆照 / 场景基调图），用于保持一致性。
    pub ref_images: Vec<String>,
}

/// 生成好的单张图片。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageOutput {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// 图片模型适配器契约。
pub trait ImageProvider: Send + Sync {
    /// 适配器标识，用于错误信息。
    fn name(&self) -> &'static str;

    /// 生成候选图；顺序与请求里的参考图无关，由调用方自行决定选取哪张。
    fn generate<'a>(
        &'a self,
        request: &'a ImageRequest,
    ) -> BoxFuture<'a, AppResult<Vec<ImageOutput>>>;
}
