/**
 * 资产图片的副作用编排：导入 / 生成 / 删除文件，然后写回 `project.json`。
 *
 * 放在 state 层而不是组件里，原因有两条：
 * 1. 顺序必须固定——**先落盘、再写引用**，否则会留下指向不存在文件的脏引用；
 * 2. 失败必须收敛到全局错误条，而不是散在六个组件里各写一遍 try/catch。
 */

import {
  buildCharacterPrompt,
  buildScenePrompt,
  buildStylePrompt,
  imageSizeFor,
} from "../lib/assetOps";
import { api, type GenerateImageRequest } from "../lib/ipc";
import type { AssetKind, Costume, Project } from "../lib/types";
import { useAppStore } from "./store";

export interface GenerateImageOptions {
  kind: AssetKind;
  ownerId: string;
  /** 生成张数，默认 4：够挑，又不至于让人选花眼。 */
  count?: number;
  /** 省略时用画风锁定里的 seed，保证同一套资产风格连续。 */
  seed?: number | null;
  /** 额外参考图（项目相对路径），会与自动推导的参考图去重合并。 */
  refImages?: string[];
  /** 服装套装：按这套衣服出定妆照。 */
  costume?: Costume;
}

/** 按资产类别拼出统一提示词模型与参考图。 */
function buildRequest(
  project: Project,
  options: GenerateImageOptions,
): GenerateImageRequest | null {
  const { width, height } = imageSizeFor(project.meta.aspectRatio);
  const styleLock = project.assets.styleLock;
  let prompt: string;
  let autoRefs: (string | null)[];

  if (options.kind === "character") {
    const character = project.assets.characters.find((item) => item.id === options.ownerId);
    if (!character) return null;
    prompt = buildCharacterPrompt(character, styleLock, project.meta, options.costume);
    // 已有定妆照时把它当第一张参考图，重出候选才不会换脸。
    autoRefs = [character.portrait, ...styleLock.refImages];
  } else if (options.kind === "scene") {
    const scene = project.assets.scenes.find((item) => item.id === options.ownerId);
    if (!scene) return null;
    prompt = buildScenePrompt(scene, styleLock, project.meta);
    autoRefs = styleLock.refImages;
  } else if (options.kind === "style") {
    prompt = buildStylePrompt(styleLock, project.meta);
    autoRefs = [];
  } else {
    return null;
  }

  const refImages = [
    ...new Set(
      [...autoRefs, ...(options.refImages ?? [])].map((path) => path?.trim() ?? "").filter(Boolean),
    ),
  ];

  return {
    prompt,
    width,
    height,
    count: options.count ?? 4,
    seed: options.seed ?? styleLock.seed,
    refImages,
  };
}

/** 把若干张本地图片导入资产目录并写回引用。 */
export async function importAssetImage(
  kind: AssetKind,
  ownerId: string,
  sourcePaths: string[],
  options: { asPrimary?: boolean } = {},
): Promise<void> {
  const { projectPath, reportError } = useAppStore.getState();
  if (!projectPath || sourcePaths.length === 0) return;
  try {
    const imported: string[] = [];
    for (const source of sourcePaths) {
      imported.push(await api.importAssetImage(projectPath, kind, ownerId, source));
    }
    useAppStore.getState().attachAssetImages(kind, ownerId, imported, options);
  } catch (error) {
    reportError(error);
  }
}

/**
 * 生成一批候选图并写回引用。
 *
 * 不覆盖既有的定妆基准：新候选只是追加，`attachAssetImages` 只在还没有基准时
 * 顺手把第一张设成基准，之后由用户在缩略图上「设为基准」。
 */
export async function generateAssetImage(options: GenerateImageOptions): Promise<void> {
  const state = useAppStore.getState();
  const { project, projectPath } = state;
  if (!project || !projectPath) return;

  const request = buildRequest(project, options);
  if (!request) return;

  try {
    const saved = await api.generateAssetImages(
      projectPath,
      options.kind,
      options.ownerId,
      request,
    );
    useAppStore.getState().attachAssetImages(options.kind, options.ownerId, saved);
  } catch (error) {
    state.reportError(error);
  }
}

/** 删除一张已引用的图片：先删文件，再从 `project.json` 摘掉引用。 */
export async function deleteAssetImage(
  kind: AssetKind,
  ownerId: string,
  path: string,
): Promise<void> {
  const { projectPath, reportError } = useAppStore.getState();
  if (!projectPath || !path) return;
  try {
    await api.deleteAssetFiles(projectPath, [path]);
    useAppStore.getState().detachAssetImage(kind, ownerId, path);
  } catch (error) {
    reportError(error);
  }
}

/** 删除整张资产卡：先清图片目录，再删卡片。画风锁定没有"删除"语义，故不在此列。 */
export async function removeAsset(kind: AssetKind, ownerId: string): Promise<void> {
  const { projectPath, reportError } = useAppStore.getState();
  if (!projectPath) return;
  try {
    await api.deleteAssetDir(projectPath, kind, ownerId);
    const store = useAppStore.getState();
    if (kind === "character") store.removeCharacter(ownerId);
    else if (kind === "scene") store.removeSceneAsset(ownerId);
    else if (kind === "prop") store.removeProp(ownerId);
  } catch (error) {
    reportError(error);
  }
}
