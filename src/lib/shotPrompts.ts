/**
 * 分镜（第 4 步）的出题层：把「场」编成拆镜请求，并把回答解析回镜头字段。
 *
 * 与剧本那份同源：提示词放前端便于快速迭代，Rust 只留通用传输层。
 * 差别在于本步的输出是数组，且景别 / 运镜 / 转场必须落在合法枚举内——
 * 模型很容易自造「中近景」「慢慢推」这类词，所以解析层统一走 `shotOps`
 * 的兜底转换，宁可回落到默认值，也不让非法值进右栏。
 */

import { asString, asStringArray, extractJson, isRecord } from "./llmPromptsParse";
import {
  DEFAULT_SHOT_MS,
  SHOT_SIZE_OPTIONS,
  CAMERA_MOVE_OPTIONS,
  TRANSITION_OPTIONS,
  clampDurationMs,
  toCameraMove,
  toShotSize,
  toTransition,
} from "./shotOps";
import type { CameraMove, Episode, LlmRequest, Meta, Scene, ShotSize, Transition } from "./types";

/** 模型给出的一个镜头（尚未落成 `Shot`：id / 编号由 store 分配）。 */
export interface ParsedShot {
  shotSize: ShotSize;
  cameraMove: CameraMove;
  durationMs: number;
  visualDesc: string;
  characters: string[];
  dialogue: string | null;
  narration: string | null;
  sfxHint: string;
  transition: Transition;
  note: string;
}

function enumList(options: readonly { value: string; label: string }[]): string {
  return options.map((option) => `${option.value}（${option.label}）`).join("、");
}

export function buildShotSystemPrompt(meta: Meta): string {
  const keywords = meta.styleKeywords.length > 0 ? meta.styleKeywords.join("、") : "（未设置）";

  return [
    "你是一位短视频 / 短剧的分镜师，服务对象是第一次做视频的新手。",
    "",
    "必须遵守的规则：",
    "1. 只输出一个 JSON 对象，不要输出任何解释、寒暄或 Markdown 代码围栏。",
    '2. 顶层只有一个键 "shots"，值是镜头数组，按播放先后排列。',
    "3. 每个镜头只允许使用下面给定的枚举值，不允许自造词：",
    `   shotSize：${enumList(SHOT_SIZE_OPTIONS)}`,
    `   cameraMove：${enumList(CAMERA_MOVE_OPTIONS)}`,
    `   transition：${enumList(TRANSITION_OPTIONS)}`,
    `4. durationMs 是整数毫秒，取值范围 ${500}-${20000}，一集全部镜头加起来不要超过单集时长。`,
    "5. visualDesc 要写清「镜头里能看见什么」，可以直接拿去生成画面；不要写心理活动。",
    "6. 台词放进 dialogue，旁白放进 narration，一句台词只属于一个镜头；两者都没有时都写 null。",
    "7. characters 只填本镜真正出镜的角色名，必须来自剧本里出现过的角色。",
    `8. 全部文字用 ${meta.language === "en-US" ? "英文" : "简体中文"}书写。`,
    "",
    "【立项参数】",
    `作品名：${meta.title || "（未命名）"}`,
    `作品类型：${meta.kind === "short_drama" ? "短剧（分集）" : "短视频（单条）"}`,
    `赛道题材：${meta.genre}`,
    `画面比例：${meta.aspectRatio}`,
    `视觉风格：${meta.visualStyle}`,
    `情绪基调：${meta.mood}`,
    `风格关键词：${keywords}`,
    `单集时长：${Math.round(meta.episodeDurationMs / 1000)} 秒`,
  ].join("\n");
}

/** 把这一场的原文摊平，让模型照着拆，而不是凭空编。 */
function describeScene(episode: Episode, scene: Scene): string {
  const dialogues =
    scene.dialogues.length > 0
      ? scene.dialogues
          .map(
            (d) => `  - ${d.isNarration ? "旁白" : d.characterId || "（未命名角色）"}：${d.text}`,
          )
          .join("\n")
      : "  （这一场没有台词）";

  return [
    `- 所属：第 ${episode.no} 集 ${episode.title || ""} 第 ${scene.no} 场`,
    `- 内/外景：${scene.interior ? "内景" : "外景"}`,
    `- 地点：${scene.location || "（还没写）"}`,
    `- 时间：${scene.timeOfDay || "（还没写）"}`,
    `- 出场角色：${scene.characters.length > 0 ? scene.characters.join("、") : "（还没写）"}`,
    `- 动作描述：${scene.actionDesc || "（还没写）"}`,
    "- 台词与旁白：",
    dialogues,
  ].join("\n");
}

export function buildShotRequest(
  episode: Episode,
  scene: Scene,
  meta: Meta,
  instruction?: string,
): LlmRequest {
  const lines = [
    "【本集上下文】",
    `- 集号：第 ${episode.no} 集`,
    `- 标题：${episode.title || "（还没写）"}`,
    `- 梗概：${episode.summary || "（还没写）"}`,
    ...(episode.beats.length > 0
      ? ["- 节拍：", ...episode.beats.map((beat, index) => `  ${index + 1}. ${beat}`)]
      : []),
    "",
    "【要拆的这一场】",
    describeScene(episode, scene),
    "",
    "【本次任务】",
    "把这一场拆成一组镜头。先给一个交代环境的镜头，再按动作与台词推进；",
    "每个镜头都要能被单独拍出来，台词不要跨镜头拆散。",
    "",
    "【输出 JSON 结构】",
    "{",
    '  "shots": [',
    "    {",
    '      "shotSize": "medium_shot",',
    '      "cameraMove": "static_shot",',
    `      "durationMs": ${DEFAULT_SHOT_MS},`,
    '      "visualDesc": "（画面描述：谁、在哪、做什么）",',
    '      "characters": ["（角色名）"],',
    '      "dialogue": null,',
    '      "narration": null,',
    '      "sfxHint": "（音效提示，没有就留空）",',
    '      "transition": "cut",',
    '      "note": "（给新手的执行提示，没有就留空）"',
    "    }",
    "  ]",
    "}",
  ];
  const extra = instruction?.trim();
  if (extra) lines.push("", "【用户补充要求】", extra);

  return {
    messages: [
      { role: "system", content: buildShotSystemPrompt(meta) },
      { role: "user", content: lines.join("\n") },
    ],
  };
}

/**
 * 解析拆镜结果。
 *
 * 没有画面描述的行直接丢弃——`visualDesc` 是后续出题的输入，
 * 缺了它这一镜在下一环节就是死路，不如让用户重来。
 */
export function parseShotResult(raw: string): ParsedShot[] {
  const root = extractJson(raw);
  const list = Array.isArray(root.shots) ? root.shots : [];

  const shots: ParsedShot[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const visualDesc = asString(item.visualDesc);
    if (visualDesc === undefined) continue;

    shots.push({
      shotSize: toShotSize(item.shotSize),
      cameraMove: toCameraMove(item.cameraMove),
      durationMs: clampDurationMs(item.durationMs),
      visualDesc,
      characters: asStringArray(item.characters),
      dialogue: asString(item.dialogue) ?? null,
      narration: asString(item.narration) ?? null,
      sfxHint: asString(item.sfxHint) ?? "",
      transition: toTransition(item.transition),
      note: asString(item.note) ?? "",
    });
  }
  return shots;
}
