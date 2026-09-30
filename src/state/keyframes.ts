/**
 * 关键帧（第 5 步）的副作用编排：生成候选 / 导入候选 / 删除候选 / 删镜头时清场。
 *
 * 与 `assetImages.ts` 同构，规矩也一样：**先落盘、再写引用**，失败收敛到全局错误条。
 * 定稿（`adoptFrame`）与跨镜参考（`setFrameRefShot`）没有任何 IO，纯写回
 * `project.json`，所以由 UI 直接调 store，不在这里多包一层空壳。
 */

import { imageSizeFor } from "../lib/assetOps";
import { buildFramePrompt } from "../lib/framePrompts";
import { frameByRole } from "../lib/frameOps";
import { api, type GenerateImageRequest } from "../lib/ipc";
import type { Episode, FrameRole, Project, Scene, Shot } from "../lib/types";
import { useAppStore } from "./store";

interface Located {
  episode: Episode;
  scene: Scene;
  shot: Shot;
}

/** 把三层 id 解析成实体；任一层缺失就返回 `null`（镜头可能刚被删掉）。 */
function locate(
  project: Project,
  episodeId: string,
  sceneId: string,
  shotId: string,
): Located | null {
  const episode = project.episodes.find((item) => item.id === episodeId);
  if (!episode) return null;
  const scene = episode.scenes.find((item) => item.id === sceneId);
  if (!scene) return null;
  const shot = scene.shots.find((item) => item.id === shotId);
  if (!shot) return null;
  return { episode, scene, shot };
}

export interface GenerateFrameOptions {
  /** 生成张数，默认 4：够挑，又不至于让人选花眼。 */
  count?: number;
}

/**
 * 生成一批关键帧候选并落盘写回。
 *
 * 参考图由 `buildFramePrompt` 统一收集（角色 → 场景 → 跨镜 → 画风，上限 4 张），
 * 张数超过 1 张时 Rust 侧会先拼成一张参考表再下发。
 */
export async function generateFrameCandidates(
  episodeId: string,
  sceneId: string,
  shotId: string,
  role: FrameRole,
  options: GenerateFrameOptions = {},
): Promise<void> {
  const state = useAppStore.getState();
  const { project, projectPath } = state;
  if (!project || !projectPath) return;

  const located = locate(project, episodeId, sceneId, shotId);
  if (!located) return;

  const { episode, scene, shot } = located;
  const refShotId = frameByRole(shot, role)?.refShotId ?? null;
  const plan = buildFramePrompt({ project, episode, scene, shot, role, refShotId });
  const { width, height } = imageSizeFor(project.meta.aspectRatio);

  const request: GenerateImageRequest = {
    prompt: plan.prompt,
    width,
    height,
    count: options.count ?? 4,
    seed: project.assets.styleLock.seed,
    refImages: plan.refs.map((ref) => ref.path),
  };

  try {
    const saved = await api.generateAssetImages(projectPath, "frame", shotId, request);
    useAppStore.getState().addFrameCandidates(episodeId, sceneId, shotId, role, saved);
  } catch (error) {
    state.reportError(error);
  }
}

/** 导入若干张本地图片作为候选（外部已有素材时的入口）。 */
export async function importFrameCandidates(
  episodeId: string,
  sceneId: string,
  shotId: string,
  role: FrameRole,
  sourcePaths: string[],
): Promise<void> {
  const { projectPath, reportError } = useAppStore.getState();
  if (!projectPath || sourcePaths.length === 0) return;
  try {
    const imported: string[] = [];
    for (const source of sourcePaths) {
      imported.push(await api.importAssetImage(projectPath, "frame", shotId, source));
    }
    useAppStore.getState().addFrameCandidates(episodeId, sceneId, shotId, role, imported);
  } catch (error) {
    reportError(error);
  }
}

/** 删除一张候选图：先删文件，再从候选池摘掉（正好是定稿时定稿一并清空）。 */
export async function deleteFrameCandidate(
  episodeId: string,
  sceneId: string,
  shotId: string,
  role: FrameRole,
  path: string,
): Promise<void> {
  const { projectPath, reportError } = useAppStore.getState();
  if (!projectPath || !path) return;
  try {
    await api.deleteAssetFiles(projectPath, [path]);
    useAppStore.getState().detachFrameCandidate(episodeId, sceneId, shotId, role, path);
  } catch (error) {
    reportError(error);
  }
}

/**
 * 删除一个镜头：先清掉它的关键帧图片目录，再删镜头本身。
 *
 * `removeShot` 只管 `project.json`，不知道文件系统的存在；两者必须一起用，
 * 否则 `assets/frames/<shotId>/` 会变成没人引用的孤儿目录。
 */
export async function removeShotWithFrames(
  episodeId: string,
  sceneId: string,
  shotId: string,
): Promise<void> {
  const { projectPath, reportError } = useAppStore.getState();
  if (!projectPath) return;
  try {
    await api.deleteAssetDir(projectPath, "frame", shotId);
    useAppStore.getState().removeShot(episodeId, sceneId, shotId);
  } catch (error) {
    reportError(error);
  }
}
