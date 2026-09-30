/**
 * 生成（第 7 步）的副作用编排：提交一批抽卡、取消、重试。
 *
 * 纯计算全在 `generateOps`，这一层只做三件事：
 *   1. 按当前选择（集 / 场 / 生成器 / 抽卡次数）算出要提交哪批任务；
 *   2. 先把任务落进 `project.json`（排队态），再发车——这样进度事件一定有对象可写；
 *   3. 把 `Channel` 推来的事件逐条写回 store，最后用命令返回的终态快照兜底对账。
 *
 * 采用片段（`adoptClip`）没有任何 IO，纯写回，所以由 UI 直接调 store，
 * 不在这里多包一层空壳（与 `keyframes.ts` 对定稿帧的处理一致）。
 */

import { jobsFromTasks, planGeneration, retryTasks, videoTaskRequest } from "../lib/generateOps";
import { api, toApiError } from "../lib/ipc";
import type { GenerateEvent, Task } from "../lib/types";
import { useAppStore } from "./store";

/** 把一条事件写回 store；事件到达时任务可能已被删，store 自己会忽略。 */
function collect(event: GenerateEvent): void {
  useAppStore.getState().applyTaskEvent(event);
}

/**
 * 提交一组任务并跟到收尾。
 *
 * 命令整体失败（如取不到密钥、项目路径失效）时不会收到任何事件，
 * 所以这里手动把这批任务落成失败态，否则它们会一直停在"排队中"。
 */
async function submitTasks(projectPath: string, provider: string, tasks: Task[]): Promise<void> {
  const jobs = jobsFromTasks(tasks);
  if (jobs.length === 0) return;

  try {
    const events = await api.generateClips(projectPath, provider, jobs, collect);
    for (const event of events) collect(event);
  } catch (error) {
    const apiError = toApiError(error);
    useAppStore.getState().reportError(apiError);
    for (const task of tasks) {
      collect({
        taskId: task.id,
        status: "failed",
        error: apiError.message,
        errorCode: apiError.code,
        errorArgs: apiError.args ?? null,
      });
    }
  }
}

/**
 * 提交一次生成：`sceneId = null` 表示整集。
 *
 * 没出题的镜头不会提交（进 `plan.skipped`），界面上会提示"哪几镜还没出题"，
 * 而不是静默跳过。
 */
export async function submitGeneration(
  episodeId: string,
  sceneId: string | null,
  provider: string,
  copies: number,
): Promise<void> {
  const { project, projectPath } = useAppStore.getState();
  if (!project || !projectPath) return;

  const plan = planGeneration(project, episodeId, sceneId, provider, copies);
  if (plan.tasks.length === 0) return;

  useAppStore.getState().addTasks(plan.tasks);
  await submitTasks(projectPath, provider, plan.tasks);
}

/**
 * 请求取消：真正把任务翻成"已取消"的是后端下一轮轮询推来的事件，
 * 这里只负责登记，所以不做乐观写回。
 */
export async function cancelGeneration(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  try {
    await api.cancelClipTasks(taskIds);
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

/** 某一集（或某一场）名下的全部生成任务。 */
function tasksInScope(tasks: Task[], episodeId: string, sceneId: string | null): Task[] {
  return tasks.filter((task) => {
    const request = videoTaskRequest(task);
    if (!request || request.episodeId !== episodeId) return false;
    return sceneId === null || request.sceneId === sceneId;
  });
}

/**
 * 重试范围内所有失败 / 已取消的任务。
 *
 * 按生成器分组提交：重试的新任务沿用了原任务的 provider，混在一起提交的话
 * 命令层只认一个 provider，会把另一家的任务送错厂商。
 */
export async function retryGeneration(episodeId: string, sceneId: string | null): Promise<void> {
  const { project, projectPath } = useAppStore.getState();
  if (!project || !projectPath) return;

  const retried = retryTasks(tasksInScope(project.tasks, episodeId, sceneId));
  if (retried.length === 0) return;

  useAppStore.getState().addTasks(retried);

  const groups = new Map<string, Task[]>();
  for (const task of retried) {
    const group = groups.get(task.provider);
    if (group) group.push(task);
    else groups.set(task.provider, [task]);
  }
  for (const [provider, group] of groups) {
    await submitTasks(projectPath, provider, group);
  }
}
