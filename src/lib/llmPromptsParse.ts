/**
 * 模型回答 → 结构化字段的解析层。
 *
 * 单独成文件有两个理由：一是它只做字符串到对象的翻译，与提示词构建没有关系；
 * 二是模型输出天生不可信（可能带代码围栏、少键、把数组写成字符串），
 * 这里必须逐层防御，且这套防御逻辑要能被单独测试。
 */

import type { Dialogue } from "./types";

/** 模型返回的 A 段字段；键名即 `Script` 里的字段名。 */
export interface ParsedFields {
  [key: string]: string;
}

export interface ParsedEpisodePatch {
  summary?: string;
  beats?: string[];
}

export interface ParsedScenePatch {
  location?: string;
  timeOfDay?: string;
  interior?: boolean;
  characters?: string[];
  actionDesc?: string;
  dialogues?: Dialogue[];
}

/**
 * 归一化后的模型结果。
 *
 * 三个分支都保留：模型只该回一个，但多回时按作用域取用即可，
 * 不必在这里判断"这次问的是哪一段"——那是调用方的上下文。
 */
export interface ScriptAiResult {
  fields: ParsedFields;
  episode: ParsedEpisodePatch | null;
  scene: ParsedScenePatch | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串才算有效值：模型很爱用空串表示"我不确定"。 */
export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text !== undefined) out.push(text);
  }
  return out;
}

/** 对白：没有台词文本的条目直接丢弃，避免右栏出现空行。 */
function asDialogues(value: unknown): Dialogue[] {
  if (!Array.isArray(value)) return [];
  const out: Dialogue[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = asString(item.text);
    if (text === undefined) continue;
    out.push({
      characterId: asString(item.characterId) ?? asString(item.character) ?? "",
      text,
      isNarration: item.isNarration === true || item.isNarration === "true",
    });
  }
  return out;
}

/**
 * 从模型回答里抠出 JSON 对象。
 *
 * 顺序是：先去 Markdown 代码围栏，再取第一个 `{` 到最后一个 `}`——
 * 这样模型在 JSON 前后写的"好的，以下是……"也能被容忍。
 */
export function extractJson(raw: string): Record<string, unknown> {
  const unfenced = raw.replace(/```[a-zA-Z]*/g, " ");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象");

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw new Error("模型没有返回 JSON 对象");
  }
  if (!isRecord(parsed)) throw new Error("模型没有返回 JSON 对象");
  return parsed;
}

export function parseScriptResult(raw: string): ScriptAiResult {
  const root = extractJson(raw);

  const fields: ParsedFields = {};
  if (isRecord(root.fields)) {
    for (const [key, value] of Object.entries(root.fields)) {
      const text = asString(value);
      if (text !== undefined) fields[key] = text;
    }
  }

  let episode: ParsedEpisodePatch | null = null;
  if (isRecord(root.episode)) {
    const summary = asString(root.episode.summary);
    const beats = asStringArray(root.episode.beats);
    if (summary !== undefined || beats.length > 0) {
      episode = {};
      if (summary !== undefined) episode.summary = summary;
      if (beats.length > 0) episode.beats = beats;
    }
  }

  let scene: ParsedScenePatch | null = null;
  if (isRecord(root.scene)) {
    const patch: ParsedScenePatch = {};
    const location = asString(root.scene.location);
    if (location !== undefined) patch.location = location;
    const timeOfDay = asString(root.scene.timeOfDay);
    if (timeOfDay !== undefined) patch.timeOfDay = timeOfDay;
    if (typeof root.scene.interior === "boolean") patch.interior = root.scene.interior;
    const characters = asStringArray(root.scene.characters);
    if (characters.length > 0) patch.characters = characters;
    const actionDesc = asString(root.scene.actionDesc);
    if (actionDesc !== undefined) patch.actionDesc = actionDesc;
    const dialogues = asDialogues(root.scene.dialogues);
    if (dialogues.length > 0) patch.dialogues = dialogues;
    if (Object.keys(patch).length > 0) scene = patch;
  }

  return { fields, episode, scene };
}
