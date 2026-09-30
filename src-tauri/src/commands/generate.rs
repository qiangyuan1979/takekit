//! 生成命令（spec §5.7）：把出题产物真正送给厂商，盯完轮询，再把成品归档进 `clips/`。
//!
//! 这一层只做编排，不碰协议，也不写回项目：
//! - 各家 HTTP 报文（submit / poll / fetch / cancel）全在 `adapters::video` 里；
//! - 本项目的磁盘布局（`clips/<镜号>_<版本>.<ext>`、相对路径）在这里收口；
//! - 任务本身的持久化**不在这一层**——`Task` 由前端写进 `project.json`，
//!   命令层只负责"跑一次、把每一步结果通过 `Channel` 汇报出去"。
//!
//! 并发的节奏是：`buffer_unordered(MAX_CONCURRENCY)` 同时最多推进这么多条链路
//! （提交 → 轮询…… → 取回），共享状态只有取消登记表。取消表的临界区极短且不跨
//! `await`，故用标准库锁，不必引入 `tokio::sync`。
//!
//! 首帧 / 尾帧 / 参考图在 `project.json` 里是**项目相对路径**，而厂商只认 URL，
//! 所以发请求前在这一层读成 data URL（与资产出图走同一条通路）。

use crate::adapters::video::{
    self, VideoCredentials, VideoGenerator, VideoOutput, VideoRequest, VideoStatus,
};
use crate::commands::asset::{data_url, extension_of, mime_for_ext, resolve_relative, to_relative};
use crate::commands::project::resolve_project_path;
use crate::commands::settings::load_video_config;
use crate::error::{AppError, AppResult};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

/// 同时推进的生成链路上限：厂商侧普遍限流，超过只会把请求堵在队列里。
const MAX_CONCURRENCY: usize = 3;

/// 轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// 单条任务的总超时：从提交算起，超了就当失败，避免一条任务永远挂住向导。
const JOB_TIMEOUT: Duration = Duration::from_secs(900);

/// 单次 HTTP 请求的超时（提交 / 查询 / 下载各算一次）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// 成品归档目录（spec §8）。
const CLIPS_DIR: &str = "clips";

/// 一条生成任务：`task_id` 由前端生成，与 `project.json` 里的 `Task.id` 同源，
/// 因此进度事件能直接落回同一条任务，命令层无需知道任何项目数据。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateJob {
    pub task_id: String,
    /// 镜号，只用于归档命名（`clips/007_02.mp4`）。
    pub shot_no: u32,
    pub request: VideoRequest,
}

/// 一条进度事件。
///
/// 失败时同时给出 `error_code` 与 `error_args`，让前端能按既有 `describeError`
/// 规则翻译成中文——Rust 侧不产出用户可见文案（见 `error.rs` 模块约定）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateEvent {
    pub task_id: String,
    pub status: VideoStatus,
    /// 成功时为项目相对路径（如 `clips/007_01.mp4`）。
    pub clip_path: Option<String>,
    pub mime: Option<String>,
    /// 厂商原文或英文消息，供日志与兜底展示。
    pub error: Option<String>,
    pub error_code: Option<String>,
    pub error_args: Option<HashMap<String, String>>,
}

impl GenerateEvent {
    /// 只有状态的进度事件（排队 / 进行中 / 已取消）。
    fn plain(task_id: &str, status: VideoStatus) -> Self {
        Self {
            task_id: task_id.to_string(),
            status,
            clip_path: None,
            mime: None,
            error: None,
            error_code: None,
            error_args: None,
        }
    }

    /// 由归一化错误构造失败事件。
    fn from_error(task_id: &str, error: &AppError) -> Self {
        let args = error.args();
        let mut event = Self::plain(task_id, VideoStatus::Failed);
        event.error = Some(error.to_string());
        event.error_code = Some(error.code().to_string());
        event.error_args = (!args.is_empty()).then_some(args);
        event
    }

    /// 由厂商自报的失败构造事件（如"内容审核未通过"）。
    fn vendor_failed(task_id: &str, provider: &str, detail: &str) -> Self {
        let mut event = Self::plain(task_id, VideoStatus::Failed);
        event.error = Some(detail.to_string());
        event.error_code = Some("provider".to_string());
        event.error_args = Some(HashMap::from([
            ("provider".to_string(), provider.to_string()),
            ("detail".to_string(), detail.to_string()),
        ]));
        event
    }

    /// 成功事件：带上归档路径与 mime。
    fn succeeded(task_id: &str, clip_path: String, mime: String) -> Self {
        let mut event = Self::plain(task_id, VideoStatus::Succeeded);
        event.clip_path = Some(clip_path);
        event.mime = Some(mime);
        event
    }
}

/// 已请求取消的任务 id 集合。
///
/// 取消是"下一轮轮询时检查"的软取消：厂商大多没有取消端点，真相源始终是本地标记。
#[derive(Default)]
pub struct CancelRegistry {
    ids: Mutex<HashSet<String>>,
}

impl CancelRegistry {
    /// 登记取消请求。
    pub fn cancel(&self, task_id: &str) -> AppResult<()> {
        self.ids
            .lock()
            .map_err(|_| lock_poisoned())?
            .insert(task_id.to_string());
        Ok(())
    }

    /// 是否已被请求取消；锁中毒时按"未取消"处理（宁可把任务跑完，也不要卡住队列）。
    pub fn is_canceled(&self, task_id: &str) -> bool {
        self.ids
            .lock()
            .map(|ids| ids.contains(task_id))
            .unwrap_or(false)
    }

    /// 批次结束后清理标记，避免登记表无限增长。
    pub fn clear(&self, task_id: &str) {
        if let Ok(mut ids) = self.ids.lock() {
            ids.remove(task_id);
        }
    }
}

/// 锁中毒在登记表上不该发生，兜底成内部错误。
fn lock_poisoned() -> AppError {
    AppError::Internal("cancel registry lock poisoned".into())
}

/// 队列节奏：抽成参数，单测里可以把 3 秒 / 15 分钟压到毫秒级。
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub poll_interval: Duration,
    pub job_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            poll_interval: POLL_INTERVAL,
            job_timeout: JOB_TIMEOUT,
        }
    }
}

/// 可用于生成的 provider 清单（比出题层多一个本地模拟器）。
#[tauri::command]
pub fn list_video_generators() -> Vec<&'static str> {
    video::GENERATORS.to_vec()
}

/// 请求取消若干任务；返回登记数量。
///
/// 软取消：正在跑的那条会在下一轮轮询时看到标记并收尾。任务不在当前批次里时
/// 标记会一直留着（前端只会传运行中的任务 id）。
#[tauri::command]
pub fn cancel_clip_tasks(
    state: State<'_, CancelRegistry>,
    task_ids: Vec<String>,
) -> AppResult<usize> {
    for task_id in &task_ids {
        state.cancel(task_id)?;
    }
    Ok(task_ids.len())
}

/// 提交一批生成任务，边跑边推进度，最后返回每条任务的终态快照。
///
/// 返回的列表与传入的 `jobs` 顺序一致（内部并发执行，收尾时按原序排回）。
#[tauri::command]
pub async fn generate_clips(
    app: AppHandle,
    state: State<'_, CancelRegistry>,
    project_path: String,
    provider: String,
    jobs: Vec<GenerateJob>,
    on_event: Channel<GenerateEvent>,
) -> AppResult<Vec<GenerateEvent>> {
    let root = project_root(&project_path)?;
    if jobs.is_empty() {
        return Ok(Vec::new());
    }

    let config = load_video_config(&app)?;
    let credentials = VideoCredentials {
        base_url: config.base_url,
        api_key: config.api_key,
        model: config.model,
        timeout: REQUEST_TIMEOUT,
    };
    let generator = video::generator(&provider, &credentials)?;

    // 版本号在批次开始前一次性分配：并发写同一个镜号时不会撞名。
    let versions = allocate_versions(&root, &jobs)?;
    let task_ids: Vec<String> = jobs.iter().map(|job| job.task_id.clone()).collect();

    let emit = |event: GenerateEvent| {
        // 推送失败只说明前端已不关心进度（如切走了页面），不影响任务本身。
        let _ = on_event.send(event);
    };
    let events = run_batch(
        &root,
        generator.as_ref(),
        jobs,
        versions,
        Limits::default(),
        state.inner(),
        &emit,
    )
    .await;

    for task_id in &task_ids {
        state.clear(task_id);
    }
    Ok(events)
}

// ---------- 队列 ----------

/// 并发跑完一批任务，返回按 `jobs` 原序排列的终态快照。
pub(crate) async fn run_batch<F>(
    root: &Path,
    generator: &dyn VideoGenerator,
    jobs: Vec<GenerateJob>,
    versions: HashMap<String, u32>,
    limits: Limits,
    canceled: &CancelRegistry,
    emit: &F,
) -> Vec<GenerateEvent>
where
    F: Fn(GenerateEvent) + Send + Sync,
{
    let planned: Vec<(usize, GenerateJob, u32)> = jobs
        .into_iter()
        .enumerate()
        .map(|(index, job)| {
            let version = versions.get(&job.task_id).copied().unwrap_or(1);
            (index, job, version)
        })
        .collect();

    let mut events: Vec<(usize, GenerateEvent)> = stream::iter(planned)
        .map(|(index, job, version)| async move {
            let event = run_one(root, generator, job, version, limits, canceled, emit).await;
            (index, event)
        })
        .buffer_unordered(MAX_CONCURRENCY)
        .collect()
        .await;

    events.sort_by_key(|(index, _)| *index);
    events.into_iter().map(|(_, event)| event).collect()
}

/// 跑单条任务：提交 → 轮询 → 取回 → 落盘，全程把状态变化推出去。
async fn run_one<F>(
    root: &Path,
    generator: &dyn VideoGenerator,
    job: GenerateJob,
    version: u32,
    limits: Limits,
    canceled: &CancelRegistry,
    emit: &F,
) -> GenerateEvent
where
    F: Fn(GenerateEvent) + Send + Sync,
{
    let task_id = job.task_id.clone();
    emit(GenerateEvent::plain(&task_id, VideoStatus::Running));

    let mut request = job.request;
    if let Err(error) = resolve_frames(root, &mut request) {
        return emit_and(GenerateEvent::from_error(&task_id, &error), emit);
    }

    let submitted = match generator.submit(&request).await {
        Ok(submitted) => submitted,
        Err(error) => return emit_and(GenerateEvent::from_error(&task_id, &error), emit),
    };

    let start = tokio::time::Instant::now();
    let mut reported = VideoStatus::Running;

    loop {
        if canceled.is_canceled(&task_id) {
            // 厂商多半没有取消端点，这一步是"尽力而为"，真相源是本地标记。
            let _ = generator.cancel(&submitted.handle).await;
            return emit_and(GenerateEvent::plain(&task_id, VideoStatus::Canceled), emit);
        }
        if start.elapsed() >= limits.job_timeout {
            let error = AppError::Timeout {
                detail: format!(
                    "generation did not finish within {}s",
                    limits.job_timeout.as_secs()
                ),
            };
            return emit_and(GenerateEvent::from_error(&task_id, &error), emit);
        }

        let polled = match generator.poll(&submitted.handle).await {
            Ok(polled) => polled,
            Err(error) => return emit_and(GenerateEvent::from_error(&task_id, &error), emit),
        };

        match polled.status {
            VideoStatus::Queued | VideoStatus::Running => {
                // 只在状态真的变化时推事件，避免刷屏。
                if polled.status != reported {
                    reported = polled.status;
                    emit(GenerateEvent::plain(&task_id, polled.status));
                }
            }
            VideoStatus::Canceled => {
                return emit_and(GenerateEvent::plain(&task_id, VideoStatus::Canceled), emit);
            }
            VideoStatus::Failed => {
                let detail = polled.error.unwrap_or_else(|| "unknown reason".to_string());
                return emit_and(
                    GenerateEvent::vendor_failed(&task_id, generator.name(), &detail),
                    emit,
                );
            }
            VideoStatus::Succeeded => {
                // 方舟给的下载地址 24 小时过期，拿到就立刻取回字节。
                let Some(url) = polled.video_url else {
                    let error = AppError::Provider {
                        provider: generator.name().into(),
                        detail: "task succeeded without a video url".into(),
                    };
                    return emit_and(GenerateEvent::from_error(&task_id, &error), emit);
                };
                let output = match generator.fetch(&url).await {
                    Ok(output) => output,
                    Err(error) => {
                        return emit_and(GenerateEvent::from_error(&task_id, &error), emit)
                    }
                };
                return match save_clip(root, job.shot_no, version, &output) {
                    Ok(relative) => emit_and(
                        GenerateEvent::succeeded(&task_id, relative, output.mime),
                        emit,
                    ),
                    Err(error) => emit_and(GenerateEvent::from_error(&task_id, &error), emit),
                };
            }
        }

        tokio::time::sleep(limits.poll_interval).await;
    }
}

/// 推一条事件并把它作为返回值交回，避免每处都写两遍。
fn emit_and<F>(event: GenerateEvent, emit: &F) -> GenerateEvent
where
    F: Fn(GenerateEvent),
{
    emit(event.clone());
    event
}

// ---------- 归档 ----------

/// 把成品写进 `clips/`，返回项目相对路径。
fn save_clip(root: &Path, shot_no: u32, version: u32, output: &VideoOutput) -> AppResult<String> {
    let dir = root.join(CLIPS_DIR);
    fs::create_dir_all(&dir)?;
    let dest = dir.join(clip_file_name(shot_no, version, clip_ext(&output.mime)));
    fs::write(&dest, &output.bytes)?;
    to_relative(root, &dest)
}

/// 归档文件名：`<镜号>_<版本>.<扩展名>`，镜号与版本都补零到固定宽度，
/// 这样目录按文件名排序就是时间序（spec §8）。
fn clip_file_name(shot_no: u32, version: u32, ext: &str) -> String {
    format!("{shot_no:03}_{version:02}.{ext}")
}

/// 解析归档文件名；不符合约定的文件名（如用户自己丢进来的）一律忽略。
fn parse_clip_name(name: &str) -> Option<(u32, u32)> {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let (shot_no, version) = stem.split_once('_')?;
    Some((shot_no.parse().ok()?, version.parse().ok()?))
}

/// mime → 归档扩展名；未知一律按 mp4 存（后续仍可按文件头识别）。
fn clip_ext(mime: &str) -> &'static str {
    match mime {
        "video/webm" => "webm",
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "mp4",
    }
}

/// 扫描 `clips/`，得到"每个镜号已用到的最大版本"，目录不存在时视为空。
fn max_versions(root: &Path) -> AppResult<HashMap<u32, u32>> {
    let mut versions: HashMap<u32, u32> = HashMap::new();
    let entries = match fs::read_dir(root.join(CLIPS_DIR)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(versions),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let name = entry?.file_name().to_string_lossy().to_string();
        if let Some((shot_no, version)) = parse_clip_name(&name) {
            let current = versions.entry(shot_no).or_insert(0);
            if version > *current {
                *current = version;
            }
        }
    }
    Ok(versions)
}

/// 为整批任务分配版本号，键是 `task_id`。
///
/// 同一个镜号在一次批次里出现多次（抽卡）时会依次递增，不会互相覆盖。
fn allocate_versions(root: &Path, jobs: &[GenerateJob]) -> AppResult<HashMap<String, u32>> {
    let mut versions = max_versions(root)?;
    let mut allocated = HashMap::with_capacity(jobs.len());
    for job in jobs {
        let next = versions.entry(job.shot_no).or_insert(0);
        *next += 1;
        allocated.insert(job.task_id.clone(), *next);
    }
    Ok(allocated)
}

// ---------- 帧 / 参考图 ----------

/// 把请求里的项目相对路径读成 data URL；已经是 `data:` 或 `http(s):` 的原样保留。
fn resolve_frames(root: &Path, request: &mut VideoRequest) -> AppResult<()> {
    request.params.first_frame = resolve_frame(root, request.params.first_frame.as_deref())?;
    request.params.last_frame = resolve_frame(root, request.params.last_frame.as_deref())?;
    for image in &mut request.params.ref_images {
        if let Some(resolved) = resolve_frame(root, Some(&image.path))? {
            image.path = resolved;
        }
    }
    Ok(())
}

/// 单个引用 → 可直接交给厂商的 URL；空值返回 `None`。
fn resolve_frame(root: &Path, value: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if raw.starts_with("data:") || raw.starts_with("http://") || raw.starts_with("https://") {
        return Ok(Some(raw.to_string()));
    }
    let path = resolve_relative(root, raw)?;
    let bytes = fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound {
            path: raw.to_string(),
        },
        _ => AppError::Io(e),
    })?;
    Ok(Some(data_url(&mime_for_ext(&extension_of(&path)), &bytes)))
}

// ---------- 路径助手 ----------

/// 项目根目录（`project.json` 所在目录）。
fn project_root(project_path: &str) -> AppResult<PathBuf> {
    Ok(resolve_project_path(project_path)?.0)
}

#[cfg(test)]
mod tests {
    //! 队列的行为测试：并发上限、取消、超时、归档命名与版本续号。
    //! 真机 HTTP 报文由适配器层的 wiremock 测试覆盖，这里用本地模拟器与桩生成器。

    use super::*;
    use crate::adapters::video::{Polled, Submitted};
    use crate::project::VideoParams;
    use futures_util::future::BoxFuture;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::TempDir;

    const MAX_CONCURRENCY_ASSERT: usize = MAX_CONCURRENCY;

    fn credentials() -> VideoCredentials {
        VideoCredentials {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            timeout: Duration::from_secs(5),
        }
    }

    fn job(task_id: &str, shot_no: u32, prompt: &str) -> GenerateJob {
        GenerateJob {
            task_id: task_id.into(),
            shot_no,
            request: VideoRequest {
                prompt: prompt.into(),
                params: VideoParams::default(),
            },
        }
    }

    fn limits() -> Limits {
        Limits {
            poll_interval: Duration::from_millis(1),
            job_timeout: Duration::from_secs(5),
        }
    }

    /// 收集型回调：既当进度记录仪，也能看到事件顺序。
    fn recorder() -> (
        Arc<Mutex<Vec<GenerateEvent>>>,
        impl Fn(GenerateEvent) + Send + Sync,
    ) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let emit = move |event: GenerateEvent| {
            sink.lock().unwrap().push(event);
        };
        (seen, emit)
    }

    #[tokio::test]
    async fn a_batch_lands_clips_named_by_shot_and_version() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let generator = video::generator("mock", &credentials()).unwrap();
        let jobs = vec![job("t1", 1, "推门而入"), job("t2", 2, "转身离开")];
        let versions = allocate_versions(root, &jobs).unwrap();
        let (seen, emit) = recorder();

        let events = run_batch(
            root,
            generator.as_ref(),
            jobs,
            versions,
            limits(),
            &CancelRegistry::default(),
            &emit,
        )
        .await;

        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.status == VideoStatus::Succeeded));
        assert_eq!(events[0].task_id, "t1");
        // 模拟器交回的是 PNG 占位图，故扩展名跟着 mime 走。
        assert_eq!(events[0].clip_path.as_deref(), Some("clips/001_01.png"));
        assert_eq!(events[1].clip_path.as_deref(), Some("clips/002_01.png"));
        assert!(root.join("clips/001_01.png").is_file());
        assert!(seen
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.status == VideoStatus::Running));
    }

    #[tokio::test]
    async fn a_failing_job_reports_its_reason_and_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let generator = video::generator("mock", &credentials()).unwrap();
        let jobs = vec![job("t1", 1, "打斗 #fail")];
        let versions = allocate_versions(root, &jobs).unwrap();

        let events = run_batch(
            root,
            generator.as_ref(),
            jobs,
            versions,
            limits(),
            &CancelRegistry::default(),
            &|_| {},
        )
        .await;

        assert_eq!(events[0].status, VideoStatus::Failed);
        assert!(events[0].error.as_deref().unwrap().contains("审核"));
        assert_eq!(events[0].error_code.as_deref(), Some("provider"));
        assert!(!root.join("clips/001_01.png").exists());
    }

    #[tokio::test]
    async fn a_canceled_job_stops_before_producing_a_clip() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let generator = video::generator("mock", &credentials()).unwrap();
        let jobs = vec![job("t1", 1, "推门而入")];
        let versions = allocate_versions(root, &jobs).unwrap();

        // 批次开始前就登记取消：第一条轮询循环立刻看到标记。
        let canceled = CancelRegistry::default();
        canceled.cancel("t1").unwrap();

        let events = run_batch(
            root,
            generator.as_ref(),
            jobs,
            versions,
            limits(),
            &canceled,
            &|_| {},
        )
        .await;

        assert_eq!(events[0].status, VideoStatus::Canceled);
        assert!(events[0].clip_path.is_none());
        assert!(!root.join("clips/001_01.png").exists());
    }

    #[test]
    fn versions_continue_after_existing_files() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("clips")).unwrap();
        fs::write(root.join("clips/003_01.mp4"), b"x").unwrap();
        fs::write(root.join("clips/003_02.mp4"), b"x").unwrap();
        fs::write(root.join("clips/readme.md"), b"x").unwrap();

        let jobs = vec![job("t1", 3, "a"), job("t2", 3, "b")];
        let versions = allocate_versions(root, &jobs).unwrap();

        assert_eq!(versions["t1"], 3);
        assert_eq!(versions["t2"], 4);
    }

    #[test]
    fn clip_names_round_trip() {
        assert_eq!(parse_clip_name("012_03.mp4"), Some((12, 3)));
        assert_eq!(parse_clip_name("012_03"), Some((12, 3)));
        assert_eq!(parse_clip_name("readme.md"), None);
        assert_eq!(parse_clip_name("012.mp4"), None);

        assert_eq!(clip_file_name(7, 2, "mp4"), "007_02.mp4");
        assert_eq!(clip_ext("video/mp4"), "mp4");
        assert_eq!(clip_ext("video/webm"), "webm");
        assert_eq!(clip_ext("image/png"), "png");
        assert_eq!(clip_ext("application/octet-stream"), "mp4");
    }

    #[test]
    fn project_relative_frames_become_data_urls() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let frame = root.join("assets/frames/shot-1/gen-1.png");
        fs::create_dir_all(frame.parent().unwrap()).unwrap();
        fs::write(&frame, b"\x89PNG\r\n\x1a\nbody").unwrap();

        let mut request = VideoRequest {
            prompt: "推门而入".into(),
            params: VideoParams {
                first_frame: Some("assets/frames/shot-1/gen-1.png".into()),
                last_frame: Some("https://cdn.example.com/last.png".into()),
                ref_images: vec![crate::project::RefImage {
                    path: "assets/frames/shot-1/gen-1.png".into(),
                    weight: 1.0,
                }],
                ..VideoParams::default()
            },
        };
        resolve_frames(root, &mut request).unwrap();

        let first = request.params.first_frame.unwrap();
        assert!(first.starts_with("data:image/png;base64,"), "{first}");
        assert_eq!(
            request.params.last_frame.as_deref(),
            Some("https://cdn.example.com/last.png")
        );
        assert!(request.params.ref_images[0]
            .path
            .starts_with("data:image/png;base64,"));
    }

    /// 桩生成器：能观察并发峰值，也能让任务永远停在"进行中"以验证超时。
    struct StubGenerator {
        live: AtomicUsize,
        peak: AtomicUsize,
        polls: AtomicUsize,
        submit_delay: Duration,
        /// 第几次轮询开始算成功；`0` 表示一直不成功（用于超时分支）。
        succeed_after: usize,
    }

    impl StubGenerator {
        fn new(submit_delay: Duration, succeed_after: usize) -> Self {
            Self {
                live: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                polls: AtomicUsize::new(0),
                submit_delay,
                succeed_after,
            }
        }
    }

    impl VideoGenerator for StubGenerator {
        fn name(&self) -> &'static str {
            "stub"
        }

        fn submit<'a>(&'a self, _request: &'a VideoRequest) -> BoxFuture<'a, AppResult<Submitted>> {
            Box::pin(async move {
                let live = self.live.fetch_add(1, Ordering::SeqCst) + 1;
                self.peak.fetch_max(live, Ordering::SeqCst);
                tokio::time::sleep(self.submit_delay).await;
                self.live.fetch_sub(1, Ordering::SeqCst);
                let task_id = crate::project::new_id();
                Ok(Submitted {
                    handle: task_id.clone(),
                    task_id,
                })
            })
        }

        fn poll<'a>(&'a self, _handle: &'a str) -> BoxFuture<'a, AppResult<Polled>> {
            Box::pin(async move {
                let count = self.polls.fetch_add(1, Ordering::SeqCst) + 1;
                if self.succeed_after > 0 && count >= self.succeed_after {
                    return Ok(Polled {
                        status: VideoStatus::Succeeded,
                        video_url: Some("stub://clip".into()),
                        error: None,
                    });
                }
                Ok(Polled {
                    status: VideoStatus::Running,
                    video_url: None,
                    error: None,
                })
            })
        }

        fn fetch<'a>(&'a self, _url: &'a str) -> BoxFuture<'a, AppResult<VideoOutput>> {
            Box::pin(async move {
                Ok(VideoOutput {
                    bytes: b"\x00\x00\x00\x18ftyp".to_vec(),
                    mime: "video/mp4".into(),
                })
            })
        }

        fn cancel<'a>(&'a self, _handle: &'a str) -> BoxFuture<'a, AppResult<()>> {
            Box::pin(async move { Ok(()) })
        }
    }

    #[tokio::test]
    async fn concurrency_is_capped_but_actually_parallel() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let generator = StubGenerator::new(Duration::from_millis(30), 1);
        let jobs: Vec<GenerateJob> = (1..=6)
            .map(|n| job(&format!("t{n}"), n as u32, "镜头"))
            .collect();
        let versions = allocate_versions(root, &jobs).unwrap();

        let events = run_batch(
            root,
            &generator,
            jobs,
            versions,
            limits(),
            &CancelRegistry::default(),
            &|_| {},
        )
        .await;

        assert!(events.iter().all(|e| e.status == VideoStatus::Succeeded));
        // 峰值恰好等于上限：说明既没超发，也确实在并行。
        assert_eq!(
            generator.peak.load(Ordering::SeqCst),
            MAX_CONCURRENCY_ASSERT
        );
        assert!(root.join("clips/006_01.mp4").is_file());
    }

    #[tokio::test]
    async fn a_job_that_never_finishes_is_failed_by_the_timeout() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let generator = StubGenerator::new(Duration::from_millis(1), 0);
        let jobs = vec![job("t1", 1, "永远在转圈")];
        let versions = allocate_versions(root, &jobs).unwrap();
        let limits = Limits {
            poll_interval: Duration::from_millis(5),
            job_timeout: Duration::from_millis(60),
        };

        let events = run_batch(
            root,
            &generator,
            jobs,
            versions,
            limits,
            &CancelRegistry::default(),
            &|_| {},
        )
        .await;

        assert_eq!(events[0].status, VideoStatus::Failed);
        assert_eq!(events[0].error_code.as_deref(), Some("timeout"));
        assert!(!root.join("clips").join("001_01.mp4").exists());
    }
}
