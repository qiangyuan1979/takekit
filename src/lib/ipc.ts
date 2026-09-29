/**
 * Tauri IPC 封装：把 Rust 侧 `AppError` 归一化成前端可翻译的错误对象。
 *
 * 约定：所有命令调用都走这里，组件里不直接 `invoke`，便于统一错误处理与测试替身。
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  AssetKind,
  LlmChunk,
  LlmRequest,
  LlmResponse,
  LoadedProject,
  Project,
  RecentProject,
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

  duplicateProject: (path: string, newName: string) =>
    call<LoadedProject>("duplicate_project", { path, newName }),

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
};
