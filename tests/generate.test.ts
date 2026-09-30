/**
 * 生成（第 7 步）编排层测试：提交 / 取消 / 重试。
 *
 * 编排层只做三件事——按当前选择算任务、先落盘再发车、把事件写回。厂商 HTTP
 * 全在 Rust `generate_clips`，这里把 IPC 整层 mock 掉，关注点是"点下去之后
 * 有没有按约定落到 state / project.json"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  api: {
    saveProject: vi.fn(),
    generateClips: vi.fn(),
    cancelClipTasks: vi.fn(),
    listVideoGenerators: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { makeVideoTask } from "../src/lib/generateOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type {
  GenerateEvent,
  GenerateJob,
  Project,
  PromptBundle,
  Task,
  VideoParams,
  VideoTaskRequest,
} from "../src/lib/types";
import { cancelGeneration, retryGeneration, submitGeneration } from "../src/state/generate";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

function params(durationMs: number): VideoParams {
  return {
    durationMs,
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    motionStrength: 0.5,
    seed: null,
    negativePrompt: "",
    refImages: [],
    firstFrame: null,
    lastFrame: null,
  };
}

function bundle(zh: string, durationMs: number): PromptBundle {
  return {
    unified: { subject: "", environment: "", camera: "", lighting: "", style: "", quality: "" },
    zh,
    en: zh,
    params: params(durationMs),
    perProvider: {},
  };
}

/** 一集一场两镜；`prompted` 为真时两镜都出过题。 */
function project(prompted = true, tasks: Task[] = []): Project {
  const first = prompted ? bundle("推门", 5_000) : null;
  const second = prompted ? bundle("回头", 3_000) : null;
  return makeProject(
    {},
    {
      episodes: [
        makeEpisode(1, {
          id: "ep-1",
          scenes: [
            makeScene({
              id: "sc-1",
              no: 1,
              shots: [
                makeShot({
                  id: "shot-1",
                  episodeId: "ep-1",
                  sceneId: "sc-1",
                  no: 1,
                  promptBundle: first,
                }),
                makeShot({
                  id: "shot-2",
                  episodeId: "ep-1",
                  sceneId: "sc-1",
                  no: 2,
                  promptBundle: second,
                }),
              ],
            }),
          ],
        }),
      ],
      tasks,
    },
  );
}

function request(patch: Partial<VideoTaskRequest> = {}): VideoTaskRequest {
  return {
    episodeId: "ep-1",
    sceneId: "sc-1",
    shotId: "shot-1",
    shotNo: 1,
    prompt: "推门",
    params: params(5_000),
    ...patch,
  };
}

/** 一条带指定状态 / 生成器的视频任务。 */
function task(patch: Partial<VideoTaskRequest>, status: Task["status"], provider = "kling"): Task {
  return { ...makeVideoTask(provider, request(patch)), status };
}

function tasksInStore(): Task[] {
  return useAppStore.getState().project?.tasks ?? [];
}

function reset(seed: Project = project()): void {
  useAppStore.setState({
    ready: true,
    project: seed,
    projectPath: PROJECT_PATH,
    currentStep: "generate",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
  });
}

/** 让 `generateClips` 按给定事件依次回调，并把这些事件当终态快照返回。 */
function respondWith(events: GenerateEvent[]): void {
  ipc.api.generateClips.mockImplementation(
    async (
      _path: string,
      _provider: string,
      _jobs: GenerateJob[],
      onEvent: (e: GenerateEvent) => void,
    ) => {
      for (const event of events) onEvent(event);
      return events;
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  ipc.api.saveProject.mockImplementation(async (_path: string, project: Project) => project);
  ipc.api.cancelClipTasks.mockResolvedValue(0);
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("submitGeneration", () => {
  it("先把任务落进 project.json，再调命令发车", async () => {
    let seenAtCall = -1;
    ipc.api.generateClips.mockImplementation(
      async (
        _path: string,
        _provider: string,
        _jobs: GenerateJob[],
        _onEvent: (e: GenerateEvent) => void,
      ) => {
        seenAtCall = tasksInStore().length;
        return [];
      },
    );

    await submitGeneration("ep-1", null, "kling", 1);

    expect(ipc.api.generateClips).toHaveBeenCalledTimes(1);
    expect(seenAtCall).toBe(2);
    expect(tasksInStore().map((item) => item.status)).toEqual(["queued", "queued"]);
  });

  it("整集抽卡：每镜按次数生成任务，命令带 projectPath 与 provider", async () => {
    respondWith([]);

    await submitGeneration("ep-1", null, "kling", 2);

    expect(ipc.api.generateClips).toHaveBeenCalledTimes(1);
    const [path, provider, jobs] = ipc.api.generateClips.mock.calls[0];
    expect(path).toBe(PROJECT_PATH);
    expect(provider).toBe("kling");
    expect(jobs).toHaveLength(4);
    expect(tasksInStore()).toHaveLength(4);
  });

  it("进度事件经 Channel 写回 store", async () => {
    ipc.api.generateClips.mockImplementation(
      async (
        _path: string,
        _provider: string,
        jobs: GenerateJob[],
        onEvent: (e: GenerateEvent) => void,
      ) => {
        onEvent({
          taskId: jobs[0].taskId,
          status: "succeeded",
          clipPath: "clips/001_01.mp4",
          mime: "video/mp4",
        });
        onEvent({ taskId: jobs[1].taskId, status: "failed", error: "超时", errorCode: "provider" });
        return [];
      },
    );

    await submitGeneration("ep-1", null, "kling", 1);

    const [afterFirst, afterSecond] = tasksInStore();
    expect(afterFirst.status).toBe("succeeded");
    expect(afterFirst.result).toEqual({
      kind: "clip",
      path: "clips/001_01.mp4",
      mime: "video/mp4",
    });
    expect(afterSecond.status).toBe("failed");
    expect(afterSecond.error).toBe("超时");
  });

  it("命令整体失败时逐条补发 failed 事件并收敛到错误条", async () => {
    const apiError = { code: "auth", message: "没有可用的 API Key", args: { provider: "kling" } };
    ipc.api.generateClips.mockRejectedValue(apiError);

    await submitGeneration("ep-1", null, "kling", 1);

    expect(useAppStore.getState().error).toEqual(apiError);
    const tasks = tasksInStore();
    expect(tasks).toHaveLength(2);
    for (const item of tasks) {
      expect(item.status).toBe("failed");
      expect(item.error).toBe("没有可用的 API Key");
      expect(item.result).toEqual({ kind: "error", code: "auth", args: { provider: "kling" } });
    }
  });

  it("一个镜头都没出题时不发车", async () => {
    reset(project(false));

    await submitGeneration("ep-1", null, "kling", 1);

    expect(ipc.api.generateClips).not.toHaveBeenCalled();
    expect(tasksInStore()).toHaveLength(0);
  });

  it("项目还没落盘（没有 projectPath）时不发车", async () => {
    useAppStore.setState({ projectPath: null });

    await submitGeneration("ep-1", null, "kling", 1);

    expect(ipc.api.generateClips).not.toHaveBeenCalled();
    expect(tasksInStore()).toHaveLength(0);
  });
});

describe("cancelGeneration", () => {
  it("把任务 id 交给取消命令", async () => {
    await cancelGeneration(["t1", "t2"]);
    expect(ipc.api.cancelClipTasks).toHaveBeenCalledWith(["t1", "t2"]);
  });

  it("空数组不调命令", async () => {
    await cancelGeneration([]);
    expect(ipc.api.cancelClipTasks).not.toHaveBeenCalled();
  });

  it("失败时收敛到错误条，且不做乐观写回", async () => {
    const running = task({}, "running");
    reset(project(true, [running]));
    ipc.api.cancelClipTasks.mockRejectedValue(new Error("取消失败"));

    await cancelGeneration([running.id]);

    expect(useAppStore.getState().error).toBeTruthy();
    expect(tasksInStore()[0].status).toBe("running");
  });
});

describe("retryGeneration", () => {
  it("按生成器分组提交，新任务入 store", async () => {
    const failedKling = task({ shotId: "shot-1" }, "failed", "kling");
    const canceledKling = task({ shotId: "shot-2" }, "canceled", "kling");
    const failedMock = task({ shotId: "shot-1" }, "failed", "mock");
    reset(project(true, [failedKling, canceledKling, failedMock]));
    respondWith([]);

    await retryGeneration("ep-1", null);

    expect(ipc.api.generateClips).toHaveBeenCalledTimes(2);
    expect(ipc.api.generateClips.mock.calls[0][1]).toBe("kling");
    expect(ipc.api.generateClips.mock.calls[0][2]).toHaveLength(2);
    expect(ipc.api.generateClips.mock.calls[1][1]).toBe("mock");
    expect(ipc.api.generateClips.mock.calls[1][2]).toHaveLength(1);
    expect(tasksInStore()).toHaveLength(6);
  });

  it("范围内没有可重试的任务时不动作", async () => {
    const running = task({}, "running");
    reset(project(true, [running]));

    await retryGeneration("ep-1", null);

    expect(ipc.api.generateClips).not.toHaveBeenCalled();
    expect(tasksInStore()).toHaveLength(1);
  });
});
