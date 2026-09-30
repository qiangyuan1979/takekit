/**
 * 全局状态（Zustand）：当前项目 + 保存状态 + 当前步骤 + 设置。
 *
 * 数据流是单向的：右栏字段表单 → store 写回动作 → 防抖落盘。
 * 右栏永远是唯一真相源，AI 结果也只能经由 `applyScriptPatch` / `applyEpisodePatch`
 * 等动作写入——那两个动作是字段锁的唯一生效点。
 */

import { create } from "zustand";
import { makeCharacter, makeProp, makeSceneAsset } from "../lib/assetOps";
import {
  addCandidates as appendCandidates,
  adoptCandidate,
  detachCandidate,
  ensureFrame,
  frameByRole,
  setFrameRefShot as assignRefShot,
  updateFrame,
} from "../lib/frameOps";
import { api, toApiError, type ApiError } from "../lib/ipc";
import {
  makeEpisode,
  makeScene,
  moveScene as reorderScene,
  renumberEpisodes,
  renumberScenes,
  undefinedCharacterRefs,
} from "../lib/scriptOps";
import {
  BEATS_LOCK_KEY,
  SCRIPT_FIELDS,
  fillScriptTemplate,
  structureById,
  templateEpisode,
} from "../lib/scriptTemplates";
import { makeShot, moveShots as reorderShot, renumberShots } from "../lib/shotOps";
import {
  defaultSettings,
  type AppSettings,
  type AssetKind,
  type Character,
  type Episode,
  type FrameRole,
  type Meta,
  type Project,
  type Prop,
  type RecentProject,
  type Scene,
  type SceneAsset,
  type Script,
  type Shot,
  type StyleLock,
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

// ---------- 资产写回的局部替换助手 ----------

function replaceCharacter(
  project: Project,
  id: string,
  change: (character: Character) => Character,
): Project {
  return {
    ...project,
    assets: {
      ...project.assets,
      characters: project.assets.characters.map((character) =>
        character.id === id ? change(character) : character,
      ),
    },
  };
}

function replaceScene(
  project: Project,
  id: string,
  change: (scene: SceneAsset) => SceneAsset,
): Project {
  return {
    ...project,
    assets: {
      ...project.assets,
      scenes: project.assets.scenes.map((scene) => (scene.id === id ? change(scene) : scene)),
    },
  };
}

function replaceProp(project: Project, id: string, change: (prop: Prop) => Prop): Project {
  return {
    ...project,
    assets: {
      ...project.assets,
      props: project.assets.props.map((prop) => (prop.id === id ? change(prop) : prop)),
    },
  };
}

function replaceStyleLock(project: Project, change: (styleLock: StyleLock) => StyleLock): Project {
  return { ...project, assets: { ...project.assets, styleLock: change(project.assets.styleLock) } };
}

/** 定位到某一场，把它的镜头列表换掉（镜号重排由调用方决定）。 */
function replaceSceneShots(
  project: Project,
  episodeId: string,
  sceneId: string,
  change: (shots: Shot[]) => Shot[],
): Project {
  return {
    ...project,
    episodes: project.episodes.map((episode) =>
      episode.id === episodeId
        ? {
            ...episode,
            scenes: episode.scenes.map((scene) =>
              scene.id === sceneId ? { ...scene, shots: change(scene.shots) } : scene,
            ),
          }
        : episode,
    ),
  };
}

/** 定位到某个镜头并替换它：帧的增删改都经过这里，避免一路 map 嵌套。 */
function replaceShot(
  project: Project,
  episodeId: string,
  sceneId: string,
  shotId: string,
  change: (shot: Shot) => Shot,
): Project {
  return replaceSceneShots(project, episodeId, sceneId, (shots) =>
    shots.map((shot) => (shot.id === shotId ? change(shot) : shot)),
  );
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
  /** 把 IO / 编排层抛出的任意错误挂到全局错误条上。 */
  reportError: (error: unknown) => void;

  // ---- 剧本（M2） ----
  updateScript: (patch: Partial<Script>) => void;
  updateEpisode: (episodeId: string, patch: Partial<Episode>) => void;
  updateScene: (episodeId: string, sceneId: string, patch: Partial<Scene>) => void;
  /** 切换某个字段的锁（A 段字段名，或 B 段的 `beats`）。 */
  toggleFieldLock: (field: string) => void;
  addEpisode: () => void;
  removeEpisode: (episodeId: string) => void;
  addScene: (episodeId: string) => void;
  removeScene: (episodeId: string, sceneId: string) => void;
  moveScene: (episodeId: string, sceneId: string, delta: number) => void;
  /** AI 回填 A 段：跳过已锁字段，且只认 6 个 A 段字段。 */
  applyScriptPatch: (patch: Partial<Script>) => void;
  /** AI 回填 B 段：节拍被锁时忽略模型给出的 beats。 */
  applyEpisodePatch: (episodeId: string, patch: Partial<Episode>) => void;
  /** 离线模板填充：只填空字段、尊重锁，一集都没有时才建一集。 */
  fillFromTemplate: () => void;

  // ---- 资产（M3） ----

  addCharacter: (name: string) => void;
  updateCharacter: (id: string, patch: Partial<Character>) => void;
  removeCharacter: (id: string) => void;
  /** 指定定妆基准图（必须是该角色已有的一张参考图）。 */
  setCharacterPortrait: (id: string, path: string) => void;

  addSceneAsset: (name: string) => void;
  updateSceneAsset: (id: string, patch: Partial<SceneAsset>) => void;
  removeSceneAsset: (id: string) => void;

  addProp: (name: string) => void;
  updateProp: (id: string, patch: Partial<Prop>) => void;
  removeProp: (id: string) => void;

  updateStyleLock: (patch: Partial<StyleLock>) => void;

  /** 把 C 段出现、但还没有角色卡的名字一键建档（重复调用幂等）。 */
  fillCharactersFromScript: () => void;

  /**
   * 图片落盘之后写回引用。顺序不能颠倒：文件先存在，`project.json` 才敢引用它。
   * `kind = character` 时 `asPrimary` 会同时把第一张指定为定妆基准。
   */
  attachAssetImages: (
    kind: AssetKind,
    ownerId: string,
    paths: string[],
    options?: { asPrimary?: boolean },
  ) => void;

  /** 摘掉一张图的引用；`project.json` 先断开，文件删除由编排层随后完成。 */
  detachAssetImage: (kind: AssetKind, ownerId: string, path: string) => void;

  // ---- 分镜（M4） ----

  /** 整场替换镜头列表：离线拆镜与 AI 拆镜的落地点（传 `[]` 即清空本场）。 */
  setSceneShots: (episodeId: string, sceneId: string, shots: Shot[]) => void;
  addShot: (episodeId: string, sceneId: string, patch?: Partial<Shot>) => void;
  updateShot: (episodeId: string, sceneId: string, shotId: string, patch: Partial<Shot>) => void;
  removeShot: (episodeId: string, sceneId: string, shotId: string) => void;
  moveShot: (episodeId: string, sceneId: string, shotId: string, delta: number) => void;
  /** 跨场批量改：表格视图里勾选多镜后统一设置景别 / 运镜 / 时长。 */
  updateManyShots: (episodeId: string, shotIds: string[], patch: Partial<Shot>) => void;

  // ---- 关键帧（M5） ----

  /** 补建某个角色的帧（首帧必需、尾帧按需）；已有则原样不动。 */
  ensureShotFrame: (episodeId: string, sceneId: string, shotId: string, role: FrameRole) => void;
  /** 候选图落盘后写回：追加去重（与资产图一样，先落盘再引用）。 */
  addFrameCandidates: (
    episodeId: string,
    sceneId: string,
    shotId: string,
    role: FrameRole,
    paths: string[],
  ) => void;
  /** 把某张候选定为该帧的定稿。 */
  adoptFrame: (
    episodeId: string,
    sceneId: string,
    shotId: string,
    role: FrameRole,
    path: string,
  ) => void;
  /** 摘掉一张候选；它正好是定稿时，定稿一并清空。 */
  detachFrameCandidate: (
    episodeId: string,
    sceneId: string,
    shotId: string,
    role: FrameRole,
    path: string,
  ) => void;
  /** 设置 / 解除跨镜参考（存被引用镜头的 id）。 */
  setFrameRefShot: (
    episodeId: string,
    sceneId: string,
    shotId: string,
    role: FrameRole,
    refShotId: string | null,
  ) => void;
}

export const useAppStore = create<AppState>()((set, get) => {
  /** 所有右栏写回的公共路径：换 project → 标脏 → 递增 revision → 防抖落盘。 */
  const mutate = (change: (project: Project) => Project): void => {
    const { project, revision } = get();
    if (!project) return;
    set({ project: change(project), saveState: "dirty", revision: revision + 1 });
    scheduleAutosave();
  };

  return {
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

    updateMeta: (patch) =>
      mutate((project) => ({ ...project, meta: { ...project.meta, ...patch } })),

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

    reportError: (error) => set({ error: toApiError(error) }),

    // ---- 剧本（M2） ----

    updateScript: (patch) =>
      mutate((project) => ({ ...project, script: { ...project.script, ...patch } })),

    updateEpisode: (episodeId, patch) =>
      mutate((project) => ({
        ...project,
        episodes: project.episodes.map((episode) =>
          episode.id === episodeId ? { ...episode, ...patch } : episode,
        ),
      })),

    updateScene: (episodeId, sceneId, patch) =>
      mutate((project) => ({
        ...project,
        episodes: project.episodes.map((episode) =>
          episode.id === episodeId
            ? {
                ...episode,
                scenes: episode.scenes.map((scene) =>
                  scene.id === sceneId ? { ...scene, ...patch } : scene,
                ),
              }
            : episode,
        ),
      })),

    toggleFieldLock: (field) =>
      mutate((project) => {
        const locked = project.script.lockedFields;
        const next = locked.includes(field)
          ? locked.filter((item) => item !== field)
          : [...locked, field];
        return { ...project, script: { ...project.script, lockedFields: next } };
      }),

    addEpisode: () =>
      mutate((project) => ({
        ...project,
        episodes: [...project.episodes, makeEpisode(project.episodes.length + 1)],
      })),

    removeEpisode: (episodeId) =>
      mutate((project) => ({
        ...project,
        episodes: renumberEpisodes(project.episodes.filter((episode) => episode.id !== episodeId)),
      })),

    addScene: (episodeId) =>
      mutate((project) => ({
        ...project,
        episodes: project.episodes.map((episode) =>
          episode.id === episodeId
            ? {
                ...episode,
                scenes: [...episode.scenes, makeScene({ no: episode.scenes.length + 1 })],
              }
            : episode,
        ),
      })),

    removeScene: (episodeId, sceneId) =>
      mutate((project) => ({
        ...project,
        episodes: project.episodes.map((episode) =>
          episode.id === episodeId
            ? {
                ...episode,
                scenes: renumberScenes(episode.scenes.filter((scene) => scene.id !== sceneId)),
              }
            : episode,
        ),
      })),

    moveScene: (episodeId, sceneId, delta) =>
      mutate((project) => ({
        ...project,
        episodes: project.episodes.map((episode) =>
          episode.id === episodeId
            ? { ...episode, scenes: reorderScene(episode.scenes, sceneId, delta) }
            : episode,
        ),
      })),

    applyScriptPatch: (patch) =>
      mutate((project) => {
        const locked = new Set(project.script.lockedFields);
        const next: Script = { ...project.script };
        // 只认 A 段 6 个字段：`structure` 是用户的选择，`lockedFields` 是锁本身，
        // 都不允许模型改写。
        for (const { key } of SCRIPT_FIELDS) {
          if (locked.has(key)) continue;
          const value = patch[key];
          if (typeof value === "string" && value.trim()) next[key] = value;
        }
        return { ...project, script: next };
      }),

    applyEpisodePatch: (episodeId, patch) =>
      mutate((project) => ({
        ...project,
        episodes: project.episodes.map((episode) => {
          if (episode.id !== episodeId) return episode;
          const next: Episode = { ...episode, ...patch };
          if (project.script.lockedFields.includes(BEATS_LOCK_KEY)) next.beats = episode.beats;
          return next;
        }),
      })),

    fillFromTemplate: () =>
      mutate((project) => {
        const structure = structureById(project.script.structure, project.meta.kind);
        const draft = fillScriptTemplate(project.meta);
        const locked = new Set(project.script.lockedFields);

        const script: Script = {
          ...project.script,
          structure: project.script.structure || structure.id,
        };
        for (const { key } of SCRIPT_FIELDS) {
          if (locked.has(key) || script[key].trim()) continue;
          script[key] = draft[key];
        }

        return {
          ...project,
          script,
          episodes:
            project.episodes.length > 0
              ? project.episodes
              : [templateEpisode(project.meta, structure, 1)],
        };
      }),

    // ---- 资产（M3） ----

    addCharacter: (name) =>
      mutate((project) => ({
        ...project,
        assets: {
          ...project.assets,
          characters: [...project.assets.characters, makeCharacter(name)],
        },
      })),

    updateCharacter: (id, patch) =>
      mutate((project) =>
        replaceCharacter(project, id, (character) => ({ ...character, ...patch })),
      ),

    removeCharacter: (id) =>
      mutate((project) => ({
        ...project,
        assets: {
          ...project.assets,
          characters: project.assets.characters.filter((character) => character.id !== id),
        },
      })),

    setCharacterPortrait: (id, path) =>
      mutate((project) =>
        replaceCharacter(project, id, (character) => ({ ...character, portrait: path })),
      ),

    addSceneAsset: (name) =>
      mutate((project) => ({
        ...project,
        assets: { ...project.assets, scenes: [...project.assets.scenes, makeSceneAsset(name)] },
      })),

    updateSceneAsset: (id, patch) =>
      mutate((project) => replaceScene(project, id, (scene) => ({ ...scene, ...patch }))),

    removeSceneAsset: (id) =>
      mutate((project) => ({
        ...project,
        assets: {
          ...project.assets,
          scenes: project.assets.scenes.filter((scene) => scene.id !== id),
        },
      })),

    addProp: (name) =>
      mutate((project) => ({
        ...project,
        assets: { ...project.assets, props: [...project.assets.props, makeProp(name)] },
      })),

    updateProp: (id, patch) =>
      mutate((project) => replaceProp(project, id, (prop) => ({ ...prop, ...patch }))),

    removeProp: (id) =>
      mutate((project) => ({
        ...project,
        assets: { ...project.assets, props: project.assets.props.filter((prop) => prop.id !== id) },
      })),

    updateStyleLock: (patch) =>
      mutate((project) => replaceStyleLock(project, (styleLock) => ({ ...styleLock, ...patch }))),

    fillCharactersFromScript: () =>
      mutate((project) => {
        const pending = undefinedCharacterRefs(project);
        if (pending.length === 0) return project;
        return {
          ...project,
          assets: {
            ...project.assets,
            characters: [
              ...project.assets.characters,
              ...pending.map((name) => makeCharacter(name)),
            ],
          },
        };
      }),

    attachAssetImages: (kind, ownerId, paths, options) => {
      if (paths.length === 0) return;
      const asPrimary = options?.asPrimary === true;
      mutate((project) => {
        switch (kind) {
          case "character":
            return replaceCharacter(project, ownerId, (character) => ({
              ...character,
              refImages: [...character.refImages, ...paths],
              portrait: asPrimary || !character.portrait ? paths[0] : character.portrait,
            }));
          case "scene":
            return replaceScene(project, ownerId, (scene) => ({
              ...scene,
              refImages: [...scene.refImages, ...paths],
            }));
          case "prop":
            return replaceProp(project, ownerId, (prop) => ({ ...prop, refImage: paths[0] }));
          case "style":
            return replaceStyleLock(project, (styleLock) => ({
              ...styleLock,
              refImages: [...styleLock.refImages, ...paths],
            }));
          case "frame":
            // 关键帧候选存在 `shot.frames[role].candidates` 里，不走资产写回。
            return project;
        }
      });
    },

    detachAssetImage: (kind, ownerId, path) =>
      mutate((project) => {
        switch (kind) {
          case "character":
            return replaceCharacter(project, ownerId, (character) => {
              const refImages = character.refImages.filter((item) => item !== path);
              return {
                ...character,
                refImages,
                // 被摘掉的正好是定妆基准：顺位到剩下第一张，没有就清空。
                portrait: character.portrait === path ? (refImages[0] ?? null) : character.portrait,
              };
            });
          case "scene":
            return replaceScene(project, ownerId, (scene) => ({
              ...scene,
              refImages: scene.refImages.filter((item) => item !== path),
            }));
          case "prop":
            return replaceProp(project, ownerId, (prop) =>
              prop.refImage === path ? { ...prop, refImage: null } : prop,
            );
          case "style":
            return replaceStyleLock(project, (styleLock) => ({
              ...styleLock,
              refImages: styleLock.refImages.filter((item) => item !== path),
            }));
          case "frame":
            // 同 `attachAssetImages`：关键帧候选不在资产里。
            return project;
        }
      }),

    // ---- 分镜（M4） ----

    setSceneShots: (episodeId, sceneId, shots) =>
      mutate((project) =>
        replaceSceneShots(project, episodeId, sceneId, () => renumberShots(shots)),
      ),

    addShot: (episodeId, sceneId, patch) =>
      mutate((project) =>
        replaceSceneShots(project, episodeId, sceneId, (shots) =>
          renumberShots([...shots, makeShot({ ...patch, episodeId, sceneId })]),
        ),
      ),

    updateShot: (episodeId, sceneId, shotId, patch) =>
      mutate((project) =>
        replaceSceneShots(project, episodeId, sceneId, (shots) =>
          shots.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)),
        ),
      ),

    removeShot: (episodeId, sceneId, shotId) =>
      mutate((project) =>
        replaceSceneShots(project, episodeId, sceneId, (shots) =>
          renumberShots(shots.filter((shot) => shot.id !== shotId)),
        ),
      ),

    moveShot: (episodeId, sceneId, shotId, delta) =>
      mutate((project) =>
        replaceSceneShots(project, episodeId, sceneId, (shots) =>
          reorderShot(shots, shotId, delta),
        ),
      ),

    updateManyShots: (episodeId, shotIds, patch) =>
      mutate((project) => {
        if (shotIds.length === 0) return project;
        const ids = new Set(shotIds);
        return {
          ...project,
          episodes: project.episodes.map((episode) =>
            episode.id === episodeId
              ? {
                  ...episode,
                  scenes: episode.scenes.map((scene) =>
                    scene.shots.some((shot) => ids.has(shot.id))
                      ? {
                          ...scene,
                          shots: scene.shots.map((shot) =>
                            ids.has(shot.id) ? { ...shot, ...patch } : shot,
                          ),
                        }
                      : scene,
                  ),
                }
              : episode,
          ),
        };
      }),

    // ---- 关键帧（M5） ----

    ensureShotFrame: (episodeId, sceneId, shotId, role) =>
      mutate((project) =>
        replaceShot(project, episodeId, sceneId, shotId, (shot) => ensureFrame(shot, role)),
      ),

    addFrameCandidates: (episodeId, sceneId, shotId, role, paths) => {
      if (paths.length === 0) return;
      mutate((project) =>
        replaceShot(project, episodeId, sceneId, shotId, (shot) =>
          updateFrame(shot, role, (frame) => appendCandidates(frame, paths)),
        ),
      );
    },

    adoptFrame: (episodeId, sceneId, shotId, role, path) =>
      mutate((project) =>
        replaceShot(project, episodeId, sceneId, shotId, (shot) =>
          updateFrame(shot, role, (frame) => adoptCandidate(frame, path)),
        ),
      ),

    detachFrameCandidate: (episodeId, sceneId, shotId, role, path) =>
      mutate((project) =>
        replaceShot(project, episodeId, sceneId, shotId, (shot) =>
          // 帧还不存在时不动手，避免"摘一张不存在的图"顺手建出一个空帧。
          frameByRole(shot, role)
            ? updateFrame(shot, role, (frame) => detachCandidate(frame, path))
            : shot,
        ),
      ),

    setFrameRefShot: (episodeId, sceneId, shotId, role, refShotId) =>
      mutate((project) =>
        replaceShot(project, episodeId, sceneId, shotId, (shot) =>
          updateFrame(shot, role, (frame) => assignRefShot(frame, refShotId)),
        ),
      ),
  };
});
