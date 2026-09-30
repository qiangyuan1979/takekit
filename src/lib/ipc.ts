/**
 * Tauri IPC 封装：把 Rust 侧 `AppError` 归一化成前端可翻译的错误对象。
 *
 * 约定：所有命令调用都走这里，组件里不直接 `invoke`，便于统一错误处理与测试替身。
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  AssetKind,
  ExportRecord,
  GenerateEvent,
  GenerateJob,
  LlmChunk,
  LlmRequest,
  LlmResponse,
  LoadedProject,
  Material,
  MaterialKind,
  Project,
  RecentProject,
  Template,
  VideoRequest,
} from "./types";

/** 与 Rust `AppError` 的序列化形状一致。 */
export interface ApiError {
  code: string;
  message: string;
  args?: Record<string, string>;
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ApiError>;
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

/** 任意抛出物 → `ApiError`（未知形态兜底为 `unknown`）。 */
export function toApiError(value: unknown): ApiError {
  if (isApiError(value)) return value;
  if (value instanceof Error) return { code: "unknown", message: value.message };
  return { code: "unknown", message: String(value) };
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    throw toApiError(error);
  }
}

/** 适配器翻译结果：provider 名、厂商请求体、翻译过程中的降级说明。 */
export interface Translated {
  provider: string;
  body: unknown;
  notes: string[];
}

/** 分镜表导入结果：覆盖后的项目 + 覆盖/跳过行数。 */
export interface ImportOutcome {
  project: Project;
  updated: number;
  skipped: number;
}

/** 交接包产物：目录、导出记录、包内相对文件清单。 */
export interface HandoverOutcome {
  dir: string;
  record: ExportRecord;
  files: string[];
}

/** 一次性生图的传输形态，字段名与 Rust `GenerateImageArgs` 一致。 */
export interface GenerateImageRequest {
  prompt: string;
  negativePrompt?: string | null;
  width: number;
  height: number;
  count: number;
  seed?: number | null;
  /** 参考图：项目相对路径。 */
  refImages?: string[];
}

export const api = {
  createProject: (parentDir: string, name: string) =>
    call<LoadedProject>("create_project", { parentDir, name }),

  openProject: (path: string) => call<LoadedProject>("open_project", { path }),

  /** 返回后端刷新过 `updatedAt` 的项目。 */
  saveProject: (path: string, project: Project) => call<Project>("save_project", { path, project }),

  listRecentProjects: () => call<RecentProject[]>("list_recent_projects"),

  duplicateProject: (path: string, parentDir: string, newName: string) =>
    call<LoadedProject>("duplicate_project", { path, parentDir, newName }),

  /** 归档：只把项目移出「最近打开」，磁盘上的文件不动。返回剩余列表。 */
  archiveProject: (path: string) => call<RecentProject[]>("archive_project", { path }),

  getSettings: () => call<AppSettings>("get_settings"),

  saveSettings: (settings: AppSettings) => call<AppSettings>("save_settings", { settings }),

  /** 一次性拿到完整回答（适合"生成结构化字段"，结果可整体解析）。 */
  llmComplete: (request: LlmRequest) => call<LlmResponse>("llm_complete", { request }),

  /** 流式回答：每个增量片段回调 `onEvent`，`done` 为真后不再回调。 */
  llmStream: async (request: LlmRequest, onEvent: (chunk: LlmChunk) => void): Promise<void> => {
    const channel = new Channel<LlmChunk>();
    channel.onmessage = onEvent;
    await call<void>("llm_stream", { request, onEvent: channel });
  },

  // ---- 资产图片（M3） ----

  /** 复制一张本地图片进资产目录，返回项目相对路径。 */
  importAssetImage: (projectPath: string, kind: AssetKind, ownerId: string, sourcePath: string) =>
    call<string>("import_asset_image", { projectPath, kind, ownerId, sourcePath }),

  /** 删除若干张项目内图片，返回实际删除数量（已不存在视为已删）。 */
  deleteAssetFiles: (projectPath: string, paths: string[]) =>
    call<number>("delete_asset_files", { projectPath, paths }),

  /** 删除某个资产的全部图片目录（删除资产卡时调用）。 */
  deleteAssetDir: (projectPath: string, kind: AssetKind, ownerId: string) =>
    call<void>("delete_asset_dir", { projectPath, kind, ownerId }),

  /** 生成候选图并落盘，返回项目相对路径列表（顺序即候选顺序）。 */
  generateAssetImages: (
    projectPath: string,
    kind: AssetKind,
    ownerId: string,
    request: GenerateImageRequest,
  ) => call<string[]>("generate_asset_images", { projectPath, kind, ownerId, request }),

  // ---- 出题 / 导出（M6） ----

  /** 当前支持的视频厂商（`kling` / `jimeng`）。 */
  listVideoProviders: () => call<string[]>("list_video_providers"),

  /** 把统一请求翻译成该家请求体；M6 只做纯翻译，不发 HTTP。 */
  translateVideoRequest: (provider: string, model: string, request: VideoRequest) =>
    call<Translated>("translate_video_request", { provider, model, request }),

  /** 导出分镜表，`format` 取 `csv` / `json` / `xlsx`；返回导出记录。 */
  exportStoryboard: (project: Project, format: string, destPath: string) =>
    call<ExportRecord>("export_storyboard", { project, format, destPath }),

  /** 导入分镜表覆盖项目；返回覆盖后的项目与覆盖/跳过行数。 */
  importStoryboard: (project: Project, sourcePath: string) =>
    call<ImportOutcome>("import_storyboard", { project, sourcePath }),

  /** 导出交接包到目录；返回目录、导出记录与包内文件清单。 */
  exportHandoverPack: (projectPath: string, project: Project, destDir: string) =>
    call<HandoverOutcome>("export_handover_pack", { projectPath, project, destDir }),

  // ---- 生成（M7） ----

  /** 可用生成器：`kling` / `jimeng` / `mock`（本地模拟，无 Key 也能跑通全流程）。 */
  listVideoGenerators: () => call<string[]>("list_video_generators"),

  /**
   * 跑一批生成任务：每个状态变化回调 `onEvent`，全部结束才 resolve。
   * 返回值是终态快照（与 `jobs` 同序），用来兜住漏收的事件。
   */
  generateClips: async (
    projectPath: string,
    provider: string,
    jobs: GenerateJob[],
    onEvent: (event: GenerateEvent) => void,
  ): Promise<GenerateEvent[]> => {
    const channel = new Channel<GenerateEvent>();
    channel.onmessage = onEvent;
    return call<GenerateEvent[]>("generate_clips", {
      projectPath,
      provider,
      jobs,
      onEvent: channel,
    });
  },

  /** 请求取消若干任务（软取消：下一轮轮询时收尾）；返回登记数量。 */
  cancelClipTasks: (taskIds: string[]) => call<number>("cancel_clip_tasks", { taskIds }),

  // ---- 模板库（M8） ----

  /** 全局模板库（应用数据目录，跨项目共享）；文件缺失或损坏时返回空表。 */
  listTemplates: () => call<Template[]>("list_templates"),

  /** 新增或按 id 覆盖一条模板，返回最新全量列表。 */
  saveTemplate: (template: Template) => call<Template[]>("save_template", { template }),

  /** 删除一条模板，返回最新全量列表。 */
  deleteTemplate: (id: string) => call<Template[]>("delete_template", { id }),

  // ---- 素材库（M8） ----

  /** 全局素材库（应用数据目录，跨项目共享）；文件缺失或损坏时返回空表。 */
  listMaterials: () => call<Material[]>("list_materials"),

  /** 把本地文件复制进素材库，返回最新全量列表。 */
  importMaterial: (kind: MaterialKind, sourcePath: string, name?: string) =>
    call<Material[]>("import_material", { kind, sourcePath, name: name ?? null }),

  /** 删除一条素材（连同实体文件），返回最新全量列表。 */
  deleteMaterial: (id: string) => call<Material[]>("delete_material", { id }),
};
