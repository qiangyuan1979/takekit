//! 视频适配器契约（spec §9.2、§9.4）：把统一提示词模型翻译成各家可用的请求体。
//!
//! 本层有两组契约：
//! - `translate`（M6，纯函数）回答"请求体长什么样"，不发网络请求、也不校验密钥，
//!   这样用户还没配 API Key 也能先看到"改成这个参数，可灵那条会变成什么"；
//! - [`VideoGenerator`]（M7）负责真正的 HTTP 调用：`submit → poll → fetch`。
//!   两家接口都是两段式（先提交拿 id，轮询到成功才给下载地址），故拆成三步；
//!   中间的轮询路由靠 [`Submitted::handle`] 记住，命令层无需理解任何厂商 URL 形状。
//!
//! 每家适配器是唯一知道自家报文格式的地方：字段改名、取值域收敛（如可灵只吃 5s/10s）、
//! 长度截断、以及"这家不支持该字段"的降级说明，全部收敛在这里，
//! 出题层永远只产出 [`VideoRequest`]。

pub mod jimeng;
pub mod kling;
pub mod mock;

use crate::adapters::{classify_status, classify_transport, truncate};
use crate::error::{AppError, AppResult};
use crate::project::VideoParams;
use futures_util::future::BoxFuture;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

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

// ---------- 生成侧契约（M7） ----------

/// 厂商侧任务状态（归一化口径，与前端任务状态前四态一一对应 + 取消态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

/// 提交结果。
///
/// `handle` 是**适配器内部的轮询路由**：可灵的查询 URL 里带 `text2video/image2video`
/// 段，而这个信息只有提交时才知道，故把它编码进 handle（如 `"image2video:<task_id>"`），
/// 让命令层不必理解任何厂商 URL 形状。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submitted {
    pub task_id: String,
    pub handle: String,
}

/// 一次轮询的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Polled {
    pub status: VideoStatus,
    /// 成功时的下载地址（方舟给的地址 24h 过期，命令层应立刻取回字节）。
    pub video_url: Option<String>,
    /// 失败时厂商给出的原因（供"换词建议"与手动重试判定）。
    pub error: Option<String>,
}

/// 取回的视频字节。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoOutput {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// 建生成器所需的接入配置（api_key 只在这一处流入内存）。
#[derive(Debug, Clone)]
pub struct VideoCredentials {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub timeout: Duration,
}

/// 视频生成器契约：适配器**不碰文件系统**，只把字节交回命令层。
pub trait VideoGenerator: Send + Sync {
    /// 适配器标识，用于错误信息与任务归属。
    fn name(&self) -> &'static str;

    /// 提交任务，返回厂商任务 id 与轮询路由。
    fn submit<'a>(&'a self, request: &'a VideoRequest) -> BoxFuture<'a, AppResult<Submitted>>;

    /// 按 `handle` 查询一次进度。
    fn poll<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, AppResult<Polled>>;

    /// 下载成品字节。
    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, AppResult<VideoOutput>>;

    /// 尽力取消（厂商没有取消端点时为空操作）。
    fn cancel<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, AppResult<()>>;
}

/// 可用于**生成**的 provider：比 [`SUPPORTED`] 多一个本地模拟器，无 Key 也能跑通全流程。
pub const GENERATORS: [&str; 3] = [kling::NAME, jimeng::NAME, mock::NAME];

/// 按 provider 名构造生成器；未知 provider 返回 `Validation`，由命令层转成用户可见提示。
pub fn generator(name: &str, credentials: &VideoCredentials) -> AppResult<Box<dyn VideoGenerator>> {
    match name.trim() {
        kling::NAME => Ok(Box::new(kling::KlingGenerator::new(credentials)?)),
        jimeng::NAME => Ok(Box::new(jimeng::JimengVideoGenerator::new(credentials)?)),
        mock::NAME => Ok(Box::new(mock::MockVideoGenerator::new(credentials))),
        other => Err(AppError::Validation {
            field: "provider".into(),
            detail: format!("video provider `{other}` is not supported"),
        }),
    }
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

/// 解析 JSON 响应体；非法 JSON 一律归为厂商错误。
pub(crate) fn parse_json(provider: &str, text: &str) -> AppResult<Value> {
    serde_json::from_str(text).map_err(|e| AppError::Provider {
        provider: provider.into(),
        detail: format!("invalid JSON response: {}", truncate(&e.to_string(), 300)),
    })
}

/// 发一次请求、读成文本、解析成 JSON；错误归一化与重试都走共用路径。
pub(crate) async fn request_json(
    provider: &str,
    build: impl Fn() -> reqwest::RequestBuilder,
) -> AppResult<Value> {
    let response = send_with_retry(provider, build).await?;
    let text = response
        .text()
        .await
        .map_err(|e| classify_transport(provider, &e))?;
    parse_json(provider, &text)
}

/// 把一段厂商文本变成归一化的厂商错误（截断后置入 detail）。
pub(crate) fn provider_error(provider: &str, detail: &str) -> AppError {
    AppError::Provider {
        provider: provider.into(),
        detail: truncate(detail.trim(), 300).to_string(),
    }
}

/// 归一化 content-type：去掉 `;charset=` 之类的参数，仅接受 `video/` 与 `image/`。
pub(crate) fn normalize_content_type(raw: Option<&str>) -> Option<String> {
    let value = raw?.split(';').next()?.trim().to_ascii_lowercase();
    if value.starts_with("video/") || value.starts_with("image/") {
        Some(value)
    } else {
        None
    }
}

/// 从文件头识别容器类型；识别不出返回 `None`（由调用方兜底）。
pub(crate) fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some("video/mp4");
    }
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some("video/webm");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    None
}

/// 下载成品：mime 优先取响应头，取不到再按文件头猜，最后兜底为二进制流。
pub(crate) async fn download_video(
    client: &Client,
    provider: &str,
    url: &str,
    timeout: Duration,
) -> AppResult<VideoOutput> {
    let response = send_with_retry(provider, || client.get(url).timeout(timeout)).await?;
    let declared = normalize_content_type(
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
    );
    let bytes = response
        .bytes()
        .await
        .map_err(|e| classify_transport(provider, &e))?
        .to_vec();
    let mime = declared
        .or_else(|| sniff_mime(&bytes).map(str::to_string))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    Ok(VideoOutput { bytes, mime })
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

    fn credentials() -> VideoCredentials {
        VideoCredentials {
            base_url: "https://api.example.com".into(),
            api_key: "sk-test".into(),
            model: String::new(),
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
    fn video_status_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&VideoStatus::Canceled).unwrap(),
            "\"canceled\""
        );
        let parsed: VideoStatus = serde_json::from_str("\"succeeded\"").unwrap();
        assert_eq!(parsed, VideoStatus::Succeeded);
    }

    #[test]
    fn sniff_mime_recognizes_common_containers() {
        let mut mp4 = vec![0u8; 4];
        mp4.extend_from_slice(b"ftyp");
        mp4.extend_from_slice(&[0u8; 4]);
        assert_eq!(sniff_mime(&mp4), Some("video/mp4"));
        assert_eq!(
            sniff_mime(&[0x1A, 0x45, 0xDF, 0xA3, 0x00]),
            Some("video/webm")
        );
        assert_eq!(
            sniff_mime(&[0x89, b'P', b'N', b'G', 0x0D]),
            Some("image/png")
        );
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_mime(&[0x00, 0x01, 0x02]), None);
    }

    #[test]
    fn content_type_is_normalized_and_filtered() {
        assert_eq!(
            normalize_content_type(Some("video/mp4")),
            Some("video/mp4".into())
        );
        assert_eq!(
            normalize_content_type(Some("Video/MP4; charset=utf-8")),
            Some("video/mp4".into())
        );
        assert_eq!(normalize_content_type(Some("text/html")), None);
        assert_eq!(normalize_content_type(None), None);
    }
}
