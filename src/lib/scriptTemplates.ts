/**
 * 剧本环节的离线模板：无 API Key 也能把流程走完。
 *
 * 模板正文是"半成品"而不是范文——里面全是【主角】【对手】这类占位符，
 * 逼着用户至少改一遍，改的过程本身就是学习过程（这也是产品的教学主张）。
 */

import { makeEpisode, makeScene } from "./scriptOps";
import type { Episode, Meta, WorkKind } from "./types";

// ---------- A 段字段定义 ----------

export type ScriptFieldKey =
  "logline" | "coreConflict" | "protagonistGoal" | "obstacle" | "hook" | "twist";

export interface ScriptFieldDef {
  key: ScriptFieldKey;
  label: string;
  /** 一句话说明这个字段影响下游什么。 */
  why: string;
}

export const SCRIPT_FIELDS: readonly ScriptFieldDef[] = [
  {
    key: "logline",
    label: "一句话故事",
    why: "能不能一句话说清，决定了观众 3 秒内愿不愿意留下",
  },
  {
    key: "coreConflict",
    label: "核心冲突",
    why: "没有冲突就没有戏：写清谁和谁在争什么，第 4 步才拆得出镜",
  },
  {
    key: "protagonistGoal",
    label: "主角目标",
    why: "主角想要什么，观众才有跟着看下去的理由",
  },
  {
    key: "obstacle",
    label: "阻碍",
    why: "阻力越具体冲突越有力，别写「命运」这种看不见的东西",
  },
  {
    key: "hook",
    label: "爽点 / 钩子",
    why: "这句会被第 5、6 步反复复用，直接决定完播率",
  },
  {
    key: "twist",
    label: "结尾反转",
    why: "反转要能回头解释前面所有铺垫，否则观众会觉得被骗",
  },
];

/** B 段「每集节拍」在字段锁里的键名（它不是 A 段的标量字段，故单独命名）。 */
export const BEATS_LOCK_KEY = "beats";

// ---------- B 段结构模板 ----------

export interface StructureTemplate {
  id: string;
  kind: WorkKind;
  label: string;
  /** 一句话讲清这条结构长什么样。 */
  summary: string;
  /** 每集节拍，按顺序排列。 */
  beats: string[];
  recommended: boolean;
}

export const STRUCTURES: readonly StructureTemplate[] = [
  {
    id: "drama-four-act",
    kind: "short_drama",
    label: "四幕式（推荐）",
    summary: "铺垫 → 冲突升级 → 反转 → 大结局",
    beats: [
      "铺垫：交代人物与处境，先让观众站到主角这边",
      "冲突升级：对手不断施压，主角被逼到墙角",
      "反转：主角翻盘，局面彻底逆转",
      "大结局：收束情绪，留下余味或下一集的引子",
    ],
    recommended: true,
  },
  {
    id: "drama-suspense",
    kind: "short_drama",
    label: "悬疑反转式",
    summary: "抛出谜面 → 误导 → 揭露 → 反转",
    beats: [
      "抛出谜面：开场就给一个说不通的怪事",
      "误导：把所有线索指向一个错误的人",
      "揭露：真相浮出水面，但还不是最后一块拼图",
      "反转：真凶另有其人，回看前文处处是伏笔",
    ],
    recommended: false,
  },
  {
    id: "video-hook-cta",
    kind: "short_video",
    label: "钩子-反转-CTA（推荐）",
    summary: "3 秒钩子 → 冲突 → 反转 → CTA",
    beats: [
      "3 秒钩子：第一帧就制造疑问，不给缓冲",
      "冲突：把矛盾推到最紧，一句话说清双方在争什么",
      "反转：给一个出乎意料但合理的答案",
      "CTA：引导点赞关注或下单，只说一句",
    ],
    recommended: true,
  },
  {
    id: "video-narrative",
    kind: "short_video",
    label: "叙事短片式",
    summary: "情境 → 转折 → 情绪落点",
    beats: [
      "情境：快速建立场景与人物关系",
      "转折：一个意外事件打破平静",
      "情绪落点：把整条片子的情绪收在一句话上",
    ],
    recommended: false,
  },
];

export function structuresFor(kind: WorkKind): StructureTemplate[] {
  return STRUCTURES.filter((structure) => structure.kind === kind);
}

export function defaultStructureId(kind: WorkKind): string {
  const found = structuresFor(kind).find((structure) => structure.recommended);
  return found?.id ?? STRUCTURES[0].id;
}

/** 按 id 取结构模板；为空或找不到时回落到该作品类型的推荐模板。 */
export function structureById(id: string, kind: WorkKind): StructureTemplate {
  const scoped = structuresFor(kind);
  return (
    scoped.find((structure) => structure.id === id) ??
    scoped.find((s) => s.recommended) ??
    scoped[0]
  );
}

// ---------- 模板填充 ----------

/**
 * 用立项参数生成 A 段草稿。
 *
 * 故意留空 `structure` 与 `lockedFields`：前者由调用方按类型决定，
 * 后者是用户的锁定状态，不该被模板覆盖。
 */
export function fillScriptTemplate(meta: Meta): Record<ScriptFieldKey, string> {
  const who = "【主角】";
  const rival = "【对手】";
  const thing = "【目标物】";
  const cost = "【代价】";
  const truth = "【真相】";
  const place = "【地点】";
  const title = meta.title.trim() || "本片";

  return {
    logline: `${title}：${who}在${place}为了${thing}与${rival}正面对抗，最终发现${truth}。`,
    coreConflict: `${who}要拿到${thing}，${rival}却要把它毁掉——一场${meta.genre}式的对撞。`,
    protagonistGoal: `拿回${thing}，并让${rival}为自己的选择付出代价。`,
    obstacle: `${rival}掌握着资源与话语权，${who}每往前一步都要付出${cost}。`,
    hook: `开场 3 秒：${who}当众被打脸，紧接着用一句话反杀，把「${meta.mood}」推到最满。`,
    twist: `${truth}——${rival}才是当年那件事真正的始作俑者。`,
  };
}

/** 按结构模板生成一集草稿（含一场占位，保证 C 段不是空的）。 */
export function templateEpisode(meta: Meta, structure: StructureTemplate, no: number): Episode {
  return makeEpisode(no, {
    title: meta.kind === "short_video" ? "主片" : `第 ${no} 集`,
    summary: structure.summary,
    beats: [...structure.beats],
    scenes: [
      makeScene({
        no: 1,
        location: "【地点】",
        timeOfDay: "日",
        interior: true,
        characters: ["【主角】"],
        actionDesc: "【主角】出场，用一句话交代当前处境与最紧迫的那件事。",
      }),
    ],
  });
}
