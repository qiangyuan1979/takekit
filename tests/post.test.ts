/**
 * 配音（第 8 步）编排层测试：提交 / 取消。
 *
 * 编排层只做三件事——按当前选择算任务、先落盘再发车、把事件写回。厂商 HTTP
 * 全在 Rust `generate_voice_lines`，这里把 IPC 整层 mock 掉，关注点是"点下去
 * 之后有没有按约定落到 state / project.json"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  api: {
    saveProject: vi.fn(),
    generateVoiceLines: vi.fn(),
    cancelVoiceTasks: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { deriveVoiceLines } from "../src/lib/postOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type { Project, Task, TtsEvent } from "../src/lib/types";
import { cancelVoiceTasks, submitVoiceLines } from "../src/state/post";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

/** 一集一场两镜：一个对白镜 + 一个旁白镜，配音句已派生好。 */
function seedProject(): Project {
  const shots = [
    makeShot({ id: "shot-1", episodeId: "ep-1", sceneId: "sc-1", no: 1, dialogue: "你好" }),
    makeShot({ id: "shot-2", episodeId: "ep-1", sceneId: "sc-1", no: 2, narration: "夜色降临" }),
  ];
  const base = makeProject(
    {},
    {
      episodes: [makeEpisode(1, { id: "ep-1", scenes: [makeScene({ id: "sc-1", no: 1, shots })] })],
    },
  );
  return { ...base, post: { ...base.post, voiceLines: deriveVoiceLines(base) } };
}

function tasksInStore(): Task[] {
  return useAppStore.getState().project?.tasks ?? [];
}

function reset(seed: Project = seedProject()): void {
  useAppStore.setState({
    ready: true,
    project: seed,
    projectPath: PROJECT_PATH,
    currentStep: "post",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
  });
}

/** 让 `generateVoiceLines` 按给定事件依次回调，并把这些事件当终态快照返回。 */
function respondWith(events: TtsEvent[]): void {
  ipc.api.generateVoiceLines.mockImplementation(
    async (_path: string, _provider: string, _jobs: unknown[], onEvent: (e: TtsEvent) => void) => {
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
  ipc.api.cancelVoiceTasks.mockResolvedValue(0);
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("submitVoiceLines", () => {
  it("先把任务落进 project.json，再调命令发车", async () => {
    let seenAtCall = -1;
    ipc.api.generateVoiceLines.mockImplementation(
      async (
        _path: string,
        _provider: string,
        _jobs: unknown[],
        _onEvent: (e: TtsEvent) => void,
      ) => {
        seenAtCall = tasksInStore().length;
        return [];
      },
    );

    await submitVoiceLines([], "openai");

    expect(ipc.api.generateVoiceLines).toHaveBeenCalledTimes(1);
    expect(seenAtCall).toBe(2);
    expect(tasksInStore().map((item) => item.status)).toEqual(["queued", "queued"]);
  });

  it("命令带 projectPath、provider 与逐句作业", async () => {
    respondWith([]);

    await submitVoiceLines([], "openai");

    const [path, provider, jobs] = ipc.api.generateVoiceLines.mock.calls[0];
    expect(path).toBe(PROJECT_PATH);
    expect(provider).toBe("openai");
    expect(jobs).toHaveLength(2);
  });

  it("进度事件经 Channel 写回任务状态与音频", async () => {
    const line = useAppStore.getState().project!.post.voiceLines[0];
    ipc.api.generateVoiceLines.mockImplementation(
      async (
        _path: string,
        _provider: string,
        jobs: { taskId: string }[],
        onEvent: (e: TtsEvent) => void,
      ) => {
        onEvent({
          taskId: jobs[0].taskId,
          voiceLineId: line.id,
          status: "succeeded",
          audioPath: `voice/${line.id}.mp3`,
          durationMs: 900,
        });
        return [];
      },
    );

    await submitVoiceLines([line.id], "openai");

    expect(tasksInStore()[0].status).toBe("succeeded");
    const updated = useAppStore
      .getState()
      .project?.post.voiceLines.find((item) => item.id === line.id);
    expect(updated?.audioPath).toBe(`voice/${line.id}.mp3`);
    expect(updated?.durationMs).toBe(900);
  });

  it("命令整体失败时把任务补成失败态并上报错误", async () => {
    const boom = { message: "网络错误", code: "network" };
    ipc.api.generateVoiceLines.mockRejectedValue(boom);

    await submitVoiceLines([], "openai");

    expect(tasksInStore().map((item) => item.status)).toEqual(["failed", "failed"]);
    expect(useAppStore.getState().error).toBe(boom);
  });

  it("没有待生成的句子时不发车", async () => {
    const seed = seedProject();
    reset({
      ...seed,
      post: {
        ...seed.post,
        voiceLines: seed.post.voiceLines.map((line) => ({
          ...line,
          audioPath: `voice/${line.id}.mp3`,
        })),
      },
    });

    await submitVoiceLines([], "openai");

    expect(ipc.api.generateVoiceLines).not.toHaveBeenCalled();
    expect(tasksInStore()).toHaveLength(0);
  });

  it("没有打开项目路径时不发车", async () => {
    useAppStore.setState({ projectPath: null });

    await submitVoiceLines([], "openai");

    expect(ipc.api.generateVoiceLines).not.toHaveBeenCalled();
  });
});

describe("cancelVoiceTasks", () => {
  it("把要取消的任务 id 交给命令", async () => {
    await cancelVoiceTasks(["task-1", "task-2"]);

    expect(ipc.api.cancelVoiceTasks).toHaveBeenCalledWith(["task-1", "task-2"]);
  });

  it("空清单不调命令", async () => {
    await cancelVoiceTasks([]);

    expect(ipc.api.cancelVoiceTasks).not.toHaveBeenCalled();
  });
});
