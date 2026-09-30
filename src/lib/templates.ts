/**
 * 内置模板库：与用户自己存的模板合并后一起在选择器里出现。
 *
 * 内置项的 `id` 统一带 `builtin-` 前缀 —— 它们不落盘、不可删除；
 * 用户要改就「存为模板」派生一份自己的。
 */

import type { Template, TemplateKind } from "./types";

/** 内置模板统一前缀；沿用它的项一律只读。 */
export const BUILTIN_PREFIX = "builtin-";

function builtin(
  kind: TemplateKind,
  slug: string,
  name: string,
  description: string,
  payload: Record<string, unknown>,
): Template {
  return {
    id: `${BUILTIN_PREFIX}${slug}`,
    kind,
    name,
    description,
    payload,
    createdAt: "",
    updatedAt: "",
  };
}

export const BUILTIN_TEMPLATES: Template[] = [
  // ---- 立项预设 ----
  builtin("meta", "meta-urban-drama", "都市逆袭短剧", "竖屏 60 秒 × 3 集，爽感节奏", {
    kind: "short_drama",
    genre: "都市逆袭",
    platform: "抖音",
    audience: "18-30 岁女性",
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    episodeDurationMs: 60000,
    episodeCount: 3,
    visualStyle: "实拍写实感",
    mood: "爽",
    paramPreset: "标准",
  }),
  builtin("meta", "meta-sweet-drama", "甜宠恋爱短剧", "90 秒一集，清新日系色调", {
    kind: "short_drama",
    genre: "甜宠恋爱",
    platform: "快手",
    audience: "18-35 岁女性",
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    episodeDurationMs: 90000,
    episodeCount: 3,
    visualStyle: "清新日系",
    mood: "甜",
    paramPreset: "标准",
  }),
  builtin("meta", "meta-suspense-drama", "悬疑推理短剧", "暗调冷色，紧张感", {
    kind: "short_drama",
    genre: "悬疑推理",
    platform: "抖音",
    audience: "18-40 岁",
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    episodeDurationMs: 60000,
    episodeCount: 3,
    visualStyle: "电影感暗调",
    mood: "紧张",
    paramPreset: "标准",
  }),
  builtin("meta", "meta-knowledge-video", "知识口播短视频", "45 秒单条，干净商务风", {
    kind: "short_video",
    genre: "知识科普",
    platform: "视频号",
    audience: "泛人群",
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    episodeDurationMs: 45000,
    episodeCount: 1,
    visualStyle: "干净商务",
    mood: "理性",
    paramPreset: "标准",
  }),

  // ---- 题材 / 结构 ----
  builtin(
    "script",
    "script-urban-four-act",
    "都市逆袭 · 四幕",
    "标准爽剧骨架：打压 → 转机 → 反击 → 打脸",
    {
      structure: "drama-four-act",
      logline: "被轻视的主角在一次意外里拿到转机，从谷底一路反击回到聚光灯下。",
      coreConflict: "主角想翻身，但对手用尽手段把他按在原地。",
      protagonistGoal: "在最后一集当众证明自己，拿回本该属于自己的东西。",
      obstacle: "资源、人脉、时间都不站在主角这边，身边人还在劝他认命。",
      hook: "前 3 秒：主角被当众羞辱，镜头推近他攥紧的拳头，BGM 骤停。",
      twist: "最大的底牌，其实是所有人最看不起的那件小事。",
    },
  ),
  builtin(
    "script",
    "script-suspense",
    "悬疑推理 · 三幕反转",
    "凶手不在场 → 线索指向自己 → 真相反转",
    {
      structure: "drama-suspense",
      logline: "一桩看似意外的死亡，把主角拖进一个越查越深的秘密里。",
      coreConflict: "主角要查清真相，但每查一步，证据都指向他自己。",
      protagonistGoal: "在结局揭开真凶，洗清自己。",
      obstacle: "唯一的证人在关键节点失踪，警方也开始怀疑主角。",
      hook: "前 3 秒：主角睁开眼，发现自己手里握着凶器。",
      twist: "真正的凶手一直在帮主角调查。",
    },
  ),
  builtin("script", "script-video-hook", "短视频 · 钩子 + CTA", "适合口播 / 知识类单条视频", {
    structure: "video-hook-cta",
    logline: "用一个反常识结论开场，用三个证据说服，最后给一句行动指令。",
    coreConflict: "观众的旧认知和你要传达的新结论之间冲突。",
    protagonistGoal: "让观众看完并执行最后一句行动指令。",
    obstacle: "观众注意力只有 3 秒，中途随时会划走。",
    hook: "前 3 秒：直接抛出反常识结论，不给铺垫。",
    twist: "结尾用一句反问把话题交回观众。",
  }),

  // ---- 分镜骨架 ----
  builtin("storyboard", "storyboard-three-shot", "三段式开场", "全景交代 → 近景情绪 → 特写钩子", {
    shots: [
      {
        shotSize: "long_shot",
        cameraMove: "static_shot",
        durationMs: 3000,
        visualDesc: "交代环境与人物位置，让观众先看清在哪、有谁。",
      },
      {
        shotSize: "medium_shot",
        cameraMove: "push_in",
        durationMs: 3000,
        visualDesc: "推近到人物上半身，带出表情与情绪。",
      },
      {
        shotSize: "close_up",
        cameraMove: "push_in",
        durationMs: 2000,
        visualDesc: "特写关键道具或眼神，留一个钩子给下一场。",
      },
    ],
  }),
  builtin("storyboard", "storyboard-dialogue", "对话正反打", "两人一来一回的标准拍法", {
    shots: [
      {
        shotSize: "medium_shot",
        cameraMove: "static_shot",
        durationMs: 3000,
        visualDesc: "甲说话，人物面向画面右侧。",
      },
      {
        shotSize: "medium_shot",
        cameraMove: "static_shot",
        durationMs: 3000,
        visualDesc: "乙回应，人物面向画面左侧。",
      },
    ],
  }),

  // ---- 运镜序列（按序循环套给本场镜头）----
  builtin("camera", "camera-boom", "平推 → 环绕 → 急推", "情绪逐级加码的运镜套路", {
    moves: ["push_in", "orbit", "push_in"],
  }),
  builtin("camera", "camera-static-dialogue", "固定机位对话", "全程稳定机位，靠表演撑场", {
    moves: ["static_shot", "static_shot", "static_shot"],
  }),
  builtin("camera", "camera-reveal", "缓拉揭示", "从局部慢慢拉开，露出全貌", {
    moves: ["pull_out", "crane", "static_shot"],
  }),

  // ---- 提示词风格（只补空段）----
  builtin("prompt", "prompt-cinematic", "电影感光影", "高对比轮廓光 + 浅景深", {
    lighting: "moody rim light, high contrast, cinematic shadows",
    style: "cinematic, film grain, shallow depth of field",
    quality: "4k, highly detailed, film still",
    negativePrompt: "blurry, low quality, extra fingers, watermark, text overlay",
  }),
  builtin("prompt", "prompt-fresh-japan", "清新日系", "柔和自然光 + 低饱和", {
    lighting: "soft natural daylight, gentle highlights",
    style: "japanese film look, soft pastel tones, low saturation",
    quality: "4k, clean composition, sharp focus",
    negativePrompt: "oversaturated, harsh shadows, watermark, text overlay",
  }),
  builtin("prompt", "prompt-clean-talk", "口播干净画面", "均匀柔光 + 极简背景", {
    lighting: "even softbox lighting, no harsh shadow",
    style: "clean commercial look, minimal background",
    quality: "4k, sharp focus, studio quality",
    negativePrompt: "cluttered background, motion blur, watermark, text overlay",
  }),
];

export function isBuiltinTemplate(template: Template): boolean {
  return template.id.startsWith(BUILTIN_PREFIX);
}

/** 取某一类模板：内置在前，用户自存在后。 */
export function templatesFor(kind: TemplateKind, user: Template[]): Template[] {
  return [
    ...BUILTIN_TEMPLATES.filter((template) => template.kind === kind),
    ...user.filter((template) => template.kind === kind),
  ];
}

/** 按 id 找模板（内置 + 用户一起找），找不到返回 `undefined`。 */
export function findTemplate(id: string, user: Template[]): Template | undefined {
  return [...BUILTIN_TEMPLATES, ...user].find((template) => template.id === id);
}
