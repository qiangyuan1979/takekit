/**
 * 后期出片（第 8 步）的副作用编排：提交配音、取消。
 *
 * 与 `generate.ts` 同一套路：纯计算全在 `postOps`，这一层只做三件事——
 *   1. 按当前选择算出要提交哪批配音句；
 *   2. 先把任务落进 `project.json`（排队态），再发车；
 *   3. 把 `Channel` 推来的事件逐条写回 store，最后用命令返回的终态快照兜底对账。
 *
 * 对口型、字幕、BGM、拼接、导出都不发请求（应用不渲染），由 UI 直接调 store 写回。
 */

import { api, toApiError } from "../lib/ipc";
import { planVoiceTasks, voiceJobsFromTasks, voiceTaskRequest } from "../lib/postOps";
import type { Task, TtsEvent } from "../lib/types";
import { useAppStore } from "./store";

/** 把一条事件写回 store；事件到达时任务可能已被删，store 自己会忽略。 */
function collect(event: TtsEvent): void {
  useAppStore.getState().applyVoiceEvent(event);
}

/**
 * 提交一批配音作业并跟到收尾。
 *
 * 命令整体失败（如取不到密钥、项目路径失效）时不会收到任何事件，
 * 所以这里手动把这批任务落成失败态，否则它们会一直停在"排队中"。
 */
async function submitVoiceTasks(
  projectPath: string,
  provider: string,
  tasks: Task[],
): Promise<void> {
  const jobs = voiceJobsFromTasks(tasks);
  if (jobs.length === 0) return;

  try {
    const events = await api.generateVoiceLines(projectPath, provider, jobs, collect);
    for (const event of events) collect(event);
  } catch (error) {
    const apiError = toApiError(error);
    useAppStore.getState().reportError(apiError);
    for (const task of tasks) {
      collect({
        taskId: task.id,
        voiceLineId: voiceTaskRequest(task)?.voiceLineId ?? "",
        status: "failed",
        durationMs: 0,
        error: apiError.message,
        errorCode: apiError.code,
        errorArgs: apiError.args ?? null,
      });
    }
  }
}

/**
 * 提交配音：传 `voiceLineIds` 即单独重生成那几句；传空数组则跑所有还没音频的句子。
 */
export async function submitVoiceLines(voiceLineIds: string[], provider: string): Promise<void> {
  const { project, projectPath } = useAppStore.getState();
  if (!project || !projectPath) return;

  const tasks = planVoiceTasks(project, voiceLineIds, provider);
  if (tasks.length === 0) return;

  useAppStore.getState().addTasks(tasks);
  await submitVoiceTasks(projectPath, provider, tasks);
}

/**
 * 请求取消：真正把任务翻成"已取消"的是后端下一轮推来的事件，
 * 这里只负责登记，所以不做乐观写回。
 */
export async function cancelVoiceTasks(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  try {
    await api.cancelVoiceTasks(taskIds);
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}
