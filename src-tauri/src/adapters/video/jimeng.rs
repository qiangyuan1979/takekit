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
//! 本文件有两层：`translate`（M6 纯函数）产出请求体，[`JimengVideoGenerator`]（M7）
//! 负责真正发请求。

use super::{
    build_client, download_video, non_empty, provider_error, request_json, truncate_prompt, Polled,
    Submitted, Translated, VideoCredentials, VideoGenerator, VideoOutput, VideoProvider,
    VideoRequest, VideoStatus, DEFAULT_DURATION_MS, DEFAULT_MOTION_STRENGTH,
};
use crate::adapters::{classify_status, classify_transport};
use crate::error::{AppError, AppResult};
use crate::project::VideoParams;
use futures_util::future::BoxFuture;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

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

// ---------- 生成侧实现（M7） ----------

/// 方舟任务端点：提交 / 查询 / 取消共用同一个前缀。
const TASKS_PATH: &str = "/contents/generations/tasks";

/// 即梦（方舟 Seedance）视频生成器。
///
/// 与可灵的差异在这里最直观：方舟是多段式 REST（提交拿顶层 `id`、查询看 `status`、
/// 取消走 `DELETE`），且**同一份 body 三处复用**，故复用 [`JimengVideoProvider::translate`]。
pub struct JimengVideoGenerator {
    client: Client,
    /// 已拼好的任务端点（`{base}/contents/generations/tasks`）。
    endpoint: String,
    api_key: String,
    provider: JimengVideoProvider,
    timeout: Duration,
}

impl JimengVideoGenerator {
    /// 构造生成器；配置缺失在第一处就明确报错，而不是等到发请求。
    pub fn new(credentials: &VideoCredentials) -> AppResult<Self> {
        let base = credentials.base_url.trim();
        if base.is_empty() {
            return Err(AppError::Validation {
                field: "baseUrl".into(),
                detail: "video base URL is required".into(),
            });
        }
        if credentials.api_key.trim().is_empty() {
            return Err(AppError::Auth("video API key is not configured".into()));
        }
        Ok(Self {
            client: build_client()?,
            endpoint: format!("{}{TASKS_PATH}", base.trim_end_matches('/')),
            api_key: credentials.api_key.trim().to_string(),
            provider: JimengVideoProvider::new(&credentials.model),
            timeout: credentials.timeout,
        })
    }

    /// 提交阶段的失败信息在顶层 `error` 字段里。
    fn check_error(&self, value: &Value) -> AppResult<()> {
        match value.get("error") {
            Some(error) if !error.is_null() => Err(provider_error(NAME, &error.to_string())),
            _ => Ok(()),
        }
    }

    /// 拼任务 URL（查询与取消共用）。
    fn task_url(&self, handle: &str) -> String {
        format!("{}/{handle}", self.endpoint)
    }
}

impl VideoGenerator for JimengVideoGenerator {
    fn name(&self) -> &'static str {
        NAME
    }

    fn submit<'a>(&'a self, request: &'a VideoRequest) -> BoxFuture<'a, AppResult<Submitted>> {
        Box::pin(async move {
            let body = self.provider.translate(request).body;
            let value = request_json(NAME, || {
                self.client
                    .post(&self.endpoint)
                    .bearer_auth(&self.api_key)
                    .timeout(self.timeout)
                    .json(&body)
            })
            .await?;
            self.check_error(&value)?;

            // 方舟的创建响应把任务 id 放在**顶层** `id`（不像可灵嵌在 data 里）。
            let task_id = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| provider_error(NAME, "submit response has no task id"))?;
            Ok(Submitted {
                task_id: task_id.to_string(),
                handle: task_id.to_string(),
            })
        })
    }

    fn poll<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, AppResult<Polled>> {
        Box::pin(async move {
            let url = self.task_url(handle);
            let value = request_json(NAME, || {
                self.client
                    .get(&url)
                    .bearer_auth(&self.api_key)
                    .timeout(self.timeout)
            })
            .await?;

            // 这里**不**调 `check_error`：任务失败恰恰要靠 `error` 字段把原因带给用户，
            // 若在此处直接返回 Err，就丢掉了「已失败」这个状态本身。
            let raw = value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let status = parse_status(raw)?;
            let error = value
                .get("error")
                .filter(|v| !v.is_null())
                .map(|v| v.to_string());
            let video_url = value
                .pointer("/content/video_url")
                .and_then(Value::as_str)
                .map(str::to_string);

            Ok(Polled {
                status,
                video_url,
                error,
            })
        })
    }

    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, AppResult<VideoOutput>> {
        Box::pin(async move { download_video(&self.client, NAME, url, self.timeout).await })
    }

    /// 方舟支持取消（`DELETE .../tasks/{id}`）；任务已不存在时等价于取消成功。
    ///
    /// 这里**不**走 `send_with_retry`：取消不需要重试，且 404 是预期结果之一。
    fn cancel<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            let response = self
                .client
                .delete(self.task_url(handle))
                .bearer_auth(&self.api_key)
                .timeout(self.timeout)
                .send()
                .await
                .map_err(|e| classify_transport(NAME, &e))?;
            if response.status().is_success() || response.status().as_u16() == 404 {
                return Ok(());
            }
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            Err(classify_status(NAME, status.as_u16(), &text))
        })
    }
}

/// 方舟任务状态 → 归一化状态。
fn parse_status(raw: &str) -> AppResult<VideoStatus> {
    Ok(match raw {
        "queued" => VideoStatus::Queued,
        "running" => VideoStatus::Running,
        "succeeded" => VideoStatus::Succeeded,
        "failed" => VideoStatus::Failed,
        // 方舟文档写 `cancelled`，个别返回写 `canceled`，两种都收。
        "cancelled" | "canceled" => VideoStatus::Canceled,
        other => {
            return Err(provider_error(
                NAME,
                &format!("unknown task status `{other}`"),
            ))
        }
    })
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

    fn credentials() -> VideoCredentials {
        VideoCredentials {
            base_url: "https://ark.example.com/api/v3".into(),
            api_key: "sk-test".into(),
            model: String::new(),
            timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn generator_requires_base_url_and_key() {
        let mut creds = credentials();
        creds.base_url = "  ".into();
        assert!(matches!(
            JimengVideoGenerator::new(&creds).err(),
            Some(AppError::Validation { .. })
        ));

        let mut creds = credentials();
        creds.api_key = String::new();
        assert!(matches!(
            JimengVideoGenerator::new(&creds).err(),
            Some(AppError::Auth(_))
        ));
    }

    #[test]
    fn status_strings_map_to_normalized_states() {
        assert_eq!(parse_status("queued").unwrap(), VideoStatus::Queued);
        assert_eq!(parse_status("running").unwrap(), VideoStatus::Running);
        assert_eq!(parse_status("succeeded").unwrap(), VideoStatus::Succeeded);
        assert_eq!(parse_status("failed").unwrap(), VideoStatus::Failed);
        assert_eq!(parse_status("cancelled").unwrap(), VideoStatus::Canceled);
        assert_eq!(parse_status("canceled").unwrap(), VideoStatus::Canceled);
        assert_eq!(parse_status("莫名其妙").unwrap_err().code(), "provider");
    }

    #[test]
    fn top_level_error_is_reported_on_submit() {
        let generator = JimengVideoGenerator::new(&credentials()).unwrap();
        assert!(generator.check_error(&json!({ "id": "task-1" })).is_ok());

        let error = generator
            .check_error(&json!({ "error": { "code": "InvalidParameter", "message": "bad" } }))
            .unwrap_err();
        assert_eq!(error.code(), "provider");
        assert!(error.to_string().contains("InvalidParameter"));
    }
}
