//! 项目数据模型（spec §7）。
//!
//! 该模块是全应用的"唯一真相源"结构：序列化后写入 `project.json`，
//! 前端 `src/lib/types.ts` 与其保持字段镜像（camelCase）。
//!
//! 解析策略：所有结构体带 `#[serde(default)]`，缺失字段回落默认值，
//! 以便旧版本项目文件仍能加载（结构性不兼容变更交给 `migrate.rs`）。

pub mod migrate;
pub mod store;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// 当前 schema 版本。结构发生不兼容变更时递增，并在 `migrate.rs` 补迁移步骤。
pub const SCHEMA_VERSION: u32 = 2;

/// 新建实体 ID。
pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

/// 统一时间戳格式（RFC3339，秒级，UTC，形如 `2026-09-29T08:00:00Z`）。
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

// ---------- 枚举（字面量稳定，与前端 TS 联合类型一一对应） ----------

/// 作品类型：短剧（多集）/ 短视频（单条）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkKind {
    ShortDrama,
    ShortVideo,
}

impl Default for WorkKind {
    fn default() -> Self {
        WorkKind::ShortDrama
    }
}

impl WorkKind {
    /// 是否为短剧（短剧才显示"集数"等条件字段）。
    pub fn is_drama(self) -> bool {
        matches!(self, WorkKind::ShortDrama)
    }
}

/// 画幅。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AspectRatio {
    #[serde(rename = "9:16")]
    Portrait,
    #[serde(rename = "16:9")]
    Landscape,
    #[serde(rename = "1:1")]
    Square,
}

impl Default for AspectRatio {
    fn default() -> Self {
        AspectRatio::Portrait
    }
}

impl AspectRatio {
    pub fn as_str(self) -> &'static str {
        match self {
            AspectRatio::Portrait => "9:16",
            AspectRatio::Landscape => "16:9",
            AspectRatio::Square => "1:1",
        }
    }

    /// 全部合法取值，供前端下拉与校验共用。
    pub const ALL: [AspectRatio; 3] = [
        AspectRatio::Portrait,
        AspectRatio::Landscape,
        AspectRatio::Square,
    ];
}

/// 景别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShotSize {
    ExtremeLong,
    LongShot,
    MediumShot,
    CloseUp,
    ExtremeCloseUp,
}

impl Default for ShotSize {
    fn default() -> Self {
        ShotSize::MediumShot
    }
}

/// 机位与运镜。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CameraMove {
    StaticShot,
    PushIn,
    PullOut,
    Pan,
    Truck,
    Follow,
    Crane,
    Orbit,
}

impl Default for CameraMove {
    fn default() -> Self {
        CameraMove::StaticShot
    }
}

/// 转场。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transition {
    Cut,
    Dissolve,
    FadeIn,
    FadeOut,
    WhipPan,
}

impl Default for Transition {
    fn default() -> Self {
        Transition::Cut
    }
}

/// 关键帧角色：首帧（必需）/ 尾帧（可选）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameRole {
    First,
    Last,
}

/// 任务类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Llm,
    Image,
    Video,
}

/// 任务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

// ---------- 立项参数（spec §5.1 四张卡） ----------

/// 立项参数：卡1 作品定位 / 卡2 规格参数 / 卡3 风格锚点 / 卡4 生成默认配置。
///
/// 这些字段会向下继承到后续所有环节的提示词模板，分镜级可覆盖。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Meta {
    // —— 卡1 作品定位 ——
    pub title: String,
    pub kind: WorkKind,
    pub genre: String,
    pub platform: String,
    pub audience: String,

    // —— 卡2 规格参数 ——
    pub aspect_ratio: AspectRatio,
    pub resolution: String,
    pub fps: u32,
    pub episode_duration_ms: u64,
    /// 集数；`kind = short_video` 时该字段被隐藏且不参与下游。
    pub episode_count: u32,
    pub language: String,
    pub subtitle_language: String,

    // —— 卡3 风格锚点 ——
    pub visual_style: String,
    pub mood: String,
    pub style_keywords: Vec<String>,
    pub style_ref_images: Vec<String>,

    // —— 卡4 生成默认配置 ——
    pub default_video_model: String,
    pub default_image_model: String,
    pub default_llm: String,
    pub default_voice: String,
    pub param_preset: String,
}

impl Default for Meta {
    fn default() -> Self {
        Self {
            title: String::new(),
            kind: WorkKind::default(),
            genre: "都市逆袭".into(),
            platform: "抖音".into(),
            audience: String::new(),

            aspect_ratio: AspectRatio::default(),
            resolution: "1080x1920".into(),
            fps: 30,
            episode_duration_ms: 60_000,
            episode_count: 3,
            language: "zh-CN".into(),
            subtitle_language: "zh-CN".into(),

            visual_style: "实拍写实感".into(),
            mood: "爽".into(),
            style_keywords: Vec::new(),
            style_ref_images: Vec::new(),

            default_video_model: "kling".into(),
            default_image_model: "jimeng".into(),
            default_llm: "openai-compat".into(),
            default_voice: "女声·清冷".into(),
            param_preset: "标准".into(),
        }
    }
}

// ---------- 剧本：创意核 / 大纲 ----------

/// 剧本四段中的 A 段（创意核）与 B 段（大纲）的字段载体（spec §5.2）。
///
/// C 段（剧本正文，按场）落在 `episodes[].scenes`；D 段（一致性引用）由
/// `scene.characters` 与 `assets` 运行时推导，均不在此结构重复存储。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Script {
    /// 一句话故事。
    pub logline: String,
    /// 核心冲突。
    pub core_conflict: String,
    /// 主角目标。
    pub protagonist_goal: String,
    /// 阻碍（阻力来源）。
    pub obstacle: String,
    /// 爽点 / 钩子设计。
    pub hook: String,
    /// 结尾反转。
    pub twist: String,
    /// 结构模板 id（空 = 按作品类型取默认）；模板正文由前端持有，此处只存 id。
    pub structure: String,
    /// 已锁定的字段名集合，AI 重写时跳过。
    pub locked_fields: Vec<String>,
}

// ---------- 剧本：集 / 场 / 对白 ----------

/// 单集（短视频退化为单一默认集，结构统一）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub no: u32,
    pub title: String,
    pub summary: String,
    /// 每集节拍（beat），M2 使用。
    pub beats: Vec<String>,
    pub scenes: Vec<Scene>,
}

impl Default for Episode {
    fn default() -> Self {
        Self {
            id: new_id(),
            no: 0,
            title: String::new(),
            summary: String::new(),
            beats: Vec::new(),
            scenes: Vec::new(),
        }
    }
}

impl Episode {
    pub fn new(no: u32, title: impl Into<String>) -> Self {
        Self {
            no,
            title: title.into(),
            ..Self::default()
        }
    }
}

/// 场。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Scene {
    pub id: String,
    pub no: u32,
    pub location: String,
    pub time_of_day: String,
    pub interior: bool,
    /// 出场角色（引用资产里的角色卡 id；此处允许只写占位名）。
    pub characters: Vec<String>,
    pub action_desc: String,
    pub dialogues: Vec<Dialogue>,
    pub shots: Vec<Shot>,
}

impl Default for Scene {
    fn default() -> Self {
        Self {
            id: new_id(),
            no: 0,
            location: String::new(),
            time_of_day: String::new(),
            interior: true,
            characters: Vec::new(),
            action_desc: String::new(),
            dialogues: Vec::new(),
            shots: Vec::new(),
        }
    }
}

/// 对白 / 旁白。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Dialogue {
    pub character_id: String,
    pub text: String,
    pub is_narration: bool,
}

// ---------- 分镜：镜 / 关键帧 ----------

/// 镜头。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Shot {
    pub id: String,
    pub episode_id: String,
    pub scene_id: String,
    pub no: u32,
    pub shot_size: ShotSize,
    pub camera_move: CameraMove,
    pub duration_ms: u64,
    pub visual_desc: String,
    /// 出场角色（引用角色卡 id）。
    pub characters: Vec<String>,
    pub dialogue: Option<String>,
    pub narration: Option<String>,
    pub sfx_hint: String,
    pub transition: Transition,
    pub note: String,
    /// M6 产出：统一提示词模型 + 各家请求体。
    pub prompt_bundle: Option<PromptBundle>,
    /// 已"采用"的片段 id（M7）。
    pub adopted_clip_id: Option<String>,
    pub frames: Vec<Frame>,
}

impl Default for Shot {
    fn default() -> Self {
        Self {
            id: new_id(),
            episode_id: String::new(),
            scene_id: String::new(),
            no: 0,
            shot_size: ShotSize::default(),
            camera_move: CameraMove::default(),
            duration_ms: 3_000,
            visual_desc: String::new(),
            characters: Vec::new(),
            dialogue: None,
            narration: None,
            sfx_hint: String::new(),
            transition: Transition::default(),
            note: String::new(),
            prompt_bundle: None,
            adopted_clip_id: None,
            frames: Vec::new(),
        }
    }
}

/// 关键帧：候选列表 + 定稿 + 跨镜参考。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Frame {
    pub id: String,
    pub role: FrameRole,
    /// 候选图路径（项目相对路径）。
    pub candidates: Vec<String>,
    /// 定稿图路径。
    pub adopted: Option<String>,
    /// "以镜头 N 的定稿帧为参考"时填被引用镜头的 id。
    pub ref_shot_id: Option<String>,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            id: new_id(),
            role: FrameRole::First,
            candidates: Vec::new(),
            adopted: None,
            ref_shot_id: None,
        }
    }
}

// ---------- 出题：统一提示词模型 + 参数 ----------

/// 统一提示词模型：出题层只产出它，厂商字段映射交给适配器（spec §9.4）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UnifiedPrompt {
    pub subject: String,
    pub environment: String,
    pub camera: String,
    pub lighting: String,
    pub style: String,
    pub quality: String,
}

/// 参考图及其权重。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RefImage {
    pub path: String,
    pub weight: f32,
}

impl Default for RefImage {
    fn default() -> Self {
        Self {
            path: String::new(),
            weight: 1.0,
        }
    }
}

/// 生成参数层。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoParams {
    pub duration_ms: u64,
    pub aspect_ratio: AspectRatio,
    pub resolution: String,
    pub fps: u32,
    pub motion_strength: f32,
    pub seed: Option<i64>,
    pub negative_prompt: String,
    pub ref_images: Vec<RefImage>,
    pub first_frame: Option<String>,
    pub last_frame: Option<String>,
}

impl Default for VideoParams {
    fn default() -> Self {
        Self {
            duration_ms: 0,
            aspect_ratio: AspectRatio::default(),
            resolution: String::new(),
            fps: 30,
            motion_strength: 0.5,
            seed: None,
            negative_prompt: String::new(),
            ref_images: Vec::new(),
            first_frame: None,
            last_frame: None,
        }
    }
}

/// 单镜的完整出题产物。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PromptBundle {
    pub unified: UnifiedPrompt,
    pub zh: String,
    pub en: String,
    pub params: VideoParams,
    /// provider 名 → 该家可用的请求体。
    pub per_provider: BTreeMap<String, serde_json::Value>,
}

// ---------- 资产（一致性） ----------

/// 外貌。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Appearance {
    pub face_shape: String,
    pub hair: String,
    pub hair_color: String,
    pub eye_color: String,
    pub height: String,
    pub body: String,
}

/// 服装套装（同一角色多套造型）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Costume {
    pub id: String,
    pub name: String,
    pub description: String,
    pub ref_image: Option<String>,
}

impl Default for Costume {
    fn default() -> Self {
        Self {
            id: new_id(),
            name: String::new(),
            description: String::new(),
            ref_image: None,
        }
    }
}

/// 角色卡。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub age: String,
    pub gender: String,
    pub appearance: Appearance,
    pub costumes: Vec<Costume>,
    pub personality: String,
    pub speech_style: String,
    /// 音色（留给 v1.5 TTS）。
    pub voice: String,
    pub ref_images: Vec<String>,
    /// 定妆照 / 三视图基准图。
    pub portrait: Option<String>,
}

impl Default for Character {
    fn default() -> Self {
        Self {
            id: new_id(),
            name: String::new(),
            aliases: Vec::new(),
            age: String::new(),
            gender: String::new(),
            appearance: Appearance::default(),
            costumes: Vec::new(),
            personality: String::new(),
            speech_style: String::new(),
            voice: String::new(),
            ref_images: Vec::new(),
            portrait: None,
        }
    }
}

/// 场景卡。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SceneAsset {
    pub id: String,
    pub name: String,
    pub interior: bool,
    pub time_of_day: String,
    pub weather: String,
    pub description: String,
    pub lighting: String,
    pub ref_images: Vec<String>,
}

impl Default for SceneAsset {
    fn default() -> Self {
        Self {
            id: new_id(),
            name: String::new(),
            interior: true,
            time_of_day: String::new(),
            weather: String::new(),
            description: String::new(),
            lighting: String::new(),
            ref_images: Vec::new(),
        }
    }
}

/// 道具卡。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Prop {
    pub id: String,
    pub name: String,
    pub description: String,
    pub ref_image: Option<String>,
}

impl Default for Prop {
    fn default() -> Self {
        Self {
            id: new_id(),
            name: String::new(),
            description: String::new(),
            ref_image: None,
        }
    }
}

/// 画风锁定。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StyleLock {
    pub prompt_template: String,
    pub ref_images: Vec<String>,
    pub seed: Option<i64>,
}

/// 资产集合。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Assets {
    pub characters: Vec<Character>,
    pub scenes: Vec<SceneAsset>,
    pub props: Vec<Prop>,
    pub style_lock: StyleLock,
}

// ---------- 任务 / 模板引用 / 导出记录 ----------

/// 生成任务（M7）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub kind: TaskKind,
    pub provider: String,
    pub request: serde_json::Value,
    pub status: TaskStatus,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub created_at: String,
}

impl Default for Task {
    fn default() -> Self {
        Self {
            id: new_id(),
            kind: TaskKind::Video,
            provider: String::new(),
            request: serde_json::Value::Null,
            status: TaskStatus::Queued,
            result: None,
            error: None,
            created_at: now_iso(),
        }
    }
}

/// 引用的模板 id（模板本体存全局模板库，不复制进项目）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TemplateRef {
    pub id: String,
    pub kind: String,
}

/// 导出历史。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExportRecord {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub created_at: String,
}

// ---------- 项目根 ----------

/// 项目根结构，`project.json` 的唯一真相源。
///
/// 逐字段 `#[serde(default)]`（而非容器级）：缺失字段按各自类型回落，
/// 不会凭空造出一个"新项目"（`Project::default()` 语义是新建，不是空值）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub meta: Meta,
    #[serde(default)]
    pub script: Script,
    #[serde(default)]
    pub episodes: Vec<Episode>,
    #[serde(default)]
    pub assets: Assets,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub template_refs: Vec<TemplateRef>,
    #[serde(default)]
    pub exports: Vec<ExportRecord>,
}

impl Default for Project {
    fn default() -> Self {
        Self::new("未命名项目", WorkKind::default())
    }
}

impl Project {
    /// 新建项目：短剧与短视频都先建一个默认集（短视频即"主片"）。
    pub fn new(name: impl Into<String>, kind: WorkKind) -> Self {
        let now = now_iso();
        let name = name.into();
        let mut meta = Meta::default();
        meta.title = name.clone();
        meta.kind = kind;
        Self {
            schema_version: SCHEMA_VERSION,
            id: new_id(),
            name,
            created_at: now.clone(),
            updated_at: now,
            meta,
            script: Script::default(),
            episodes: vec![Episode::new(1, "主片")],
            assets: Assets::default(),
            tasks: Vec::new(),
            template_refs: Vec::new(),
            exports: Vec::new(),
        }
    }

    /// 刷新 `updatedAt`。保存前调用。
    pub fn touch(&mut self) {
        self.updated_at = now_iso();
    }

    /// 当前作品类型的默认（也是唯一）集；短视频退化场景下的取数入口。
    pub fn main_episode(&self) -> Option<&Episode> {
        self.episodes.first()
    }
}
