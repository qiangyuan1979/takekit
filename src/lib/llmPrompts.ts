/**
 * 出题层（前端）：把右栏的结构化字段编成 LLM 请求，并把回答解析回结构化字段。
 *
 * 为什么要放在前端而不是 Rust：spec §9.4 定的是"出题层只产出统一提示词模型，
 * 厂商字段翻译交给适配器"。提示词是随产品迭代最频繁的部分，放在 TS 里改一行
 * 就能生效，不必重新编译 Rust。Rust 侧只保留通用的 OpenAI 兼容传输层。
 */

import {
  SCRIPT_FIELDS,
  BEATS_LOCK_KEY,
  type ScriptFieldKey,
  type StructureTemplate,
} from "./scriptTemplates";
import type { Episode, LlmRequest, Meta, Scene, Script } from "./types";

// ---------- 动作与作用域 ----------

/** 字段级 AI 三动作。 */
export type AiAction = "generate" | "continue" | "rewrite";

/** AI 这次要改右栏的哪一块。 */
export type ScriptScope =
  | { kind: "creativeCore" }
  | { kind: "outline"; episodeId: string }
  | { kind: "scene"; episodeId: string; sceneId: string };

/** 构建请求时需要知道的全部右栏状态（右栏 → 左栏上下文同步的载体）。 */
export interface PromptContext {
  meta: Meta;
  script: Script;
  episode?: Episode;
  scene?: Scene;
}

/** 三个动作的中文名，左栏按钮与回执文案共用。 */
export const ACTION_LABELS: Record<AiAction, string> = {
  generate: "生成",
  continue: "续写",
  rewrite: "按结构模板重写",
};

const ACTION_TASKS: Record<AiAction, string> = {
  generate: "直接产出全新内容，覆盖对应字段。",
  continue: "在已有内容的基础上往下写：保留已经写好的部分，只补未完成的地方。",
  rewrite:
    "保持人物、事实与因果关系不变，只按结构模板调整表达与节奏；可以改写措辞，但不要新增设定。",
};

// ---------- system prompt ----------

export function buildSystemPrompt(meta: Meta, structure: StructureTemplate): string {
  const keywords = meta.styleKeywords.length > 0 ? meta.styleKeywords.join("、") : "（未设置）";
  const audience = meta.audience.trim() || "（未指定）";

  return [
    "你是一位短视频 / 短剧的编剧助手，服务对象是第一次做视频的新手。",
    "",
    "必须遵守的规则：",
    "1. 只输出一个 JSON 对象，不要输出任何解释、寒暄或 Markdown 代码围栏。",
    "2. JSON 的键名必须与要求完全一致，不要增删键、不要改键名。",
    "3. 文字要有画面感、可以直接拍出来：写清动作与场景，不要写心理独白式的抽象描述。",
    "4. 每一集的节拍按给定的结构模板展开，不要另起一套结构。",
    `5. 全部内容用 ${meta.language === "en-US" ? "英文" : "简体中文"}书写。`,
    "",
    "【立项参数】",
    `作品名：${meta.title || "（未命名）"}`,
    `作品类型：${meta.kind === "short_drama" ? "短剧（分集）" : "短视频（单条）"}`,
    `赛道题材：${meta.genre}`,
    `目标平台：${meta.platform}`,
    `目标受众：${audience}`,
    `视觉风格：${meta.visualStyle}`,
    `情绪基调：${meta.mood}`,
    `风格关键词：${keywords}`,
    "",
    "【本片采用的结构模板】",
    `${structure.label}：${structure.summary}`,
    ...structure.beats.map((beat, index) => `  ${index + 1}. ${beat}`),
  ].join("\n");
}

// ---------- user prompt ----------

/** 把右栏现状摊平成文本，让模型"看得见"用户已经写好的内容。 */
function describeCurrent(scope: ScriptScope, context: PromptContext): string {
  const { script, episode, scene } = context;

  if (scope.kind === "creativeCore") {
    return SCRIPT_FIELDS.map(({ key, label }) => {
      const value = script[key].trim();
      return `- ${label}：${value || "（还没写）"}`;
    }).join("\n");
  }

  if (scope.kind === "outline") {
    if (!episode) return "-（找不到这一集）";
    const beats =
      episode.beats.length > 0
        ? episode.beats.map((b, i) => `  ${i + 1}. ${b}`).join("\n")
        : "  （还没写）";
    return [
      `- 集号：第 ${episode.no} 集`,
      `- 标题：${episode.title || "（还没写）"}`,
      `- 梗概：${episode.summary || "（还没写）"}`,
      "- 节拍：",
      beats,
    ].join("\n");
  }

  if (!episode || !scene) return "-（找不到这一场）";
  const dialogues =
    scene.dialogues.length > 0
      ? scene.dialogues
          .map(
            (d) => `  - ${d.isNarration ? "旁白" : d.characterId || "（未命名角色）"}：${d.text}`,
          )
          .join("\n")
      : "  （还没写）";
  return [
    `- 所属：第 ${episode.no} 集 第 ${scene.no} 场`,
    `- 内/外景：${scene.interior ? "内景" : "外景"}`,
    `- 地点：${scene.location || "（还没写）"}`,
    `- 时间：${scene.timeOfDay || "（还没写）"}`,
    `- 出场角色：${scene.characters.length > 0 ? scene.characters.join("、") : "（还没写）"}`,
    `- 动作描述：${scene.actionDesc || "（还没写）"}`,
    "- 对白：",
    dialogues,
  ].join("\n");
}

/** 本次任务的说明 + 输出 JSON 骨架 + 锁定字段禁写清单。 */
function describeTask(scope: ScriptScope, context: PromptContext, action: AiAction): string {
  const locked = new Set(context.script.lockedFields);
  const lines: string[] = [`动作：${ACTION_LABELS[action]}。${ACTION_TASKS[action]}`];

  if (scope.kind === "creativeCore") {
    const open = SCRIPT_FIELDS.filter(({ key }) => !locked.has(key));
    lines.push("", "【输出 JSON 结构】", "{", '  "fields": {');
    open.forEach(({ key, label }, index) => {
      const comma = index === open.length - 1 ? "" : ",";
      lines.push(`    "${key}": "（${label}）"${comma}`);
    });
    lines.push("  }", "}");
    if (open.length === 0) {
      lines.push("", "注意：当前所有字段都已锁定，请不要输出任何字段。");
    } else {
      lines.push("", `只输出这些字段，不要输出其它字段：${open.map((f) => f.key).join("、")}。`);
    }
  } else if (scope.kind === "outline") {
    const beatsLocked = locked.has(BEATS_LOCK_KEY);
    lines.push("", "【输出 JSON 结构】", "{", '  "episode": {');
    if (beatsLocked) {
      lines.push('    "summary": "（本集梗概，2-3 句）"');
    } else {
      lines.push('    "summary": "（本集梗概，2-3 句）",');
      lines.push('    "beats": ["（节拍 1）", "（节拍 2）"]');
    }
    lines.push("  }", "}");
    if (beatsLocked) lines.push("", "注意：节拍已锁定，不要输出 beats。");
  } else {
    lines.push(
      "",
      "【输出 JSON 结构】",
      "{",
      '  "scene": {',
      '    "location": "（地点）",',
      '    "timeOfDay": "（时间，如：日 / 夜 / 黄昏）",',
      '    "interior": true,',
      '    "characters": ["（出场角色名）"],',
      '    "actionDesc": "（动作与画面描述，2-4 句）",',
      '    "dialogues": [{ "characterId": "（角色名）", "text": "（台词）", "isNarration": false }]',
      "  }",
      "}",
      "",
      "先写动作与画面，再根据画面写出这一场真正需要的对白；不要为了凑字数加台词。",
    );
  }

  return lines.join("\n");
}

export function buildScriptRequest(
  action: AiAction,
  scope: ScriptScope,
  context: PromptContext,
  structure: StructureTemplate,
  instruction?: string,
): LlmRequest {
  const lines = [
    "【当前右栏内容】",
    describeCurrent(scope, context),
    "",
    "【本次任务】",
    describeTask(scope, context, action),
  ];
  const extra = instruction?.trim();
  if (extra) lines.push("", "【用户补充要求】", extra);

  const user = lines.join("\n");

  return {
    messages: [
      { role: "system", content: buildSystemPrompt(context.meta, structure) },
      { role: "user", content: user },
    ],
  };
}

export type { ScriptAiResult } from "./llmPromptsParse";
export { extractJson, parseScriptResult } from "./llmPromptsParse";
export type { ScriptFieldKey };
