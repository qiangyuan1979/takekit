/**
 * 模板套用的纯函数层：把模板的 `payload`（前端不可信的自由 JSON）
 * 白名单提取 + 类型校验成可直接写回项目的补丁。
 *
 * 只有这里认识模板载荷的结构；组件与 store 拿到的都是校验过的值，
 * 因此一条格式不对的模板最多是「没生效」，不会把非法值写进 `project.json`。
 */

import { composeZh } from "./promptOps";
import {
  CAMERA_MOVE_OPTIONS,
  SHOT_SIZE_OPTIONS,
  TRANSITION_OPTIONS,
  clampDurationMs,
} from "./shotOps";
import {
  ASPECT_RATIOS,
  type AspectRatio,
  type CameraMove,
  type Meta,
  type PromptBundle,
  type Script,
  type Shot,
  type ShotSize,
  type Transition,
  type UnifiedPrompt,
} from "./types";

const SHOT_SIZES = new Set<string>(SHOT_SIZE_OPTIONS.map((option) => option.value));
const CAMERA_MOVES = new Set<string>(CAMERA_MOVE_OPTIONS.map((option) => option.value));
const TRANSITIONS = new Set<string>(TRANSITION_OPTIONS.map((option) => option.value));
const ASPECTS = new Set<string>(ASPECT_RATIOS);

/** 立项模板可以覆盖的文本字段（`title` 属于单个项目的身份，不在其中）。 */
const META_TEXT_KEYS = [
  "genre",
  "platform",
  "audience",
  "resolution",
  "visualStyle",
  "mood",
  "defaultVideoModel",
  "defaultImageModel",
  "defaultLlm",
  "defaultVoice",
  "paramPreset",
] as const;

const META_NUMBER_KEYS = ["fps", "episodeDurationMs", "episodeCount"] as const;

/** 剧本模板可以覆盖的 A 段字段；`lockedFields` 不进模板。 */
const SCRIPT_KEYS = [
  "logline",
  "coreConflict",
  "protagonistGoal",
  "obstacle",
  "hook",
  "twist",
] as const;

/**
 * 提示词模板只碰这三个「环境描述」段：
 * `subject` / `environment` / `camera` 是逐镜独有的，模板填了就是错的。
 */
const PROMPT_SECTIONS = ["lighting", "style", "quality"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 立项预设 → `updateMeta` 的补丁；只认白名单字段，非法值直接丢弃。 */
export function metaPatchFrom(payload: Record<string, unknown>): Partial<Meta> {
  const patch: Partial<Meta> = {};

  for (const key of META_TEXT_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) patch[key] = value;
  }
  for (const key of META_NUMBER_KEYS) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) patch[key] = value;
  }

  const kind = payload.kind;
  if (kind === "short_drama" || kind === "short_video") patch.kind = kind;

  const aspect = payload.aspectRatio;
  if (typeof aspect === "string" && ASPECTS.has(aspect)) {
    patch.aspectRatio = aspect as AspectRatio;
  }

  const keywords = payload.styleKeywords;
  if (Array.isArray(keywords)) {
    const clean = keywords.filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
    if (clean.length > 0) patch.styleKeywords = clean;
  }

  return patch;
}

/** 题材 / 结构模板 → A 段字段 + `structure` 的补丁（写回时由 store 再尊重字段锁）。 */
export function scriptPatchFrom(payload: Record<string, unknown>): Partial<Script> {
  const patch: Partial<Script> = {};

  for (const key of SCRIPT_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) patch[key] = value;
  }

  const structure = payload.structure;
  if (typeof structure === "string" && structure.trim()) patch.structure = structure;

  return patch;
}

/** 分镜模板里的一镜种子：只带结构性字段，`id` / 镜号由 `makeShot` 生成。 */
export type ShotSeed = Partial<
  Pick<
    Shot,
    "shotSize" | "cameraMove" | "durationMs" | "visualDesc" | "sfxHint" | "transition" | "note"
  >
>;

/** 分镜骨架 → 逐镜种子；空对象与非法枚举都会被丢掉。 */
export function shotSeedsFrom(payload: Record<string, unknown>): ShotSeed[] {
  const raw = payload.shots;
  if (!Array.isArray(raw)) return [];

  const seeds: ShotSeed[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;

    const seed: ShotSeed = {};
    if (typeof record.shotSize === "string" && SHOT_SIZES.has(record.shotSize)) {
      seed.shotSize = record.shotSize as ShotSize;
    }
    if (typeof record.cameraMove === "string" && CAMERA_MOVES.has(record.cameraMove)) {
      seed.cameraMove = record.cameraMove as CameraMove;
    }
    if (typeof record.transition === "string" && TRANSITIONS.has(record.transition)) {
      seed.transition = record.transition as Transition;
    }
    if (typeof record.durationMs === "number") {
      seed.durationMs = clampDurationMs(record.durationMs);
    }
    if (typeof record.visualDesc === "string" && record.visualDesc.trim()) {
      seed.visualDesc = record.visualDesc;
    }
    if (typeof record.sfxHint === "string" && record.sfxHint.trim()) {
      seed.sfxHint = record.sfxHint;
    }
    if (typeof record.note === "string" && record.note.trim()) {
      seed.note = record.note;
    }

    if (Object.keys(seed).length > 0) seeds.push(seed);
  }
  return seeds;
}

/** 运镜序列模板：按序取出的合法运镜，套用时对本场镜头循环使用。 */
export function cameraSequenceFrom(payload: Record<string, unknown>): CameraMove[] {
  const raw = payload.moves;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is CameraMove => typeof item === "string" && CAMERA_MOVES.has(item),
  );
}

/**
 * 提示词风格模板：**只补空段**。
 *
 * 已经写过的段落原样保留 —— 逐镜主体描述是出题的核心产出，
 * 套模板绝不能把它抹掉；只补空段反而能修「整集出题漏了风格」这种常见坑。
 */
export function fillPromptBundle(
  bundle: PromptBundle,
  payload: Record<string, unknown>,
): PromptBundle {
  const unified: UnifiedPrompt = { ...bundle.unified };
  let touched = false;

  for (const key of PROMPT_SECTIONS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() && !unified[key].trim()) {
      unified[key] = value;
      touched = true;
    }
  }

  let params = bundle.params;
  const negative = payload.negativePrompt;
  if (typeof negative === "string" && negative.trim() && !params.negativePrompt.trim()) {
    params = { ...params, negativePrompt: negative };
    touched = true;
  }

  if (!touched) return bundle;
  return { ...bundle, unified, params, zh: composeZh(unified) };
}

// ---------- 反向提炼：把当前项目内容「存为模板」时的载荷 ----------

/** 当前立项参数 → 立项模板载荷；只收白名单字段，空值不落盘。 */
export function metaPayloadFrom(meta: Meta): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const key of META_TEXT_KEYS) {
    const value = meta[key];
    if (value.trim()) payload[key] = value;
  }
  for (const key of META_NUMBER_KEYS) {
    const value = meta[key];
    if (value > 0) payload[key] = value;
  }

  payload.kind = meta.kind;
  payload.aspectRatio = meta.aspectRatio;
  if (meta.styleKeywords.length > 0) payload.styleKeywords = [...meta.styleKeywords];

  return payload;
}

/** 当前剧本 A 段 → 剧本模板载荷（不含 `lockedFields`）。 */
export function scriptPayloadFrom(script: Script): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const key of SCRIPT_KEYS) {
    const value = script[key];
    if (value.trim()) payload[key] = value;
  }
  if (script.structure.trim()) payload.structure = script.structure;

  return payload;
}

/** 本场镜头 → 分镜模板载荷；只留结构性字段，镜号与 id 不进模板。 */
export function shotSeedsPayload(shots: Shot[]): Record<string, unknown> {
  const seeds = shots.map((shot) => {
    const seed: Record<string, unknown> = {
      shotSize: shot.shotSize,
      cameraMove: shot.cameraMove,
      durationMs: shot.durationMs,
      transition: shot.transition,
    };
    if (shot.visualDesc.trim()) seed.visualDesc = shot.visualDesc;
    if (shot.sfxHint.trim()) seed.sfxHint = shot.sfxHint;
    if (shot.note.trim()) seed.note = shot.note;
    return seed;
  });

  return { shots: seeds };
}

/** 当前提示词 → 风格模板载荷；只取环境描述三段 + 负向词。 */
export function promptTemplatePayload(bundle: PromptBundle): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const key of PROMPT_SECTIONS) {
    const value = bundle.unified[key];
    if (value.trim()) payload[key] = value;
  }
  if (bundle.params.negativePrompt.trim()) payload.negativePrompt = bundle.params.negativePrompt;

  return payload;
}
