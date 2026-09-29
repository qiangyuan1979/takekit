/**
 * 剧本环节的 AI 编排：构建请求 → 流式取回 → 解析 → 写回右栏。
 *
 * 放在 state 层而不是组件里，是为了让"AI 结果只能落进字段、且必须过字段锁"
 * 这条约束有一个可单测的入口——组件只负责展示。
 */

import { api } from "../lib/ipc";
import {
  buildScriptRequest,
  type AiAction,
  type PromptContext,
  type ScriptScope,
} from "../lib/llmPrompts";
import { parseScriptResult } from "../lib/llmPromptsParse";
import { BEATS_LOCK_KEY, SCRIPT_FIELDS, structureById } from "../lib/scriptTemplates";
import type { Episode, Meta, Project, Scene, Script } from "../lib/types";
import { useAppStore } from "./store";

export interface RunScriptAiOptions {
  action: AiAction;
  scope: ScriptScope;
  /** 左栏输入框里的补充要求，会追加到 user prompt 末尾。 */
  instruction?: string;
  /** 流式增量回调，用于左栏逐字显示。 */
  onDelta?: (delta: string) => void;
}

export interface AiRunOutcome {
  /** 已写进右栏的字段中文名。 */
  applied: string[];
  /** 因为是锁定字段而被跳过的中文名。 */
  skipped: string[];
}

/** 左栏标题用的人话作用域名（如「B 段 · 第 1 集大纲」）。 */
export function describeScope(scope: ScriptScope, project: Project | null): string {
  if (scope.kind === "creativeCore") return "A 段 · 创意核";

  const episode = project?.episodes.find((item) => item.id === scope.episodeId);
  const episodeLabel = episode ? `第 ${episode.no} 集` : "这一集";
  if (scope.kind === "outline") return `B 段 · ${episodeLabel}大纲`;

  const scene = episode?.scenes.find((item) => item.id === scope.sceneId);
  return `C 段 · ${episodeLabel}${scene ? `第 ${scene.no} 场` : "这一场"}`;
}

function resolveContext(project: Project, scope: ScriptScope): PromptContext {
  const base = { meta: project.meta, script: project.script };
  if (scope.kind === "creativeCore") return base;

  const episode: Episode | undefined = project.episodes.find((item) => item.id === scope.episodeId);
  if (scope.kind === "outline") return { ...base, episode };

  const scene: Scene | undefined = episode?.scenes.find((item) => item.id === scope.sceneId);
  return { ...base, episode, scene };
}

/** 场景补丁 → 中文名清单，用于给用户一句"改了哪几项"的回执。 */
function sceneLabels(patch: Partial<Scene>): string[] {
  const labels: string[] = [];
  if (patch.location !== undefined) labels.push("地点");
  if (patch.timeOfDay !== undefined) labels.push("时间");
  if (patch.interior !== undefined) labels.push("内外景");
  if (patch.characters !== undefined) labels.push("出场角色");
  if (patch.actionDesc !== undefined) labels.push("动作描述");
  if (patch.dialogues !== undefined) labels.push("对白");
  return labels;
}

/**
 * 跑一次剧本 AI 动作。
 *
 * 只有这里能把模型输出写进项目：写之前逐字段比对 `lockedFields`，
 * 被锁的字段连同名字一起返回给左栏，用户才知道"为什么这句没变"。
 */
export async function runScriptAi(options: RunScriptAiOptions): Promise<AiRunOutcome> {
  const state = useAppStore.getState();
  const project = state.project;
  if (!project) throw new Error("还没有新建或打开项目");

  const structure = structureById(project.script.structure, project.meta.kind);
  const request = buildScriptRequest(
    options.action,
    options.scope,
    resolveContext(project, options.scope),
    structure,
    options.instruction,
  );

  let raw = "";
  await api.llmStream(request, (chunk) => {
    if (!chunk.delta) return;
    raw += chunk.delta;
    options.onDelta?.(chunk.delta);
  });

  const parsed = parseScriptResult(raw);
  const locks = project.script.lockedFields;
  const applied: string[] = [];
  const skipped: string[] = [];

  const draft: Partial<Script> = {};
  for (const { key, label } of SCRIPT_FIELDS) {
    const value = parsed.fields[key];
    if (value === undefined) continue;
    if (locks.includes(key)) {
      skipped.push(label);
      continue;
    }
    draft[key] = value;
    applied.push(label);
  }
  if (Object.keys(draft).length > 0) useAppStore.getState().applyScriptPatch(draft);

  if (parsed.episode && options.scope.kind === "outline") {
    const patch: Partial<Episode> = {};
    if (parsed.episode.summary !== undefined) {
      patch.summary = parsed.episode.summary;
      applied.push("本集梗概");
    }
    if (parsed.episode.beats !== undefined) {
      if (locks.includes(BEATS_LOCK_KEY)) {
        skipped.push("节拍");
      } else {
        patch.beats = parsed.episode.beats;
        applied.push("节拍");
      }
    }
    if (Object.keys(patch).length > 0) {
      useAppStore.getState().applyEpisodePatch(options.scope.episodeId, patch);
    }
  }

  if (parsed.scene && options.scope.kind === "scene") {
    const patch: Partial<Scene> = parsed.scene;
    useAppStore.getState().updateScene(options.scope.episodeId, options.scope.sceneId, patch);
    applied.push(...sceneLabels(patch));
  }

  return { applied, skipped };
}

/** 读取当前项目的立项与剧本（组件里少写一层可选链）。 */
export function currentScriptSnapshot(): { meta: Meta; script: Script } | null {
  const project = useAppStore.getState().project;
  if (!project) return null;
  return { meta: project.meta, script: project.script };
}
