//! 配音命令（spec §5.8.1）：按剧本台词逐句合成语音，归档进 `voice/`。
//!
//! 与 [`crate::commands::generate`] 的分工一致：协议在 `adapters::tts`，
//! 磁盘布局在这里收口；任务本身的持久化由前端写进 `project.json`，
//! 命令层只负责"跑一次、把结果通过 `Channel` 汇报出去"。
//!
//! TTS 是**一段式**（一次请求直接拿回音频），因此没有轮询循环，只有
//! `buffer_unordered(MAX_CONCURRENCY)` 的并发限流与共享的软取消登记表。
//!
//! 归档命名用**台词 id**：同一句重新合成时原地覆盖，不产生版本垃圾
//! （音频不像片段需要"抽卡择优"，故不沿用 `镜号_版本` 命名）。

use crate::adapters::tts::{self, AudioOutput, TtsCredentials, TtsGenerator};
use crate::commands::asset::to_relative;
use crate::commands::generate::CancelRegistry;
use crate::commands::project::resolve_project_path;
use crate::commands::settings::load_tts_config;
use crate::error::{AppError, AppResult};
use crate::project::TaskStatus;
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

/// 同时推进的合成链路上限：厂商侧普遍限流，超过只会把请求堵在队列里。
const MAX_CONCURRENCY: usize = 3;

/// 单次合成请求的超时。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// 配音归档目录（spec §8）。
const VOICE_DIR: &str = "voice";

/// 一条配音任务：`task_id` 由前端生成，与 `project.json` 里的 `Task.id` 同源。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceJob {
    pub task_id: String,
    /// 台词 id，用于归档命名与事件回填。
    pub voice_line_id: String,
    pub request: tts::TtsRequest,
}

/// 一条进度事件；失败时带归一化错误码与参数，翻译交给前端。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsEvent {
    pub task_id: String,
    pub voice_line_id: String,
    pub status: TaskStatus,
    /// 成功时为项目相对路径（如 `voice/<台词 id>.mp3`）。
    pub audio_path: Option<String>,
    pub mime: Option<String>,
    /// 音频时长（毫秒），供字幕与时间线对齐。
    pub duration_ms: u64,
    /// 厂商原文或英文消息，供日志与兜底展示。
    pub error: Option<String>,
    pub error_code: Option<String>,
    pub error_args: Option<HashMap<String, String>>,
}

impl TtsEvent {
    /// 只有状态的进度事件。
    fn plain(task_id: &str, voice_line_id: &str, status: TaskStatus) -> Self {
        Self {
            task_id: task_id.to_string(),
            voice_line_id: voice_line_id.to_string(),
            status,
            audio_path: None,
            mime: None,
            duration_ms: 0,
            error: None,
            error_code: None,
            error_args: None,
        }
    }

    /// 由归一化错误构造失败事件。
    fn from_error(task_id: &str, voice_line_id: &str, error: &AppError) -> Self {
        let args = error.args();
        let mut event = Self::plain(task_id, voice_line_id, TaskStatus::Failed);
        event.error = Some(error.to_string());
        event.error_code = Some(error.code().to_string());
        event.error_args = (!args.is_empty()).then_some(args);
        event
    }

    /// 成功事件：带上归档路径、mime 与时长。
    fn succeeded(
        task_id: &str,
        voice_line_id: &str,
        audio_path: String,
        output: &AudioOutput,
    ) -> Self {
        let mut event = Self::plain(task_id, voice_line_id, TaskStatus::Succeeded);
        event.audio_path = Some(audio_path);
        event.mime = Some(output.mime.clone());
        event.duration_ms = output.duration_ms;
        event
    }
}

/// 可用于配音的 provider 清单（真机 + 本地模拟器）。
#[tauri::command]
pub fn list_tts_generators() -> Vec<&'static str> {
    tts::GENERATORS.to_vec()
}

/// 请求取消若干配音任务；返回登记数量。
///
/// 与视频共用同一张软取消登记表（任务 id 全局唯一）。
#[tauri::command]
pub fn cancel_voice_tasks(
    state: State<'_, CancelRegistry>,
    task_ids: Vec<String>,
) -> AppResult<usize> {
    for task_id in &task_ids {
        state.cancel(task_id)?;
    }
    Ok(task_ids.len())
}

/// 提交一批配音任务，边跑边推进度，最后返回每条任务的终态快照。
///
/// 返回的列表与传入的 `jobs` 顺序一致。
#[tauri::command]
pub async fn generate_voice_lines(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    project_path: String,
    provider: String,
    jobs: Vec<VoiceJob>,
    on_event: Channel<TtsEvent>,
) -> AppResult<Vec<TtsEvent>> {
    let root = project_root(&project_path)?;
    if jobs.is_empty() {
        return Ok(Vec::new());
    }

    let config = load_tts_config(&app)?;
    let credentials = TtsCredentials {
        base_url: config.base_url,
        api_key: config.api_key,
        model: config.model,
        timeout: REQUEST_TIMEOUT,
    };
    let generator = tts::generator(&provider, &credentials)?;

    let task_ids: Vec<String> = jobs.iter().map(|job| job.task_id.clone()).collect();
    let emit = |event: TtsEvent| {
        // 推送失败只说明前端已切走页面，不影响任务本身。
        let _ = on_event.send(event);
    };
    let events = run_voice_batch(&root, generator.as_ref(), jobs, state.inner(), &emit).await;

    for task_id in &task_ids {
        state.clear(task_id);
    }
    Ok(events)
}

// ---------- 队列 ----------

/// 并发跑完一批配音任务，返回按 `jobs` 原序排列的终态快照。
pub(crate) async fn run_voice_batch<F>(
    root: &Path,
    generator: &dyn TtsGenerator,
    jobs: Vec<VoiceJob>,
    canceled: &CancelRegistry,
    emit: &F,
) -> Vec<TtsEvent>
where
    F: Fn(TtsEvent) + Send + Sync,
{
    let planned: Vec<(usize, VoiceJob)> = jobs.into_iter().enumerate().collect();

    let mut events: Vec<(usize, TtsEvent)> = stream::iter(planned)
        .map(|(index, job)| async move {
            let event = run_one(root, generator, job, canceled, emit).await;
            (index, event)
        })
        .buffer_unordered(MAX_CONCURRENCY)
        .collect()
        .await;

    events.sort_by_key(|(index, _)| *index);
    events.into_iter().map(|(_, event)| event).collect()
}

/// 跑单条配音任务：取消检查 → 合成 → 落盘，全程把状态变化推出去。
async fn run_one<F>(
    root: &Path,
    generator: &dyn TtsGenerator,
    job: VoiceJob,
    canceled: &CancelRegistry,
    emit: &F,
) -> TtsEvent
where
    F: Fn(TtsEvent) + Send + Sync,
{
    let task_id = job.task_id.clone();
    let line_id = job.voice_line_id.clone();
    emit(TtsEvent::plain(&task_id, &line_id, TaskStatus::Running));

    if canceled.is_canceled(&task_id) {
        return emit_and(
            TtsEvent::plain(&task_id, &line_id, TaskStatus::Canceled),
            emit,
        );
    }

    let output = match generator.synthesize(&job.request).await {
        Ok(output) => output,
        Err(error) => return emit_and(TtsEvent::from_error(&task_id, &line_id, &error), emit),
    };

    match save_audio(root, &job.voice_line_id, &output) {
        Ok(relative) => emit_and(
            TtsEvent::succeeded(&task_id, &line_id, relative, &output),
            emit,
        ),
        Err(error) => emit_and(TtsEvent::from_error(&task_id, &line_id, &error), emit),
    }
}

/// 推一条事件并把它作为返回值交回，避免每处都写两遍。
fn emit_and<F>(event: TtsEvent, emit: &F) -> TtsEvent
where
    F: Fn(TtsEvent),
{
    emit(event.clone());
    event
}

// ---------- 归档 ----------

/// 把音频写进 `voice/`，返回项目相对路径。
fn save_audio(root: &Path, voice_line_id: &str, output: &AudioOutput) -> AppResult<String> {
    let dir = root.join(VOICE_DIR);
    fs::create_dir_all(&dir)?;
    let dest = dir.join(audio_file_name(voice_line_id, audio_ext(&output.mime)));
    fs::write(&dest, &output.bytes)?;
    to_relative(root, &dest)
}

/// 归档文件名：`<台词 id>.<扩展名>`；同一句重新合成时原地覆盖。
fn audio_file_name(voice_line_id: &str, ext: &str) -> String {
    format!("{voice_line_id}.{ext}")
}

/// mime → 归档扩展名；未知一律按 mp3 存（后续仍可按文件头识别）。
fn audio_ext(mime: &str) -> &'static str {
    match mime {
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mp4" | "audio/m4a" => "m4a",
        "audio/ogg" => "ogg",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/aac" => "aac",
        _ => "mp3",
    }
}

// ---------- 路径助手 ----------

/// 项目根目录（`project.json` 所在目录）。
fn project_root(project_path: &str) -> AppResult<PathBuf> {
    Ok(resolve_project_path(project_path)?.0)
}

#[cfg(test)]
mod tests {
    //! 配音队列的行为测试：归档命名、失败不落盘、取消。
    //! 真机 HTTP 报文由适配器层覆盖，这里用本地模拟器。

    use super::*;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    fn credentials() -> TtsCredentials {
        TtsCredentials {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            timeout: Duration::from_secs(5),
        }
    }

    fn job(task_id: &str, line_id: &str, text: &str) -> VoiceJob {
        VoiceJob {
            task_id: task_id.into(),
            voice_line_id: line_id.into(),
            request: tts::TtsRequest {
                text: text.into(),
                voice: "alloy".into(),
                emotion: String::new(),
                speed: 1.0,
            },
        }
    }

    fn recorder() -> (Arc<Mutex<Vec<TtsEvent>>>, impl Fn(TtsEvent) + Send + Sync) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let emit = move |event: TtsEvent| {
            sink.lock().unwrap().push(event);
        };
        (seen, emit)
    }

    #[tokio::test]
    async fn a_batch_lands_audio_named_by_line_id() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let generator = tts::generator("mock", &credentials()).unwrap();
        let jobs = vec![
            job("t1", "line-1", "你好，世界。"),
            job("t2", "line-2", "旁白一句话"),
        ];
        let (seen, emit) = recorder();

        let events = run_voice_batch(
            root,
            generator.as_ref(),
            jobs,
            &CancelRegistry::default(),
            &emit,
        )
        .await;

        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.status == TaskStatus::Succeeded));
        assert_eq!(events[0].audio_path.as_deref(), Some("voice/line-1.wav"));
        assert_eq!(events[1].audio_path.as_deref(), Some("voice/line-2.wav"));
        assert!(root.join("voice/line-1.wav").is_file());
        assert!(events[0].duration_ms > 0);
        assert!(seen
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.status == TaskStatus::Running));
    }

    #[tokio::test]
    async fn a_failing_line_reports_reason_and_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let generator = tts::generator("mock", &credentials()).unwrap();
        let jobs = vec![job("t1", "line-1", "台词 #fail")];

        let events = run_voice_batch(
            root,
            generator.as_ref(),
            jobs,
            &CancelRegistry::default(),
            &|_| {},
        )
        .await;

        assert_eq!(events[0].status, TaskStatus::Failed);
        assert_eq!(events[0].error_code.as_deref(), Some("provider"));
        assert!(events[0].audio_path.is_none());
        assert!(!root.join("voice/line-1.wav").exists());
    }

    #[tokio::test]
    async fn a_canceled_line_produces_no_audio() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let generator = tts::generator("mock", &credentials()).unwrap();
        let jobs = vec![job("t1", "line-1", "你好")];

        let canceled = CancelRegistry::default();
        canceled.cancel("t1").unwrap();

        let events = run_voice_batch(root, generator.as_ref(), jobs, &canceled, &|_| {}).await;

        assert_eq!(events[0].status, TaskStatus::Canceled);
        assert!(!root.join("voice/line-1.wav").exists());
    }

    #[test]
    fn audio_extensions_follow_mime() {
        assert_eq!(audio_ext("audio/wav"), "wav");
        assert_eq!(audio_ext("audio/mpeg"), "mp3");
        assert_eq!(audio_ext("audio/mp4"), "m4a");
        assert_eq!(audio_ext("audio/ogg"), "ogg");
        assert_eq!(audio_ext("application/octet-stream"), "mp3");
        assert_eq!(audio_file_name("line-1", "wav"), "line-1.wav");
    }
}
