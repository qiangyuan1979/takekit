/**
 * 资产的纯函数工具：工厂、出图提示词拼装、图片尺寸与本地图片 URL。
 *
 * 这里不碰 store 也不做 IO——写回由 `store` 的 mutate 完成，文件操作由
 * `state/assetImages.ts` 编排，便于单独测试"提示词里到底带了哪些一致性锚"。
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { newId } from "./scriptOps";
import type {
  Appearance,
  AspectRatio,
  Character,
  Costume,
  Meta,
  Prop,
  SceneAsset,
  StyleLock,
} from "./types";

/** 画风锁定的 owner id：Rust 侧会落到 `assets/style/style/`，是个稳定的约定。 */
export const STYLE_OWNER_ID = "style";

// ---------- 工厂 ----------

export function defaultAppearance(): Appearance {
  return { faceShape: "", hair: "", hairColor: "", eyeColor: "", height: "", body: "" };
}

export function makeCostume(patch: Partial<Costume> = {}): Costume {
  return { id: newId("costume"), name: "", description: "", refImage: null, ...patch };
}

export function makeCharacter(name: string, patch: Partial<Character> = {}): Character {
  return {
    id: newId("char"),
    name,
    aliases: [],
    age: "",
    gender: "",
    appearance: defaultAppearance(),
    costumes: [],
    personality: "",
    speechStyle: "",
    voice: "",
    refImages: [],
    portrait: null,
    ...patch,
  };
}

export function makeSceneAsset(name: string, patch: Partial<SceneAsset> = {}): SceneAsset {
  return {
    id: newId("scene"),
    name,
    interior: true,
    timeOfDay: "",
    weather: "",
    description: "",
    lighting: "",
    refImages: [],
    ...patch,
  };
}

export function makeProp(name: string, patch: Partial<Prop> = {}): Prop {
  return { id: newId("prop"), name, description: "", refImage: null, ...patch };
}

export function defaultStyleLock(): StyleLock {
  return { promptTemplate: "", refImages: [], seed: null };
}

// ---------- 出图提示词（统一提示词模型，厂商差异交给适配器） ----------

function compact(parts: (string | undefined)[]): string[] {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean);
}

/**
 * 画风锚：每一张资产图都带上它，跨图风格才一致。
 *
 * 取自画风锁定模板 + 立项的视觉风格与风格关键词——这三者都在第 1、3 步确定，
 * 属于"用户已经拍板过"的信息，不需要在这里二次询问。
 */
export function styleAnchor(styleLock: StyleLock, meta: Meta): string {
  return compact([styleLock.promptTemplate, meta.styleKeywords.join("、"), meta.visualStyle]).join(
    "；",
  );
}

/** 角色定妆照提示词；传了 `costume` 就换成那套服装。 */
export function buildCharacterPrompt(
  character: Character,
  styleLock: StyleLock,
  meta: Meta,
  costume?: Costume,
): string {
  const { appearance } = character;
  const look = compact([
    appearance.faceShape,
    appearance.hair,
    appearance.hairColor,
    appearance.eyeColor,
    appearance.height,
    appearance.body,
  ]);
  const outfit = costume ? compact([costume.name, costume.description]).join("：") : "";

  return compact([
    `角色定妆照：${character.name || "主角"}`,
    [character.gender, character.age].map((part) => part.trim()).join(" "),
    look.join("，"),
    outfit ? `服装：${outfit}` : "",
    "单人正面半身，五官清晰对称，纯色背景，便于作为后续分镜的人物参考图",
    styleAnchor(styleLock, meta),
  ]).join("；");
}

/** 场景参考图提示词。 */
export function buildScenePrompt(scene: SceneAsset, styleLock: StyleLock, meta: Meta): string {
  const traits = compact([scene.interior ? "内景" : "外景", scene.timeOfDay, scene.weather]);
  return compact([
    `场景参考图：${scene.name || "场景"}`,
    traits.join("，"),
    scene.description,
    scene.lighting ? `光线：${scene.lighting.trim()}` : "",
    "无人空镜，构图干净，便于作为后续分镜的环境参考图",
    styleAnchor(styleLock, meta),
  ]).join("；");
}

/** 画风参考图提示词：让模型出一张能概括全片色调与质感的基准图。 */
export function buildStylePrompt(styleLock: StyleLock, meta: Meta): string {
  return compact([
    "画风参考图",
    styleAnchor(styleLock, meta),
    "统一色调、质感与光线，作为全片所有画面的风格基准",
  ]).join("；");
}

// ---------- 尺寸与本地图片 ----------

/** 按立项的画幅给生成尺寸：竖屏短剧、横屏、方图各一档。 */
export function imageSizeFor(aspectRatio: AspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case "16:9":
      return { width: 1536, height: 864 };
    case "1:1":
      return { width: 1024, height: 1024 };
    default:
      return { width: 864, height: 1536 };
  }
}

/**
 * 项目相对路径 → 可被 `<img src>` 使用的本地 URL。
 *
 * 走 Tauri 的 asset 协议（`tauri.conf.json` 已开 `assetProtocol`）；项目目录
 * 可能是 Windows 反斜杠路径，这里按原样拼接再交给运行时。
 */
export function assetSrc(projectPath: string | null, relative: string): string {
  if (!projectPath || !relative) return "";
  const separator = projectPath.includes("\\") ? "\\" : "/";
  const base = projectPath.replace(/[/\\]+$/, "");
  return convertFileSrc(`${base}${separator}${relative.replace(/\//g, separator)}`);
}
