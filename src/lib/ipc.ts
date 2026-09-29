/**
 * Tauri IPC 封装：把 Rust 侧 `AppError` 归一化成前端可翻译的错误对象。
 *
 * 约定：所有命令调用都走这里，组件里不直接 `invoke`，便于统一错误处理与测试替身。
 */

import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, LoadedProject, Project, RecentProject } from "./types";

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
};
