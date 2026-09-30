/**
 * 出题（第 6 步）的纯函数工具：把「镜头 + 一致性资产 + 立项规格」确定性拼装成
 * **统一提示词模型**（spec §5.6 第一层），并产出参数层默认值（第二层）与体检规则。
 *
 * 和其它 `*Ops` 一样，这里不碰 store、不做 IO、不调 LLM：
 * - 拼装是"把用户前面几步已拍板的信息一个不漏地带下来"，不需要模型再创作；
 * - 厂商字段翻译、截断、降级全部交给适配器（spec §9.4），这里只产出 `UnifiedPrompt`。
 *
 * 中英文同时产出（决策点 10）：英文用**词条级词典**处理受控词汇（景别 / 运镜 / 画质词），
 * 自由描述（画面、场景、角色名）没有确定性翻译能力，**沿用原文**——
 * 把英文交给 LLM 单独精修是后续的升级路径，本步不做在线精修。
 */

import { styleAnchor } from "./assetOps";
import { firstFrame, lastFrame, shotOptionLabel } from "./frameOps";
import { cameraMoveLabel, clampDurationMs, shotSizeLabel } from "./shotOps";
import type {
  CameraMove,
  Character,
  Episode,
  Project,
  PromptBundle,
  Scene,
  SceneAsset,
  Shot,
  ShotSize,
  UnifiedPrompt,
  VideoParams,
} from "./types";

/** 运动强度的"未改动"默认值，与 Rust `adapters::video::DEFAULT_MOTION_STRENGTH` 一致。 */
export const DEFAULT_MOTION_STRENGTH = 0.5;

/** 提示词超过这个字数就提示"可能过长"，具体上限各家不同、由适配器负责截断。 */
export const PROMPT_WARN_CHARS = 600;

/** 新手最容易漏写的通用负向词：先给一版，允许在参数区改。 */
export const DEFAULT_NEGATIVE_PROMPT =
  "模糊，低清，畸形，多余肢体，面部崩坏，文字水印，logo，画面抖动";

/** 固定画质词：短视频生成里最通用的"不犯错"措辞。 */
const QUALITY_ZH = "电影级质感，细节清晰，构图稳定，无明显畸变";
const QUALITY_EN = "cinematic quality, sharp details, stable composition, no visible distortion";

function compact(parts: (string | undefined)[]): string[] {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean);
}

// ---------- 六段结构（与 Rust `export::write_shot_markdown` 的标签一致） ----------

export const PROMPT_SECTIONS: readonly { key: keyof UnifiedPrompt; label: string }[] = [
  { key: "subject", label: "主体" },
  { key: "environment", label: "环境" },
  { key: "camera", label: "镜头" },
  { key: "lighting", label: "光线" },
  { key: "style", label: "风格" },
  { key: "quality", label: "画质" },
];

// ---------- 词条词典：每个专业词的"为什么这么写" ----------

export interface GlossaryEntry {
  key: string;
  label: string;
  why: string;
}

export const PROMPT_GLOSSARY: readonly GlossaryEntry[] = [
  {
    key: "subject",
    label: "主体",
    why: "先写清「谁在做什么」。模型对句首信息最敏感，主体放最前面最不容易被丢掉。",
  },
  {
    key: "environment",
    label: "环境",
    why: "交代「在哪」。带上前一步定好的场景卡，画面才不会每次换一个地方。",
  },
  {
    key: "camera",
    label: "镜头语言",
    why: "景别决定观众看到多少、运镜决定节奏。新手常只写景别不写运镜，画面会「死」。",
  },
  {
    key: "lighting",
    label: "光线与色调",
    why: "同样的场景，冷光/暖光讲的是两个故事。固定光线才能让同场镜头接得上。",
  },
  {
    key: "style",
    label: "风格",
    why: "画风锚在整片里必须一字不差地重复，模型才会认为它们是同一部片。",
  },
  {
    key: "quality",
    label: "画质词",
    why: "画质词的边际收益会递减：写到清晰、无畸变即可，堆太多反而稀释主体。",
  },
  {
    key: "durationMs",
    label: "时长",
    why: "模型可选的时长档位有限（如可灵只吃 5/10 秒），不支持的时长会被就近取整并提示。",
  },
  {
    key: "aspectRatio",
    label: "画幅",
    why: "竖屏短视频选 9:16。画幅错了，后面所有构图与字幕都得重来。",
  },
  {
    key: "resolution",
    label: "分辨率",
    why: "先按平台要求定档；部分模型会把它折算成 std/pro 或 720p/1080p。",
  },
  {
    key: "motionStrength",
    label: "运动强度",
    why: "越大动作越剧烈，但也越容易糊。人像口播建议偏小，动作戏才加大。",
  },
  {
    key: "seed",
    label: "随机种子",
    why: "固定种子能复现同一版画面，方便局部重生成；支持与否因厂商而异。",
  },
  {
    key: "negativePrompt",
    label: "负向提示词",
    why: "写「不想要什么」。注意：即梦等模型没有负向字段，写了会被忽略并提示。",
  },
  {
    key: "refImages",
    label: "参考图",
    why: "用图锁住人物/场景外观。可灵不吃附加参考图（只认首尾帧），会提示已忽略。",
  },
  {
    key: "firstFrame",
    label: "首帧",
    why: "首帧生视频是让画面可控的关键一步：开场画面由你定，而不是靠抽卡。",
  },
  {
    key: "lastFrame",
    label: "尾帧",
    why: "首尾帧同时给，模型会朝指定终点运动，同场景连续镜头接得更顺。",
  },
];

export function glossaryFor(key: string): GlossaryEntry | undefined {
  return PROMPT_GLOSSARY.find((entry) => entry.key === key);
}

// ---------- 受控词汇的英文对照（自由描述沿用原文） ----------

const SHOT_SIZE_EN: Record<ShotSize, string> = {
  extreme_long: "extreme long shot",
  long_shot: "long shot",
  medium_shot: "medium shot",
  close_up: "close-up",
  extreme_close_up: "extreme close-up",
};

const CAMERA_MOVE_EN: Record<CameraMove, string> = {
  static_shot: "static camera",
  push_in: "slow push-in",
  pull_out: "pull-out",
  pan: "pan",
  truck: "truck",
  follow: "follow shot",
  crane: "crane shot",
  orbit: "orbit shot",
};

export function shotSizeEn(value: ShotSize): string {
  return SHOT_SIZE_EN[value];
}

export function cameraMoveEn(value: CameraMove): string {
  return CAMERA_MOVE_EN[value];
}

// ---------- 一致性资产的解析（与第 3 / 5 步同口径） ----------

/** 按 `id | name | aliases` 任一命中角色卡。 */
function findCharacter(project: Project, ref: string): Character | undefined {
  const target = ref.trim();
  if (!target) return undefined;
  return project.assets.characters.find((character) =>
    [character.id, character.name, ...character.aliases].some((key) => key.trim() === target),
  );
}

/** 场记地点名对上场景卡的卡片名。 */
function findSceneAsset(project: Project, scene: Scene): SceneAsset | undefined {
  const location = scene.location.trim();
  if (!location) return undefined;
  return project.assets.scenes.find((item) => item.name.trim() === location);
}

/** 角色卡摘要：主体段里"像不像"的关键信息（姓名 + 性别年龄 + 脸型发型）。 */
function characterSummary(character: Character): string {
  const { appearance } = character;
  const bracket = [character.gender, character.age].map((part) => part.trim()).join("");
  const look = compact([appearance.faceShape, appearance.hair, appearance.hairColor]).join("，");
  return compact([character.name, bracket ? `（${bracket}）` : "", look]).join("");
}

// ---------- 六段拼装 ----------

export interface BuildPromptArgs {
  project: Project;
  episode: Episode;
  scene: Scene;
  shot: Shot;
}

function subjectText(project: Project, shot: Shot): string {
  const looks = compact(
    shot.characters.map((ref) => {
      const character = findCharacter(project, ref);
      return character ? characterSummary(character) : ref.trim();
    }),
  );
  return compact([looks.join("、"), shot.visualDesc]).join("；");
}

function environmentText(project: Project, scene: Scene): string {
  const asset = findSceneAsset(project, scene);
  const place = compact([scene.interior ? "内景" : "外景", scene.location]).join(" ");
  return compact([place, scene.timeOfDay, asset?.weather, asset?.description]).join("，");
}

function lightingText(project: Project, scene: Scene): string {
  const asset = findSceneAsset(project, scene);
  const mood = project.meta.mood.trim();
  return compact([asset?.lighting, mood ? `${mood}的情绪基调` : ""]).join("，");
}

/** 拼装统一提示词模型：主体 → 环境 → 镜头语言 → 光线色调 → 风格 → 画质词。 */
export function buildUnifiedPrompt(args: BuildPromptArgs): UnifiedPrompt {
  const { project, scene, shot } = args;
  return {
    subject: subjectText(project, shot),
    environment: environmentText(project, scene),
    camera: `${shotSizeLabel(shot.shotSize)}，${cameraMoveLabel(shot.cameraMove)}`,
    lighting: lightingText(project, scene),
    style: styleAnchor(project.assets.styleLock, project.meta),
    quality: QUALITY_ZH,
  };
}

function stripTail(text: string): string {
  return text.trim().replace(/[。，、；;,.\s]+$/u, "");
}

/** 中文提示词：六段用小圆点串成一句（段内已用逗号分层）。 */
export function composeZh(unified: UnifiedPrompt): string {
  const parts = PROMPT_SECTIONS.map(({ key }) => stripTail(unified[key])).filter(Boolean);
  return parts.length === 0 ? "" : `${parts.join("，")}。`;
}

/**
 * 英文提示词：受控词汇走词典，自由描述沿用原文（见文件头关于决策点 10 的说明）。
 * 顺序与中文一致，方便逐段对照。
 */
export function composeEn(args: BuildPromptArgs): string {
  const { project, scene, shot } = args;
  const parts = compact([
    stripTail(subjectText(project, shot)),
    stripTail(environmentText(project, scene)),
    `${SHOT_SIZE_EN[shot.shotSize]}, ${CAMERA_MOVE_EN[shot.cameraMove]}`,
    stripTail(lightingText(project, scene)),
    stripTail(styleAnchor(project.assets.styleLock, project.meta)),
    QUALITY_EN,
  ]);
  return parts.length === 0 ? "" : `${parts.join(", ")}.`;
}

// ---------- 参数层默认值 ----------

/** 从立项与资产推出一版可用的生成参数；之后由用户在参数区微调。 */
export function defaultVideoParams(project: Project, shot: Shot): VideoParams {
  const { meta } = project;
  return {
    durationMs: clampDurationMs(shot.durationMs),
    aspectRatio: meta.aspectRatio,
    resolution: meta.resolution,
    fps: meta.fps,
    motionStrength: DEFAULT_MOTION_STRENGTH,
    seed: project.assets.styleLock.seed ?? null,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    refImages: [],
    firstFrame: firstFrame(shot)?.adopted ?? null,
    lastFrame: lastFrame(shot)?.adopted ?? null,
  };
}

// ---------- 体检 ----------

export type PromptCheckRule = "missing_subject" | "missing_camera" | "too_long" | "contradiction";

export interface PromptCheckIssue {
  rule: PromptCheckRule;
  message: string;
}

const STATIC_HINT = /固定|静止|不动/;
const MOVE_HINT = /推近|拉远|摇镜|平移|跟拍|升降|环绕|甩/;
const NIGHT_HINT = /夜晚|深夜|夜色|夜里|夜景/;
const SUN_HINT = /阳光|正午|烈日|艳阳|晴空/;

/** 负向词出现在正向提示词里：正向里写了"模糊"，等于告诉模型就要模糊。 */
function negativeLeaks(bundle: PromptBundle, positive: string): string[] {
  const words = bundle.params.negativePrompt
    .split(/[，,、;；\s]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  return words.filter((word) => positive.includes(word));
}

/**
 * 提示词体检：缺主体 / 缺运镜 / 过长 / 自相矛盾。
 *
 * 一律是"提示"而不是"阻塞"——新手常先拼一版再改，硬拦反而打断节奏；
 * 真正的门禁只要求"每镜都出过题"（见 `shotsWithoutPrompt`）。
 */
export function checkPromptHealth(bundle: PromptBundle): PromptCheckIssue[] {
  const issues: PromptCheckIssue[] = [];
  const { unified } = bundle;

  if (!unified.subject.trim()) {
    issues.push({ rule: "missing_subject", message: "主体是空的：没写清「谁在做什么」。" });
  }

  const camera = unified.camera.trim();
  if (!camera) {
    issues.push({ rule: "missing_camera", message: "镜头语言是空的：补上景别与运镜。" });
  } else if (STATIC_HINT.test(camera) && MOVE_HINT.test(camera)) {
    issues.push({
      rule: "contradiction",
      message: "镜头自相矛盾：既写了「固定 / 静止」，又写了运动（推、拉、摇……）之一。",
    });
  }

  const positive = bundle.zh;
  if (positive.length > PROMPT_WARN_CHARS) {
    issues.push({
      rule: "too_long",
      message: `提示词 ${positive.length} 字，超过 ${PROMPT_WARN_CHARS} 字：部分模型会截断，结尾信息可能丢失。`,
    });
  }

  if (NIGHT_HINT.test(positive) && SUN_HINT.test(positive)) {
    issues.push({
      rule: "contradiction",
      message: "光线自相矛盾：画面里同时出现了「夜晚」与「阳光 / 正午」类描述。",
    });
  }

  const leaked = negativeLeaks(bundle, positive);
  if (leaked.length > 0) {
    issues.push({
      rule: "contradiction",
      message: `负向词出现在正向提示词里：${leaked.join("、")}。`,
    });
  }

  return issues;
}

// ---------- 打包与统计 ----------

/** 组装某镜的完整出题结果：六段 + 中英提示词 + 参数 + 各家请求体（初始为空）。 */
export function buildPromptBundle(args: BuildPromptArgs): PromptBundle {
  const unified = buildUnifiedPrompt(args);
  return {
    unified,
    zh: composeZh(unified),
    en: composeEn(args),
    params: defaultVideoParams(args.project, args.shot),
    perProvider: {},
  };
}

/** 一键复制「完整参数 JSON」时用的文本。 */
export function bundleToJson(bundle: PromptBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/** 还没出题的镜头清单（第 6 步门禁口径）；空数组即全部出过题。 */
export function shotsWithoutPrompt(project: Project): string[] {
  const pending: string[] = [];
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) {
        if (!shot.promptBundle) pending.push(shotOptionLabel(episode, scene, shot));
      }
    }
  }
  return pending;
}
