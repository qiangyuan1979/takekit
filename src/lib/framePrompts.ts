/**
 * 关键帧（第 5 步）的出题层：把「镜头 + 一致性资产」编成一张关键帧的生成提示词。
 *
 * 与第 3 步资产出图同源，都是确定性的字符串拼装（不调 LLM）：这一步不需要模型
 * 再创作，只需要把用户在前面几步已经拍板过的信息**一个不漏地带下来**——
 * 角色参考图、场景参考图、画风锚、镜头的画面描述与立项规格。
 *
 * 厂商差异全部交给适配器（spec §9.4）。多张参考图的**分区含义**写进提示词，
 * 像素布局由 Rust `refsheet` 完成，两侧规则必须一致（见 `frameOps.refSheetCells`）。
 */

import { styleAnchor } from "./assetOps";
import {
  MAX_FRAME_REFS,
  findShot,
  frameRoleLabel,
  refSheetCells,
  shotOptionLabel,
  shotReferenceFrame,
} from "./frameOps";
import { cameraMoveLabel, shotSizeLabel } from "./shotOps";
import type { Character, Episode, FrameRole, Project, Scene, SceneAsset, Shot } from "./types";

function compact(parts: (string | undefined)[]): string[] {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean);
}

/** 一张会被带进出图请求的参考图，及其在提示词里的说明。 */
export interface FrameRef {
  /** 项目相对路径。 */
  path: string;
  /** 来源说明，用于分区标注：如 `角色·林晚`、`场景·客厅`、`跨镜·尾帧`、`画风`。 */
  note: string;
}

export interface FramePromptPlan {
  prompt: string;
  /** 去重、按优先级排序、已按 `MAX_FRAME_REFS` 截断的参考图。 */
  refs: FrameRef[];
}

// ---------- 一致性资产的解析 ----------

/** 按 `id | name | aliases` 任一命中角色卡（与第 3 步的占位口径一致）。 */
function findCharacter(project: Project, ref: string): Character | undefined {
  const target = ref.trim();
  if (!target) return undefined;
  return project.assets.characters.find((character) =>
    [character.id, character.name, ...character.aliases].some((key) => key.trim() === target),
  );
}

/** 角色卡里最适合当参考图的：定妆照优先，否则第一张导入图。 */
function characterRefImage(character: Character): string | null {
  if (character.portrait) return character.portrait;
  return character.refImages.find(Boolean) ?? null;
}

/** 场记的地点名对上场景卡的卡片名。 */
function findSceneAsset(project: Project, scene: Scene): SceneAsset | undefined {
  const location = scene.location.trim();
  if (!location) return undefined;
  return project.assets.scenes.find((item) => item.name.trim() === location);
}

// ---------- 参考图收集 ----------

/**
 * 收集本张关键帧要带的参考图。
 *
 * 顺序即分区顺序，优先级固定为「角色 → 场景 → 跨镜 → 画风」：前者更贴近
 * "必须像"的信息，被截断时先牺牲后者。上限 `MAX_FRAME_REFS`——超过 4 张时
 * Rust 侧拼图会直接报错，所以这里必须截断，而不是"看起来传了其实没用"。
 */
export function collectFrameRefs(
  project: Project,
  scene: Scene,
  shot: Shot,
  refShotId: string | null,
): FrameRef[] {
  const refs: FrameRef[] = [];
  const seen = new Set<string>();
  const push = (path: string | null | undefined, note: string) => {
    const trimmed = path?.trim() ?? "";
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    refs.push({ path: trimmed, note });
  };

  // ① 角色参考图：本镜出镜角色，没有就退回整场出场角色。
  const names = shot.characters.length > 0 ? shot.characters : scene.characters;
  for (const name of names) {
    const character = findCharacter(project, name);
    if (!character) continue;
    push(characterRefImage(character), `角色·${character.name.trim() || name.trim()}`);
  }

  // ② 场景参考图。
  const sceneAsset = findSceneAsset(project, scene);
  if (sceneAsset) push(sceneAsset.refImages.find(Boolean), `场景·${sceneAsset.name.trim()}`);

  // ③ 跨镜参考：用户挑的那个镜头的定稿帧。
  if (refShotId) {
    const referenced = findShot(project, refShotId);
    const reference = referenced ? shotReferenceFrame(referenced) : null;
    if (reference) push(reference.path, `跨镜·${frameRoleLabel(reference.role)}`);
  }

  // ④ 画风锚：画风锁定的参考图优先，退回立项里的风格参考图。
  push(
    project.assets.styleLock.refImages.find(Boolean) ?? project.meta.styleRefImages.find(Boolean),
    "画风",
  );

  return refs.slice(0, MAX_FRAME_REFS);
}

// ---------- 提示词 ----------

/** 参考图说明：单张原样下发，多张写成分区标注（与 Rust 拼图布局一致）。 */
function describeRefs(refs: FrameRef[]): string[] {
  if (refs.length === 0) return [];
  const cells = refSheetCells(refs.length);
  if (cells.length === 0) return [`参考图：${refs[0].note}（整图即该参考）`];
  // 整块一次下发：`compact` 会逐元素 trim，分开写会把分区缩进吃掉。
  return [
    [
      "参考图是一张拼图，请按分区理解并严格保持各分区主体的外观一致：",
      ...refs.map((ref, index) => `  - ${cells[index]}：${ref.note}`),
    ].join("\n"),
  ];
}

export interface BuildFramePromptArgs {
  project: Project;
  episode: Episode;
  scene: Scene;
  shot: Shot;
  role: FrameRole;
  /** 跨镜参考的镜头 id（`Frame.refShotId`）。 */
  refShotId: string | null;
  /** 允许复用调用方已算好的参考图，避免重复解析。 */
  refs?: FrameRef[];
}

/** 组装一张关键帧的生成请求内容。 */
export function buildFramePrompt(args: BuildFramePromptArgs): FramePromptPlan {
  const { project, episode, scene, shot, role, refShotId } = args;
  const refs = args.refs ?? collectFrameRefs(project, scene, shot, refShotId);
  const { meta } = project;

  const roleHint =
    role === "first"
      ? "本图是本镜的第一帧——画面开场，需要交代清人物与环境。"
      : "本图是本镜的最后一帧——画面收尾，与首帧保持同一场景与人物外观。";

  const dialogue = shot.dialogue?.trim() || shot.narration?.trim() || "";

  const prompt = compact([
    `关键帧：${shotOptionLabel(episode, scene, shot)} · ${frameRoleLabel(role)}`,
    roleHint,
    `景别：${shotSizeLabel(shot.shotSize)}；运镜：${cameraMoveLabel(shot.cameraMove)}；画幅：${meta.aspectRatio}`,
    shot.visualDesc.trim() ? `画面：${shot.visualDesc.trim()}` : "",
    shot.characters.length > 0 ? `出场角色：${shot.characters.join("、")}` : "",
    dialogue ? `台词/旁白：${dialogue}` : "",
    ...describeRefs(refs),
    "同一角色在不同镜头里必须保持脸型、发型与服装一致。",
    styleAnchor(project.assets.styleLock, meta),
  ]).join("\n");

  return { prompt, refs };
}
