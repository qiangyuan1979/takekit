/**
 * 出题（第 6 步）的副作用编排。
 *
 * 拼装本身是纯计算（`promptOps`），这一层只做三件事：
 *   1. 把三层 id 解析成实体；
 *   2. 调后端的纯翻译命令（M6 不发 HTTP，只预览各家请求体）；
 *   3. 导出 / 导入这类真落盘的 IO。
 *
 * 规矩与 `keyframes.ts` 一致：失败一律收敛到全局错误条，不往组件里抛。
 */

import { api, type HandoverOutcome, type ImportOutcome } from "../lib/ipc";
import { buildPromptBundle } from "../lib/promptOps";
import type { Episode, ExportRecord, Project, Scene, Shot, VideoParams } from "../lib/types";
import { useAppStore } from "./store";

interface LocatedScene {
  episode: Episode;
  scene: Scene;
}

interface LocatedShot extends LocatedScene {
  shot: Shot;
}

/** 解析集 / 场；任一层缺失返回 `null`。 */
function locateScene(project: Project, episodeId: string, sceneId: string): LocatedScene | null {
  const episode = project.episodes.find((item) => item.id === episodeId);
  if (!episode) return null;
  const scene = episode.scenes.find((item) => item.id === sceneId);
  if (!scene) return null;
  return { episode, scene };
}

/** 解析到具体镜头；镜头可能刚被删掉，所以同样允许返回 `null`。 */
function locateShot(
  project: Project,
  episodeId: string,
  sceneId: string,
  shotId: string,
): LocatedShot | null {
  const located = locateScene(project, episodeId, sceneId);
  if (!located) return null;
  const shot = located.scene.shots.find((item) => item.id === shotId);
  if (!shot) return null;
  return { ...located, shot };
}

// ---------- 出题 ----------

/** 给单个镜头重出题：覆盖已有 bundle（上游信息改了就重跑一次）。 */
export function generateShotPrompt(episodeId: string, sceneId: string, shotId: string): void {
  const state = useAppStore.getState();
  const { project } = state;
  if (!project) return;

  const located = locateShot(project, episodeId, sceneId, shotId);
  if (!located) return;

  const { episode, scene, shot } = located;
  const bundle = buildPromptBundle({ project, episode, scene, shot });
  useAppStore.getState().setShotPromptBundle(episodeId, sceneId, shotId, bundle);
}

/** 整场批量出题：逐个镜头拼装，已有的结果一并覆盖。 */
export function generatePromptBundles(episodeId: string, sceneId: string): void {
  const { project } = useAppStore.getState();
  if (!project) return;
  const located = locateScene(project, episodeId, sceneId);
  if (!located) return;

  // store 的写回是同步的，逐个调用时每次都拿到最新的 project。
  for (const shot of located.scene.shots) {
    generateShotPrompt(episodeId, sceneId, shot.id);
  }
}

/** 清空某镜的出题结果（对应 `setShotPromptBundle(..., null)`）。 */
export function clearShotPrompt(episodeId: string, sceneId: string, shotId: string): void {
  useAppStore.getState().setShotPromptBundle(episodeId, sceneId, shotId, null);
}

// ---------- 参数 ----------

/** 局部改视频参数：只动传进来的字段，其余保持原样。 */
export function updateShotParams(
  episodeId: string,
  sceneId: string,
  shotId: string,
  patch: Partial<VideoParams>,
): void {
  useAppStore.getState().updateShotPrompt(episodeId, sceneId, shotId, (bundle) => ({
    ...bundle,
    params: { ...bundle.params, ...patch },
  }));
}

// ---------- 各家请求体预览 ----------

/**
 * 用当前统一提示词 + 参数换算出指定厂商的请求体，缓存进 `perProvider`。
 *
 * M6 只做翻译，不校验密钥、不发请求；某家翻译失败会走全局错误条。
 */
export async function previewProviderBodies(
  episodeId: string,
  sceneId: string,
  shotId: string,
  providers: string[],
  model = "",
): Promise<void> {
  const state = useAppStore.getState();
  const { project, reportError } = state;
  if (!project || providers.length === 0) return;

  const located = locateShot(project, episodeId, sceneId, shotId);
  const bundle = located?.shot.promptBundle;
  if (!bundle) return;

  try {
    const translated: Record<string, unknown> = {};
    for (const provider of providers) {
      const result = await api.translateVideoRequest(provider, model, {
        prompt: bundle.zh,
        params: bundle.params,
      });
      translated[provider] = result.body;
    }
    useAppStore.getState().updateShotPrompt(episodeId, sceneId, shotId, (current) => ({
      ...current,
      perProvider: { ...current.perProvider, ...translated },
    }));
  } catch (error) {
    reportError(error);
  }
}

// ---------- 导出 / 导入 ----------

/** 导出分镜表；成功后登记一条导出记录。 */
export async function exportStoryboardFile(
  format: string,
  destPath: string,
): Promise<ExportRecord | null> {
  const state = useAppStore.getState();
  const { project, reportError } = state;
  if (!project || !destPath) return null;

  try {
    const record = await api.exportStoryboard(project, format, destPath);
    useAppStore.getState().addExportRecord(record);
    return record;
  } catch (error) {
    reportError(error);
    return null;
  }
}

/** 用分镜表覆盖项目；成功后整体替换（导入是"以文件为准"的显式操作）。 */
export async function importStoryboardFile(sourcePath: string): Promise<ImportOutcome | null> {
  const state = useAppStore.getState();
  const { project, reportError } = state;
  if (!project || !sourcePath) return null;

  try {
    const outcome = await api.importStoryboard(project, sourcePath);
    useAppStore.getState().applyStoryboardImport(outcome.project);
    return outcome;
  } catch (error) {
    reportError(error);
    return null;
  }
}

/** 导出交接包（分镜表三格式 + 提示词 + 参数 + 关键帧 + frames/）。 */
export async function exportHandoverPackFile(destDir: string): Promise<HandoverOutcome | null> {
  const state = useAppStore.getState();
  const { project, projectPath, reportError } = state;
  if (!project || !projectPath || !destDir) return null;

  try {
    const outcome = await api.exportHandoverPack(projectPath, project, destDir);
    useAppStore.getState().addExportRecord(outcome.record);
    return outcome;
  } catch (error) {
    reportError(error);
    return null;
  }
}
