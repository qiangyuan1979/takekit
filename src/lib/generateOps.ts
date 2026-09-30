/**
 * 生成（第 7 步）的纯函数工具：任务工厂、抽卡计划、成本估算、事件归并、
 * 候选筛选与中断恢复。
 *
 * 和其它 `*Ops` 一样，这里不碰 store、不做 IO、不发请求。任务只存在
 * `project.json` 的 `tasks[]` 里，真正跑厂商 HTTP 的是 Rust `generate_clips`——
 * 这一层负责把"用户想生成什么"翻成一批任务，再把回来的进度事件归并回任务。
 *
 * 归档命名（spec §8）用**项目内全局镜号**：只取 `shot.no` 的话，不同场的
 * "镜 1"会撞成同一个前缀，`clips/001_01` 就分不清是哪一镜了。
 */

import { shotOptionLabel } from "./frameOps";
import { newId } from "./scriptOps";
import type {
  GenerateEvent,
  GenerateJob,
  Project,
  Scene,
  Task,
  TaskResult,
  TaskStatus,
  VideoTaskRequest,
} from "./types";

/** 每镜一次最多抽几张；再多只是白烧额度，不会提高挑中率。 */
export const MAX_COPIES = 4;

// ---------- 任务与载荷 ----------

/**
 * 读出任务里存的视频请求载荷；不是生成任务（或数据不完整）时返回 `null`。
 *
 * `Task.request` 是 `unknown`（其它 kind 存别的形状），所以每次都要验一遍。
 */
export function videoTaskRequest(task: Task): VideoTaskRequest | null {
  if (task.kind !== "video") return null;
  const request = task.request as Partial<VideoTaskRequest> | null;
  if (!request || typeof request !== "object") return null;
  if (typeof request.prompt !== "string" || typeof request.shotId !== "string") return null;
  return request as VideoTaskRequest;
}

/** 造一条排队中的生成任务；`id` 同时充当后端作业的 `taskId`，两边靠它对齐。 */
export function makeVideoTask(provider: string, request: VideoTaskRequest, now = new Date()): Task {
  return {
    id: newId("task"),
    kind: "video",
    provider,
    request,
    status: "queued",
    result: null,
    error: null,
    createdAt: now.toISOString(),
  };
}

/** 一条任务 → 提交给后端的作业；`taskId` 默认与任务 id 同源。 */
export function jobFromTask(task: Task): GenerateJob | null {
  const request = videoTaskRequest(task);
  if (!request) return null;
  return {
    taskId: task.id,
    shotNo: request.shotNo,
    request: { prompt: request.prompt, params: request.params },
  };
}

/** 一批任务 → 作业列表；丢掉不是生成任务的条目。 */
export function jobsFromTasks(tasks: Task[]): GenerateJob[] {
  const jobs: GenerateJob[] = [];
  for (const task of tasks) {
    const job = jobFromTask(task);
    if (job) jobs.push(job);
  }
  return jobs;
}

/** 任务是否还在队列里（排队 / 生成中）；启动与打开项目时要把这类判为中断。 */
export function isOpenTask(task: Task): boolean {
  return task.status === "queued" || task.status === "running";
}

// ---------- 抽卡计划 ----------

export interface GenerationCost {
  /** 提交条数（镜数 × 每镜抽卡次数）。 */
  clips: number;
  /** 覆盖的镜头数。 */
  shots: number;
  /** 预计总时长（毫秒）= 各镜时长 × 抽卡次数之和。 */
  totalMs: number;
}

export interface GenerationPlan {
  tasks: Task[];
  /** 还没出题、无法生成的镜头（展示用文案）。 */
  skipped: string[];
  cost: GenerationCost;
}

const EMPTY_COST: GenerationCost = { clips: 0, shots: 0, totalMs: 0 };

/** 抽卡次数夹进 [1, MAX_COPIES]；非法值退回 1。 */
export function clampCopies(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_COPIES, Math.max(1, Math.round(value)));
}

/** 项目内全局镜号（跨集 / 场连续 1..n）：归档文件名的前缀，必须唯一。 */
export function globalShotNo(project: Project, shotId: string): number {
  let no = 0;
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) {
        no += 1;
        if (shot.id === shotId) return no;
      }
    }
  }
  return 0;
}

/**
 * 把「某一集（或某一集里的某一场）」翻成一批待提交任务。
 *
 * `sceneId = null` 表示整集；没出题的镜头进 `skipped`，不会静默漏掉——
 * 新手最需要知道的就是"为什么这镜没生成"。
 */
export function planGeneration(
  project: Project,
  episodeId: string,
  sceneId: string | null,
  provider: string,
  copies: number,
  now = new Date(),
): GenerationPlan {
  const episode = project.episodes.find((item) => item.id === episodeId);
  if (!episode) return { tasks: [], skipped: [], cost: EMPTY_COST };

  const count = clampCopies(copies);
  const scenes: Scene[] = sceneId
    ? episode.scenes.filter((scene) => scene.id === sceneId)
    : episode.scenes;

  const tasks: Task[] = [];
  const skipped: string[] = [];
  let shots = 0;
  let totalMs = 0;

  for (const scene of scenes) {
    for (const shot of scene.shots) {
      const bundle = shot.promptBundle;
      if (!bundle) {
        skipped.push(shotOptionLabel(episode, scene, shot));
        continue;
      }
      shots += 1;
      totalMs += bundle.params.durationMs * count;
      const request: VideoTaskRequest = {
        episodeId,
        sceneId: scene.id,
        shotId: shot.id,
        shotNo: globalShotNo(project, shot.id),
        prompt: bundle.zh,
        params: bundle.params,
      };
      for (let index = 0; index < count; index += 1) {
        tasks.push(makeVideoTask(provider, request, now));
      }
    }
  }

  return { tasks, skipped, cost: { clips: tasks.length, shots, totalMs } };
}

/** 由任务列表反推成本摘要（成本口径：条数 × 秒数，不折算金额）。 */
export function summarizeGeneration(tasks: Task[]): GenerationCost {
  const shotIds = new Set<string>();
  let totalMs = 0;
  let clips = 0;
  for (const task of tasks) {
    const request = videoTaskRequest(task);
    if (!request) continue;
    clips += 1;
    shotIds.add(request.shotId);
    totalMs += request.params.durationMs;
  }
  return { clips, shots: shotIds.size, totalMs };
}

// ---------- 进度归并 ----------

/** 把一条进度事件写回任务；找不到对应任务（已被删）时返回原引用。 */
export function applyGenerateEvent(tasks: Task[], event: GenerateEvent): Task[] {
  const index = tasks.findIndex((task) => task.id === event.taskId);
  if (index < 0) return tasks;
  const next = [...tasks];
  next[index] = mergeEvent(tasks[index], event);
  return next;
}

function mergeEvent(task: Task, event: GenerateEvent): Task {
  const { status } = event;
  const failed = status === "failed";
  const succeeded = status === "succeeded" && typeof event.clipPath === "string";
  const result: TaskResult | null = succeeded
    ? { kind: "clip", path: event.clipPath as string, mime: event.mime ?? "" }
    : failed
      ? { kind: "error", code: event.errorCode ?? "unknown", args: event.errorArgs ?? undefined }
      : null;
  const error = failed ? (event.error ?? null) : null;

  const unchanged =
    task.status === status && task.error === error && sameResult(task.result, result);
  return unchanged ? task : { ...task, status, result, error };
}

function sameResult(current: unknown, incoming: TaskResult | null): boolean {
  if (current === incoming) return true;
  const left = current as TaskResult | null;
  if (!left || !incoming || left.kind !== incoming.kind) return false;
  if (left.kind === "clip" && incoming.kind === "clip") {
    return left.path === incoming.path && left.mime === incoming.mime;
  }
  if (left.kind === "error" && incoming.kind === "error") return left.code === incoming.code;
  return false;
}

// ---------- 查询 ----------

/** 某个镜头名下的全部任务（含失败与历史版本），保持写入顺序。 */
export function tasksForShot(
  tasks: Task[],
  episodeId: string,
  sceneId: string,
  shotId: string,
): Task[] {
  return tasks.filter((task) => {
    const request = videoTaskRequest(task);
    return (
      request !== null &&
      request.episodeId === episodeId &&
      request.sceneId === sceneId &&
      request.shotId === shotId
    );
  });
}

export interface ClipCandidate {
  taskId: string;
  path: string;
  mime: string;
}

/** 某镜已经拿到的候选片段（成功的任务），供并排预览与采用。 */
export function clipCandidates(
  tasks: Task[],
  episodeId: string,
  sceneId: string,
  shotId: string,
): ClipCandidate[] {
  const candidates: ClipCandidate[] = [];
  for (const task of tasksForShot(tasks, episodeId, sceneId, shotId)) {
    const clip = clipOf(task);
    if (clip) candidates.push({ taskId: task.id, path: clip.path, mime: clip.mime });
  }
  return candidates;
}

/** 任务的成功产物；还没成功时返回 `null`。 */
export function clipOf(task: Task): { path: string; mime: string } | null {
  const result = task.result as TaskResult | null;
  if (task.status !== "succeeded" || !result || result.kind !== "clip") return null;
  return { path: result.path, mime: result.mime };
}

/** 任务的失败原因（可直接交给 `describeError`）；不是失败态时返回 `null`。 */
export function failureOf(task: Task): { code: string; args?: Record<string, string> } | null {
  if (task.status !== "failed") return null;
  const result = task.result as TaskResult | null;
  if (result && result.kind === "error") return { code: result.code, args: result.args };
  return { code: "unknown" };
}

/** 状态中文名（任务列表上的标签）。 */
export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "生成中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
  }
}

// ---------- 重试与中断恢复 ----------

/** 把失败 / 已取消的任务重排成一批新任务：新 id、请求载荷照搬（版本号由后端续号）。 */
export function retryTasks(tasks: Task[], now = new Date()): Task[] {
  const retried: Task[] = [];
  for (const task of tasks) {
    if (task.status !== "failed" && task.status !== "canceled") continue;
    const request = videoTaskRequest(task);
    if (!request) continue;
    retried.push(makeVideoTask(task.provider, { ...request }, now));
  }
  return retried;
}

/** 需要在启动 / 打开项目时判为「已中断」的任务（还停在排队 / 生成中）。 */
export function interruptedTasks(tasks: Task[]): Task[] {
  return tasks.filter(isOpenTask);
}

/**
 * 把「进行中」落成失败态并标注 `interrupted`。
 *
 * 进程重启后内存里的队列已经没了，磁盘上却还写着"生成中"——不清洗的话，
 * 这些任务会永远卡在进度里。没有需要清洗的任务时返回原引用。
 */
export function markInterrupted(tasks: Task[]): Task[] {
  let touched = false;
  const next = tasks.map((task): Task => {
    if (!isOpenTask(task)) return task;
    touched = true;
    return {
      ...task,
      status: "failed",
      result: { kind: "error", code: "interrupted" } as TaskResult,
      error: "interrupted",
    };
  });
  return touched ? next : tasks;
}
