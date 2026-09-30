/**
 * 8 步流程的唯一定义（步骤条 / 守卫 / 面板分发都读这一份）。
 *
 * `ready` 标记该环节是否已在本版本实现：未实现的环节仍可点开查看说明，
 * 但面板只显示"将在后续里程碑提供"。
 */

import type { Meta, Project } from "../lib/types";
import { undefinedCharacterRefs } from "../lib/scriptOps";

export type StepId =
  "project" | "script" | "assets" | "storyboard" | "keyframes" | "prompt" | "generate" | "post";

export interface StepDef {
  id: StepId;
  no: number;
  label: string;
  /** 这步干什么。 */
  goal: string;
  /** 常见错误。 */
  tip: string;
  /** 本版本是否已实现。 */
  ready: boolean;
  /** 灰态：可看见但不可进入（第 8 步后期，v1.5 提供）。 */
  disabled?: boolean;
}

export const STEPS: readonly StepDef[] = [
  {
    id: "project",
    no: 1,
    label: "立项",
    goal: "把模糊的喜好收敛成能传递给下游的硬参数",
    tip: "最容易漏的是目标受众与单集时长——它们决定后面每一镜的节奏",
    ready: true,
  },
  {
    id: "script",
    no: 2,
    label: "剧本",
    goal: "把故事变成结构化的「场」：创意核 → 大纲 → 正文 → 一致性引用",
    tip: "别在这一步拆镜，拆镜是第 4 步的事",
    ready: true,
  },
  {
    id: "assets",
    no: 3,
    label: "资产",
    goal: "锁定人物、场景、画风的视觉基准（短剧一致性成败在这一步）",
    tip: "角色形象不固定，后面每一镜都会「变脸」",
    ready: true,
  },
  {
    id: "storyboard",
    no: 4,
    label: "分镜",
    goal: "把「场」时间轴化为「镜」，并守住单集总时长",
    tip: "分镜时长加起来超过单集时长，是新手最常犯的错",
    ready: true,
  },
  {
    id: "keyframes",
    no: 5,
    label: "关键帧",
    goal: "每镜产出首帧（必需）与尾帧（可选），让画面可控而非纯抽卡",
    tip: "不指定跨镜参考，同场景连续镜头画面会跳",
    ready: false,
  },
  {
    id: "prompt",
    no: 6,
    label: "出题",
    goal: "把分镜字段自动拼装成各家模型可用的提示词与参数",
    tip: "别手写提示词，先让系统拼一版再改",
    ready: false,
  },
  {
    id: "generate",
    no: 7,
    label: "生成",
    goal: "批量提交生成任务，按「镜号_版本」归档片段并择优",
    tip: "一次提交太多不好挑，建议按场分批",
    ready: false,
  },
  {
    id: "post",
    no: 8,
    label: "后期",
    goal: "配音、字幕、BGM 与成片导出",
    tip: "v1.5 提供",
    ready: false,
    disabled: true,
  },
] as const;

export function stepById(id: StepId): StepDef {
  const found = STEPS.find((step) => step.id === id);
  if (!found) throw new Error(`unknown step: ${id}`);
  return found;
}

export interface GuardResult {
  ok: boolean;
  /** 未通过的原因清单（面向新手的具体动作，不是字段名）。 */
  issues: string[];
}

/** 卡2 的规格参数必须能算出下游参数，否则第 4 步拆镜的时长校验无从谈起。 */
function checkProjectMeta(meta: Meta): GuardResult {
  const issues: string[] = [];
  if (!meta.title.trim()) issues.push("卡1：填写作品名");
  if (!meta.genre.trim()) issues.push("卡1：选择赛道题材");
  if (!meta.platform.trim()) issues.push("卡1：选择目标平台");
  if (!meta.resolution.trim()) issues.push("卡2：选择画面分辨率");
  if (meta.fps <= 0) issues.push("卡2：帧率必须大于 0");
  if (meta.episodeDurationMs <= 0) issues.push("卡2：选择单集时长");
  if (meta.kind === "short_drama" && meta.episodeCount < 1) {
    issues.push("卡2：集数至少为 1（短视频作品请把类型改为「短视频」）");
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 第 2 步验收：故事能一句话说清，且每一场都写到了"能开拍"的程度。
 *
 * 只卡这四件事，不卡文笔——C 段允许先用占位名，第 3 步会把它补成真正的角色卡。
 */
function checkScript(project: Project): GuardResult {
  const issues: string[] = [];
  if (!project.script.logline.trim()) issues.push("A 段：用一句话写清这个故事");
  if (project.episodes.length === 0) {
    issues.push("B 段：至少要有 1 集（可以先点「模板填充」起步）");
    return { ok: false, issues };
  }

  for (const episode of project.episodes) {
    const episodeLabel = `第 ${episode.no} 集`;
    if (episode.scenes.length === 0) {
      issues.push(`${episodeLabel}：至少写 1 场`);
      continue;
    }
    for (const scene of episode.scenes) {
      const sceneLabel = `${episodeLabel} 第 ${scene.no} 场`;
      if (!scene.location.trim()) issues.push(`${sceneLabel}：填写地点`);
      if (!scene.actionDesc.trim()) issues.push(`${sceneLabel}：写清这一场发生了什么`);
      if (scene.characters.length === 0) issues.push(`${sceneLabel}：至少写一个出场角色`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * 第 3 步验收：剧本里出现过的角色都得有角色卡，否则后面每一镜都会「变脸」。
 *
 * 只卡"建档"这一件事：外貌字段与定妆照允许后补——先让新手把卡建起来，
 * 再回到这步慢慢填，比一次卡死更容易走通流程。
 */
function checkAssets(project: Project): GuardResult {
  const pending = undefinedCharacterRefs(project);
  if (pending.length === 0) return { ok: true, issues: [] };
  return {
    ok: false,
    issues: [`去第 3 步给这些角色建档：${pending.join("、")}`],
  };
}

/**
 * 第 4 步验收：每一场都得有镜头，否则第 5 步无从出关键帧。
 *
 * 总时长超标只由时长条实时提示、不作阻塞——新手常先粗排一遍再回头砍时长，
 * 在这个阶段拦住他去不了下一步，反而会打断"先跑通流程"的节奏。
 */
function checkStoryboard(project: Project): GuardResult {
  const issues: string[] = [];
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      if (scene.shots.length === 0) {
        issues.push(`第 ${episode.no} 集 第 ${scene.no} 场：还没有镜头，先拆镜`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 进入下一步前的阻塞检查。尚未实现的环节一律放行，
 * 待各自的里程碑补齐校验规则（M5 关键帧……）。
 */
export function checkStep(step: StepId, project: Project | null): GuardResult {
  if (!project) return { ok: false, issues: ["还没有新建或打开项目"] };
  switch (step) {
    case "project":
      return checkProjectMeta(project.meta);
    case "script":
      return checkScript(project);
    case "assets":
      return checkAssets(project);
    case "storyboard":
      return checkStoryboard(project);
    default:
      return { ok: true, issues: [] };
  }
}
