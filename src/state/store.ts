/**
 * 全局状态（Zustand）：当前项目 + 保存状态 + 当前步骤 + 设置。
 *
 * 数据流是单向的：右栏字段表单 → `updateMeta` → store → 防抖落盘。
 * 右栏永远是唯一真相源，AI 结果只能通过 `updateMeta` 写入。
 */

import { create } from "zustand";
import { api, toApiError, type ApiError } from "../lib/ipc";
import {
  defaultSettings,
  type AppSettings,
  type Meta,
  type Project,
  type RecentProject,
} from "../lib/types";
import type { StepId } from "./steps";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** 编辑停顿多久后自动落盘。 */
const AUTOSAVE_DELAY_MS = 600;

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

function cancelAutosave(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

function scheduleAutosave(): void {
  cancelAutosave();
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void useAppStore.getState().save();
  }, AUTOSAVE_DELAY_MS);
}

/** 最近项目列表属于非关键路径，取不到就保持原样。 */
async function fetchRecent(): Promise<RecentProject[]> {
  try {
    return await api.listRecentProjects();
  } catch {
    return [];
  }
}

export interface AppState {
  /** 首次启动的初始化是否完成（设置 + 最近项目）。 */
  ready: boolean;
  project: Project | null;
  projectPath: string | null;
  currentStep: StepId;
  saveState: SaveState;
  /** 每次编辑递增；保存返回时用于判断是否已被新编辑覆盖。 */
  revision: number;
  error: ApiError | null;
  recent: RecentProject[];
  settings: AppSettings;

  bootstrap: () => Promise<void>;
  createProject: (parentDir: string, name: string) => Promise<boolean>;
  openProject: (path: string) => Promise<boolean>;
  closeProject: () => void;
  setStep: (step: StepId) => void;
  updateMeta: (patch: Partial<Meta>) => void;
  updateSettings: (settings: AppSettings) => Promise<void>;
  save: () => Promise<void>;
  clearError: () => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  ready: false,
  project: null,
  projectPath: null,
  currentStep: "project",
  saveState: "idle",
  revision: 0,
  error: null,
  recent: [],
  settings: defaultSettings(),

  bootstrap: async () => {
    try {
      const [settings, recent] = await Promise.all([api.getSettings(), api.listRecentProjects()]);
      set({ settings, recent, ready: true });
    } catch (error) {
      set({ error: toApiError(error), ready: true });
    }
  },

  createProject: async (parentDir, name) => {
    try {
      const loaded = await api.createProject(parentDir, name);
      set({
        project: loaded.project,
        projectPath: loaded.path,
        currentStep: "project",
        saveState: "saved",
        revision: 0,
        error: null,
        recent: await fetchRecent(),
      });
      return true;
    } catch (error) {
      set({ error: toApiError(error) });
      return false;
    }
  },

  openProject: async (path) => {
    try {
      const loaded = await api.openProject(path);
      set({
        project: loaded.project,
        projectPath: loaded.path,
        currentStep: "project",
        saveState: "saved",
        revision: 0,
        error: null,
        recent: await fetchRecent(),
      });
      return true;
    } catch (error) {
      set({ error: toApiError(error) });
      return false;
    }
  },

  closeProject: () => {
    cancelAutosave();
    set({
      project: null,
      projectPath: null,
      currentStep: "project",
      saveState: "idle",
      revision: 0,
      error: null,
    });
  },

  setStep: (step) => set({ currentStep: step }),

  updateMeta: (patch) => {
    const { project, revision } = get();
    if (!project) return;
    set({
      project: { ...project, meta: { ...project.meta, ...patch } },
      saveState: "dirty",
      revision: revision + 1,
    });
    scheduleAutosave();
  },

  updateSettings: async (settings) => {
    try {
      const saved = await api.saveSettings(settings);
      set({ settings: saved, error: null });
    } catch (error) {
      set({ error: toApiError(error) });
    }
  },

  save: async () => {
    const { project, projectPath, revision } = get();
    if (!project || !projectPath) return;
    set({ saveState: "saving" });
    try {
      const saved = await api.saveProject(projectPath, project);
      if (get().revision === revision) {
        set({ project: saved, saveState: "saved", error: null });
      } else {
        // 保存期间又发生了新编辑：保留本地版本，稍后再存一次。
        set({ saveState: "dirty" });
        scheduleAutosave();
      }
    } catch (error) {
      set({ saveState: "error", error: toApiError(error) });
    }
  },

  clearError: () => set({ error: null }),
}));
