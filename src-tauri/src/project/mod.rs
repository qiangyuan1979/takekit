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
pub const SCHEMA_VERSION: u32 = 3;

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
    /// 配音（TTS，M9）。
    Tts,
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

// ---------- 后期出片（spec §5.8，M9） ----------
//
// 设计取舍：应用自身不调用 ffmpeg（跨平台二进制体积 / 网络下载风险），
// 而是把"片段轨 / 配音轨 / 字幕轨 / BGM 轨"落成结构化时间线，
// 再由 `commands::post` 导出可直接运行的剪辑工程包。以下结构即该工程包的数据源。

/// 配音句（spec §5.8.1）。
///
/// 由剧本台词 / 旁白派生，一句一条；`audio_path` 为采用后的音频文件
/// （项目相对路径，正斜杠）。对白与旁白用 `is_narration` 分轨。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceLine {
    pub id: String,
    pub episode_id: String,
    pub scene_id: String,
    pub shot_id: String,
    /// 全局镜号（跨集连续），冗余保存便于工程包直读。
    pub shot_no: u32,
    /// 角色 id；旁白为空。
    pub character_id: String,
    pub text: String,
    pub is_narration: bool,
    /// 音色（生成时取自角色卡，快照保存，改角色卡不影响已生成句）。
    pub voice: String,
    /// 情绪标注（如"平静 / 激动"），拼进 TTS 请求。
    pub emotion: String,
    /// 语速倍率（0.5–2.0）。
    pub speed: f64,
    /// 句尾停顿时长（毫秒），参与字幕与时间线对齐。
    pub pause_ms: u64,
    /// 采用的音频（项目相对路径）。
    pub audio_path: Option<String>,
    /// 采用音频的实测时长（毫秒，生成后回填）。
    pub duration_ms: u64,
}

impl Default for VoiceLine {
    fn default() -> Self {
        Self {
            id: new_id(),
            episode_id: String::new(),
            scene_id: String::new(),
            shot_id: String::new(),
            shot_no: 0,
            character_id: String::new(),
            text: String::new(),
            is_narration: false,
            voice: String::new(),
            emotion: String::new(),
            speed: 1.0,
            pause_ms: 0,
            audio_path: None,
            duration_ms: 0,
        }
    }
}

/// 字幕句（spec §5.8.3）。
///
/// 时间轴为全集内毫秒偏移；由配音句派生，可逐句微调起止时间。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SubtitleCue {
    pub id: String,
    pub episode_id: String,
    /// 关联配音句 id；纯手工字幕为空。
    pub voice_line_id: String,
    pub shot_id: String,
    pub shot_no: u32,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub enabled: bool,
}

impl Default for SubtitleCue {
    fn default() -> Self {
        Self {
            id: new_id(),
            episode_id: String::new(),
            voice_line_id: String::new(),
            shot_id: String::new(),
            shot_no: 0,
            text: String::new(),
            start_ms: 0,
            end_ms: 0,
            enabled: true,
        }
    }
}

/// 字幕样式模板（spec §5.8.3）。内置默认值贴合竖屏安全区。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SubtitleStyle {
    /// 预设名（默认 / 描边 / 竖屏安全）。
    pub preset: String,
    pub font: String,
    pub font_size: u32,
    /// 主色，`#RRGGBB`。
    pub color: String,
    pub outline_color: String,
    pub outline_width: u32,
    /// 位置：`bottom` / `center` / `top`。
    pub position: String,
    /// 竖屏安全区：距最近边的百分比。
    pub safe_margin_percent: u32,
    /// 是否把字幕烧制进画面（false 则只出软字幕）。
    pub burn_in: bool,
}

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            preset: "默认".into(),
            font: "思源黑体".into(),
            font_size: 48,
            color: "#FFFFFF".into(),
            outline_color: "#000000".into(),
            outline_width: 2,
            position: "bottom".into(),
            safe_margin_percent: 12,
            burn_in: false,
        }
    }
}

/// BGM 轨（spec §5.8.4）。全片一条，从素材库选曲。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BgmTrack {
    /// 素材库条目 id（为空表示手工路径）。
    pub material_id: String,
    pub name: String,
    /// 项目相对路径或素材绝对路径。
    pub path: String,
    /// 正常音量（0–100）。
    pub volume: u32,
    /// 是否开启对白音量闪避。
    pub ducking: bool,
    /// 闪避时压低到的音量（0–100）。
    pub duck_volume: u32,
    /// 是否循环铺满全片。
    pub looping: bool,
}

/// 音效挂接（spec §5.8.4）。分镜「音效提示」字段一键挂接素材库音效。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SfxCue {
    pub id: String,
    pub episode_id: String,
    pub shot_id: String,
    pub shot_no: u32,
    /// 分镜「音效提示」原文，保留以便人工核对。
    pub hint: String,
    pub material_id: String,
    pub path: String,
    /// 触发时间（全集时间轴毫秒）。
    pub at_ms: u64,
    pub volume: u32,
}

impl Default for SfxCue {
    fn default() -> Self {
        Self {
            id: new_id(),
            episode_id: String::new(),
            shot_id: String::new(),
            shot_no: 0,
            hint: String::new(),
            material_id: String::new(),
            path: String::new(),
            at_ms: 0,
            volume: 100,
        }
    }
}

/// 时间线片段（片段轨，spec §5.8.5）。按镜序拼接，转场取自分镜字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TimelineClip {
    pub id: String,
    pub episode_id: String,
    pub scene_id: String,
    pub shot_id: String,
    pub shot_no: u32,
    /// 采用的片段（项目相对路径）。
    pub clip_path: String,
    /// 全集时间轴起始（毫秒）。
    pub start_ms: u64,
    pub duration_ms: u64,
    /// 本片段的出场转场（取自 `Shot.transition`）。
    pub transition: Transition,
}

impl Default for TimelineClip {
    fn default() -> Self {
        Self {
            id: new_id(),
            episode_id: String::new(),
            scene_id: String::new(),
            shot_id: String::new(),
            shot_no: 0,
            clip_path: String::new(),
            start_ms: 0,
            duration_ms: 0,
            transition: Transition::default(),
        }
    }
}

/// 对口型清单项（spec §5.8.2）。
///
/// 应用不内置对口型模型，故只产出「采用片段 + 该句配音」的配对清单，
/// 随工程包交给外部工具（或后续接入 provider）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LipsyncCue {
    pub id: String,
    pub episode_id: String,
    pub shot_id: String,
    pub shot_no: u32,
    /// 关联配音句 id。
    pub voice_line_id: String,
    /// 采用的片段（项目相对路径）。
    pub clip_path: String,
    /// 配音音频（项目相对路径）。
    pub audio_path: String,
    /// 是否启用（仅角色正面口型镜头启用）。
    pub enabled: bool,
    /// 由哪个线索判定启用（如 `front_face`），便于 UI 说明。
    pub reason: String,
}

impl Default for LipsyncCue {
    fn default() -> Self {
        Self {
            id: new_id(),
            episode_id: String::new(),
            shot_id: String::new(),
            shot_no: 0,
            voice_line_id: String::new(),
            clip_path: String::new(),
            audio_path: String::new(),
            enabled: true,
            reason: String::new(),
        }
    }
}

/// 后期出片数据根（spec §5.8）。挂到 `Project.post`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Post {
    pub voice_lines: Vec<VoiceLine>,
    pub subtitles: Vec<SubtitleCue>,
    pub subtitle_style: SubtitleStyle,
    pub bgm: Option<BgmTrack>,
    pub sfx: Vec<SfxCue>,
    pub timeline: Vec<TimelineClip>,
    pub lipsync: Vec<LipsyncCue>,
    /// 导出预设 id（`douyin` / `bilibili` 等）。
    pub export_preset: String,
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
    #[serde(default)]
    pub post: Post,
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
            post: Post::default(),
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
