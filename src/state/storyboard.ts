/**
 * 分镜环节的编排：离线拆镜与 AI 拆镜两条路都从这里进 store。
 *
 * 为什么要有这条"离线"路径：决策点 7 定的是「没有 AI 也要能往下走」。
 * 新手第一次打开分镜时未必配好了模型，此时按「一镜一场 + 一句台词一镜」
 * 的确定性规则先拆出一版，他改起来比对着空白表格发呆容易得多。
 */

import { api } from "../lib/ipc";
import { DEFAULT_SHOT_MS, makeShot, splitSceneIntoShots } from "../lib/shotOps";
import { buildShotRequest, parseShotResult } from "../lib/shotPrompts";
import type { Episode, Project, Scene, Shot } from "../lib/types";
import { useAppStore } from "./store";

function findScene(
  project: Project,
  episodeId: string,
  sceneId: string,
): { episode: Episode; scene: Scene } | null {
  const episode = project.episodes.find((item) => item.id === episodeId);
  const scene = episode?.scenes.find((item) => item.id === sceneId);
  return episode && scene ? { episode, scene } : null;
}

/** 「第 1 集 第 2 场 · 客厅」这样一句话定位，回执与提示共用。 */
export function sceneLabel(project: Project | null, episodeId: string, sceneId: string): string {
  const found = project ? findScene(project, episodeId, sceneId) : null;
  if (!found) return "这一场";
  const { episode, scene } = found;
  return `第 ${episode.no} 集 第 ${scene.no} 场${scene.location ? ` · ${scene.location}` : ""}`;
}

export interface SplitOptions {
  /** 派生镜头的统一时长，默认 3 秒。 */
  durationMs?: number;
}

/** 规则兜底拆镜（整场覆盖）。返回写入的镜头数。 */
export function splitSceneOffline(
  episodeId: string,
  sceneId: string,
  options: SplitOptions = {},
): number {
  const project = useAppStore.getState().project;
  if (!project) throw new Error("还没有新建或打开项目");
  const found = findScene(project, episodeId, sceneId);
  if (!found) throw new Error("找不到要拆的这一场");

  const shots = splitSceneIntoShots(found.scene, {
    episodeId,
    durationMs: options.durationMs ?? DEFAULT_SHOT_MS,
  });
  useAppStore.getState().setSceneShots(episodeId, sceneId, shots);
  return shots.length;
}

/** 整集逐场兜底拆镜。返回写入的镜头总数。 */
export function splitEpisodeOffline(episodeId: string, options: SplitOptions = {}): number {
  const project = useAppStore.getState().project;
  if (!project) throw new Error("还没有新建或打开项目");
  const episode = project.episodes.find((item) => item.id === episodeId);
  if (!episode) throw new Error("找不到要拆的这一集");

  let total = 0;
  for (const scene of episode.scenes) {
    total += splitSceneOffline(episodeId, scene.id, options);
  }
  return total;
}

export interface RunShotAiOptions {
  episodeId: string;
  sceneId: string;
  /** 界面上的补充要求，追加到 prompt 末尾。 */
  instruction?: string;
  /** 流式增量回调，用于就地显示"模型正在写"。 */
  onDelta?: (delta: string) => void;
}

/**
 * AI 拆镜（整场覆盖）。返回写入的镜头数。
 *
 * 结果为空时抛错而不是静默清空：模型偶尔会回一段散文，
 * 这时候把用户已经拆好的镜头抹掉是最坏的体验。
 */
export async function runShotAi(options: RunShotAiOptions): Promise<number> {
  const project = useAppStore.getState().project;
  if (!project) throw new Error("还没有新建或打开项目");
  const found = findScene(project, options.episodeId, options.sceneId);
  if (!found) throw new Error("找不到要拆的这一场");

  const request = buildShotRequest(found.episode, found.scene, project.meta, options.instruction);

  let raw = "";
  await api.llmStream(request, (chunk) => {
    if (!chunk.delta) return;
    raw += chunk.delta;
    options.onDelta?.(chunk.delta);
  });

  const parsed = parseShotResult(raw);
  if (parsed.length === 0) {
    throw new Error("模型没有给出可用的镜头，请重试，或改用「离线拆镜」");
  }

  const shots: Shot[] = parsed.map((shot) =>
    makeShot({ ...shot, episodeId: options.episodeId, sceneId: options.sceneId }),
  );
  useAppStore.getState().setSceneShots(options.episodeId, options.sceneId, shots);
  return shots.length;
}
