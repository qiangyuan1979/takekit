/**
 * 分镜（第 4 步）的纯函数工具：镜头工厂、镜号重排、景别/运镜/转场字典、
 * 规则兜底拆镜，以及单集时长累计与超标比较。
 *
 * 和其它 `*Ops` 一样，这里不碰 store、不做 IO。景别与运镜在本步一律走下拉，
 * 所以字典与字面量的对应关系集中放在这里，界面和校验都从这一处取值。
 */

import { newId } from "./scriptOps";
import type { CameraMove, Episode, Scene, Shot, ShotSize, Transition } from "./types";

/** 一个镜头没说时长时给多少；3 秒是短视频里最不容易出错的中位数。 */
export const DEFAULT_SHOT_MS = 3000;

/** 单镜时长下限 / 上限：低于 0.5 秒看不清，高于 20 秒短视频里几乎不存在。 */
export const MIN_SHOT_MS = 500;
export const MAX_SHOT_MS = 20_000;

// ---------- 下拉字典（值即 Rust serde 字面量） ----------

export const SHOT_SIZE_OPTIONS: readonly { value: ShotSize; label: string }[] = [
  { value: "extreme_long", label: "大远景" },
  { value: "long_shot", label: "全景" },
  { value: "medium_shot", label: "中景" },
  { value: "close_up", label: "近景" },
  { value: "extreme_close_up", label: "特写" },
];

export const CAMERA_MOVE_OPTIONS: readonly { value: CameraMove; label: string }[] = [
  { value: "static_shot", label: "固定镜头" },
  { value: "push_in", label: "推近" },
  { value: "pull_out", label: "拉远" },
  { value: "pan", label: "摇镜" },
  { value: "truck", label: "平移" },
  { value: "follow", label: "跟拍" },
  { value: "crane", label: "升降" },
  { value: "orbit", label: "环绕" },
];

export const TRANSITION_OPTIONS: readonly { value: Transition; label: string }[] = [
  { value: "cut", label: "硬切" },
  { value: "dissolve", label: "叠化" },
  { value: "fade_in", label: "淡入" },
  { value: "fade_out", label: "淡出" },
  { value: "whip_pan", label: "甩镜" },
];

function labelOf<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

export function shotSizeLabel(value: ShotSize): string {
  return labelOf(SHOT_SIZE_OPTIONS, value);
}

export function cameraMoveLabel(value: CameraMove): string {
  return labelOf(CAMERA_MOVE_OPTIONS, value);
}

export function transitionLabel(value: Transition): string {
  return labelOf(TRANSITION_OPTIONS, value);
}

// ---------- 防御式转换（解析模型输出 / 兼容脏数据） ----------

function toOptionValue<T extends string>(
  options: readonly { value: T }[],
  raw: unknown,
  fallback: T,
): T {
  const text = typeof raw === "string" ? raw.trim() : "";
  return options.some((option) => option.value === text) ? (text as T) : fallback;
}

export function toShotSize(raw: unknown, fallback: ShotSize = "medium_shot"): ShotSize {
  return toOptionValue(SHOT_SIZE_OPTIONS, raw, fallback);
}

export function toCameraMove(raw: unknown, fallback: CameraMove = "static_shot"): CameraMove {
  return toOptionValue(CAMERA_MOVE_OPTIONS, raw, fallback);
}

export function toTransition(raw: unknown, fallback: Transition = "cut"): Transition {
  return toOptionValue(TRANSITION_OPTIONS, raw, fallback);
}

/** 把任意输入夹进 [MIN, MAX]；非法值退回 `fallback`。 */
export function clampDurationMs(raw: unknown, fallback = DEFAULT_SHOT_MS): number {
  const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_SHOT_MS, Math.max(MIN_SHOT_MS, Math.round(value)));
}

// ---------- 镜头工厂与重排 ----------

/** `episodeId` / `sceneId` 没有合理默认值，必须由调用方给足。 */
export function makeShot(patch: Partial<Shot> & { episodeId: string; sceneId: string }): Shot {
  return {
    id: newId("shot"),
    no: 0,
    shotSize: "medium_shot",
    cameraMove: "static_shot",
    durationMs: DEFAULT_SHOT_MS,
    visualDesc: "",
    characters: [],
    dialogue: null,
    narration: null,
    sfxHint: "",
    transition: "cut",
    note: "",
    promptBundle: null,
    adoptedClipId: null,
    frames: [],
    ...patch,
  };
}

/** 镜号连续化为 1..n：删镜、拖序之后必须调用。 */
export function renumberShots(shots: Shot[]): Shot[] {
  return shots.map((shot, index) => (shot.no === index + 1 ? shot : { ...shot, no: index + 1 }));
}

/** 镜头上移/下移一位；越界时原样返回，不循环。 */
export function moveShots(shots: Shot[], shotId: string, delta: number): Shot[] {
  const from = shots.findIndex((shot) => shot.id === shotId);
  if (from < 0) return shots;
  const to = from + delta;
  if (to < 0 || to >= shots.length) return shots;

  const next = [...shots];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return renumberShots(next);
}

// ---------- 规则兜底拆镜（决策点 7：没有 AI 也要能往下走） ----------

export interface SplitOptions {
  episodeId: string;
  /** 派生镜头的统一时长，默认 `DEFAULT_SHOT_MS`。 */
  durationMs?: number;
}

/**
 * 把一场按确定性规则拆成镜头：
 * ① 先给一个「场面交代镜」，把这是哪儿、有谁交代清楚；
 * ② 之后每条对白 / 旁白各一镜，说话人自动进「出场角色」。
 */
export function splitSceneIntoShots(scene: Scene, options: SplitOptions): Shot[] {
  const durationMs = clampDurationMs(options.durationMs ?? DEFAULT_SHOT_MS);
  const base = {
    episodeId: options.episodeId,
    sceneId: scene.id,
    durationMs,
    characters: [] as string[],
    dialogue: null as string | null,
    narration: null as string | null,
    sfxHint: "",
    transition: "cut" as Transition,
    note: "",
  };

  const place = `${scene.interior ? "内景" : "外景"} ${scene.location}`.trim();
  const shots: Shot[] = [
    makeShot({
      ...base,
      shotSize: "long_shot",
      cameraMove: "static_shot",
      visualDesc: scene.actionDesc.trim() || place,
      characters: [...scene.characters],
    }),
  ];

  for (const dialogue of scene.dialogues) {
    const text = dialogue.text.trim();
    if (!text) continue;
    const speaker = dialogue.characterId.trim();
    if (dialogue.isNarration) {
      shots.push(
        makeShot({
          ...base,
          shotSize: "medium_shot",
          cameraMove: "static_shot",
          narration: text,
          visualDesc: `旁白：${text}`,
        }),
      );
      continue;
    }
    shots.push(
      makeShot({
        ...base,
        shotSize: "close_up",
        cameraMove: "static_shot",
        characters: speaker ? [speaker] : [],
        dialogue: text,
        visualDesc: speaker ? `${speaker}：${text}` : text,
      }),
    );
  }

  return renumberShots(shots);
}

// ---------- 时长累计与超标比较 ----------

export function sumDurationMs(shots: Shot[]): number {
  return shots.reduce((total, shot) => total + Math.max(0, shot.durationMs), 0);
}

export function episodeShotCount(episode: Episode): number {
  return episode.scenes.reduce((total, scene) => total + scene.shots.length, 0);
}

/** 一集全部场的镜头时长之和。 */
export function episodeDurationMs(episode: Episode): number {
  return episode.scenes.reduce((total, scene) => total + sumDurationMs(scene.shots), 0);
}

export interface DurationComparison {
  totalMs: number;
  limitMs: number;
  /** 超出为正、还有余量为负。 */
  deltaMs: number;
  /** 恰好等于限额不算超标。 */
  over: boolean;
  /** `totalMs / limitMs`，给进度条当宽度用。 */
  ratio: number;
}

export function compareDuration(totalMs: number, limitMs: number): DurationComparison {
  const deltaMs = totalMs - limitMs;
  return {
    totalMs,
    limitMs,
    deltaMs,
    over: deltaMs > 0,
    ratio: limitMs > 0 ? totalMs / limitMs : 0,
  };
}

/** 秒级人话时长：不足一分钟说「N 秒」，否则「N 分 SS 秒」。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}
