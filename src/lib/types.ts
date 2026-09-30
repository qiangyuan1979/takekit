/**
 * 与 Rust `src-tauri/src/project/mod.rs` 一一镜像的类型定义（camelCase）。
 *
 * 字段名与枚举字面量是对外契约：Rust 侧 `tests/project_roundtrip.rs` 会锁定
 * 序列化结果，这里改动必须同步改 Rust 并递增 `schemaVersion`。
 */

export const SCHEMA_VERSION = 2;

// ---------- 枚举（字面量与 Rust serde 输出一致） ----------

export type WorkKind = "short_drama" | "short_video";
export type AspectRatio = "9:16" | "16:9" | "1:1";
export type ShotSize =
  "extreme_long" | "long_shot" | "medium_shot" | "close_up" | "extreme_close_up";
export type CameraMove =
  "static_shot" | "push_in" | "pull_out" | "pan" | "truck" | "follow" | "crane" | "orbit";
export type Transition = "cut" | "dissolve" | "fade_in" | "fade_out" | "whip_pan";
export type FrameRole = "first" | "last";
export type TaskKind = "llm" | "image" | "video";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export const ASPECT_RATIOS: AspectRatio[] = ["9:16", "16:9", "1:1"];

// ---------- 立项参数 ----------

export interface Meta {
  // 卡1 作品定位
  title: string;
  kind: WorkKind;
  genre: string;
  platform: string;
  audience: string;

  // 卡2 规格参数
  aspectRatio: AspectRatio;
  resolution: string;
  fps: number;
  episodeDurationMs: number;
  /** 集数；`kind = short_video` 时隐藏且不参与下游。 */
  episodeCount: number;
  language: string;
  subtitleLanguage: string;

  // 卡3 风格锚点
  visualStyle: string;
  mood: string;
  styleKeywords: string[];
  styleRefImages: string[];

  // 卡4 生成默认配置
  defaultVideoModel: string;
  defaultImageModel: string;
  defaultLlm: string;
  defaultVoice: string;
  paramPreset: string;
}

/** 与 Rust `Meta::default()` 保持一致的新手推荐值。 */
export function defaultMeta(): Meta {
  return {
    title: "",
    kind: "short_drama",
    genre: "都市逆袭",
    platform: "抖音",
    audience: "",
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    episodeDurationMs: 60_000,
    episodeCount: 3,
    language: "zh-CN",
    subtitleLanguage: "zh-CN",
    visualStyle: "实拍写实感",
    mood: "爽",
    styleKeywords: [],
    styleRefImages: [],
    defaultVideoModel: "kling",
    defaultImageModel: "jimeng",
    defaultLlm: "openai-compat",
    defaultVoice: "女声·清冷",
    paramPreset: "标准",
  };
}

// ---------- 剧本 / 分镜 / 关键帧 ----------

/** 剧本 A 段（创意核）与 B 段（大纲）的字段载体；C 段在 `episodes[].scenes`。 */
export interface Script {
  /** 一句话故事。 */
  logline: string;
  coreConflict: string;
  protagonistGoal: string;
  obstacle: string;
  /** 爽点 / 钩子设计。 */
  hook: string;
  twist: string;
  /** 结构模板 id（空 = 按作品类型取默认）。 */
  structure: string;
  /** 已锁定的字段名，AI 重写时跳过。 */
  lockedFields: string[];
}

/** 与 Rust `Script::default()` 保持一致。 */
export function defaultScript(): Script {
  return {
    logline: "",
    coreConflict: "",
    protagonistGoal: "",
    obstacle: "",
    hook: "",
    twist: "",
    structure: "",
    lockedFields: [],
  };
}

export interface Dialogue {
  characterId: string;
  text: string;
  isNarration: boolean;
}

export interface Episode {
  id: string;
  no: number;
  title: string;
  summary: string;
  beats: string[];
  scenes: Scene[];
}

export interface Scene {
  id: string;
  no: number;
  location: string;
  timeOfDay: string;
  interior: boolean;
  characters: string[];
  actionDesc: string;
  dialogues: Dialogue[];
  shots: Shot[];
}

export interface Frame {
  id: string;
  role: FrameRole;
  candidates: string[];
  adopted: string | null;
  refShotId: string | null;
}

export interface Shot {
  id: string;
  episodeId: string;
  sceneId: string;
  no: number;
  shotSize: ShotSize;
  cameraMove: CameraMove;
  durationMs: number;
  visualDesc: string;
  characters: string[];
  dialogue: string | null;
  narration: string | null;
  sfxHint: string;
  transition: Transition;
  note: string;
  promptBundle: PromptBundle | null;
  adoptedClipId: string | null;
  frames: Frame[];
}

// ---------- 出题 ----------

export interface UnifiedPrompt {
  subject: string;
  environment: string;
  camera: string;
  lighting: string;
  style: string;
  quality: string;
}

export interface RefImage {
  path: string;
  weight: number;
}

export interface VideoParams {
  durationMs: number;
  aspectRatio: AspectRatio;
  resolution: string;
  fps: number;
  motionStrength: number;
  seed: number | null;
  negativePrompt: string;
  refImages: RefImage[];
  firstFrame: string | null;
  lastFrame: string | null;
}

export interface PromptBundle {
  unified: UnifiedPrompt;
  zh: string;
  en: string;
  params: VideoParams;
  /** provider 名 → 该家可用的请求体。 */
  perProvider: Record<string, unknown>;
}

// ---------- 资产 ----------

export interface Appearance {
  faceShape: string;
  hair: string;
  hairColor: string;
  eyeColor: string;
  height: string;
  body: string;
}

export interface Costume {
  id: string;
  name: string;
  description: string;
  refImage: string | null;
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  age: string;
  gender: string;
  appearance: Appearance;
  costumes: Costume[];
  personality: string;
  speechStyle: string;
  voice: string;
  refImages: string[];
  portrait: string | null;
}

export interface SceneAsset {
  id: string;
  name: string;
  interior: boolean;
  timeOfDay: string;
  weather: string;
  description: string;
  lighting: string;
  refImages: string[];
}

export interface Prop {
  id: string;
  name: string;
  description: string;
  refImage: string | null;
}

export interface StyleLock {
  promptTemplate: string;
  refImages: string[];
  seed: number | null;
}

export interface Assets {
  characters: Character[];
  scenes: SceneAsset[];
  props: Prop[];
  styleLock: StyleLock;
}

/**
 * 资产类别，字面量与 Rust `commands/asset.rs` 的 `AssetKind`
 * （`#[serde(rename_all = "snake_case")]`）一致，直接当 IPC 参数用。
 */
export type AssetKind = "character" | "scene" | "prop" | "style" | "frame";

// ---------- 任务 / 模板引用 / 导出记录 ----------

export interface Task {
  id: string;
  kind: TaskKind;
  provider: string;
  request: unknown;
  status: TaskStatus;
  result: unknown | null;
  error: string | null;
  createdAt: string;
}

export interface TemplateRef {
  id: string;
  kind: string;
}

export interface ExportRecord {
  id: string;
  kind: string;
  path: string;
  createdAt: string;
}

// ---------- 模板库（M8） ----------

/** 模板类别，字面量与 Rust `commands/template.rs` 的 `KINDS` 一致。 */
export type TemplateKind = "meta" | "script" | "storyboard" | "camera" | "prompt";

export const TEMPLATE_KINDS: TemplateKind[] = ["meta", "script", "storyboard", "camera", "prompt"];

/** 全局模板库条目；存在应用数据目录的 `templates.json`，跨项目复用。 */
export interface Template {
  id: string;
  kind: TemplateKind;
  name: string;
  description: string;
  /** 各 kind 自定义的载荷；白名单提取与校验在 `lib/templateOps.ts`。 */
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------- 素材库（M8） ----------

/** 素材类别，字面量与 Rust `commands/material.rs` 的 `MaterialKind` 一致。 */
export type MaterialKind = "image" | "audio" | "font";

export const MATERIAL_KINDS: MaterialKind[] = ["image", "audio", "font"];

/**
 * 全局素材库条目；存在应用数据目录（`materials.json` 索引 + `materials/` 实体文件），
 * 跨项目复用。`path` 是库内绝对路径，供 `convertFileSrc` 预览 / 作为导入源。
 */
export interface Material {
  id: string;
  kind: MaterialKind;
  name: string;
  /** 小写扩展名，决定实体文件名后缀（`{id}.{ext}`）。 */
  ext: string;
  bytes: number;
  path: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- 项目根 ----------
export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  meta: Meta;
  script: Script;
  episodes: Episode[];
  assets: Assets;
  tasks: Task[];
  templateRefs: TemplateRef[];
  exports: ExportRecord[];
}

// ---------- 命令返回 / 设置 ----------

/** `create_project` / `open_project` / `duplicate_project` 的返回。 */
export interface LoadedProject {
  project: Project;
  path: string;
}

export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

export interface ProviderConfig {
  baseUrl: string;
  /** 仅存在于前端内存与密钥库；不会写进 settings.json。 */
  apiKey: string;
  model: string;
}

/** LLM 生成参数（只作用于文本模型）。 */
export interface LlmOptions {
  temperature: number;
  maxTokens: number;
}

export interface AppSettings {
  llm: ProviderConfig;
  llmOptions: LlmOptions;
  image: ProviderConfig;
  video: ProviderConfig;
  language: string;
  /** 界面字体：`""` 跟随系统，`sans`/`serif`/`kai` 内置，`font:<素材 id>` 取自素材库。 */
  uiFont: string;
  onboardingEnabled: boolean;
}

/** 后端尚未应答时的占位设置（`get_settings` 会返回权威默认值）。 */
export function defaultSettings(): AppSettings {
  return {
    llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
    llmOptions: { temperature: 0.8, maxTokens: 2048 },
    image: { baseUrl: "", apiKey: "", model: "" },
    video: { baseUrl: "", apiKey: "", model: "" },
    language: "zh-CN",
    uiFont: "",
    onboardingEnabled: true,
  };
}

// ---------- LLM 适配器（镜像 Rust `adapters/llm/mod.rs`） ----------

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

/** 省略 `temperature` / `maxTokens` 时由后端用设置里的默认值补齐。 */
export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number | null;
  maxTokens?: number | null;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  content: string;
  model: string;
  usage: LlmUsage;
}

/** 流式增量片段；`done` 为真后流即结束。 */
export interface LlmChunk {
  delta: string;
  done: boolean;
}

// ---------- 生成（M7，镜像 Rust `commands/generate.rs`） ----------

/** 统一视频请求：拼好的提示词 + 参数，交给后端适配器翻译 / 执行。 */
export interface VideoRequest {
  prompt: string;
  params: VideoParams;
}

/** 生成任务存的请求载荷：统一请求 + 三层定位（分组、归档命名都靠它）。 */
export interface VideoTaskRequest extends VideoRequest {
  episodeId: string;
  sceneId: string;
  shotId: string;
  /** 项目内全局镜号（跨集 / 场连续），后端据此归档 `clips/<镜号>_<版本>.<ext>`。 */
  shotNo: number;
}

/** `generate_clips` 的一条作业；字段名与 Rust `GenerateJob` 严格一致。 */
export interface GenerateJob {
  taskId: string;
  shotNo: number;
  request: VideoRequest;
}

/** 进度事件；字段名与 Rust `GenerateEvent` 严格一致（枚举字面量见 `TaskStatus`）。 */
export interface GenerateEvent {
  taskId: string;
  status: TaskStatus;
  /** 成功时为项目相对路径（如 `clips/007_01.mp4`）。 */
  clipPath?: string | null;
  mime?: string | null;
  /** 厂商原文或英文消息，仅供日志与兜底展示。 */
  error?: string | null;
  /** 用户可见文案由前端按 `code` 翻译（见 `i18n.ts`）。 */
  errorCode?: string | null;
  errorArgs?: Record<string, string> | null;
}

/** 任务产物的判别联合：成功是片段，失败是错误码 + 翻译参数。 */
export type TaskResult =
  | { kind: "clip"; path: string; mime: string }
  | { kind: "error"; code: string; args?: Record<string, string> };
