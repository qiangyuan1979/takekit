/**
 * 生成工作区测试：空态 / 成本摘要 / 未出题提示 / 候选采用 / 失败原因 / 取消与重试。
 *
 * 厂商 HTTP 与文件系统都在 Rust 侧，这里把 IPC 整层 mock 掉；关注点是"界面上
 * 点下去之后，有没有按约定落到 store / project.json"，以及新手最需要的几处
 * 提示（成本、哪镜没出题、失败为什么）有没有被正确表达。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

import { GenerateWorkspace } from "../src/components/generate/GenerateWorkspace";
import { makeVideoTask } from "../src/lib/generateOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type {
  Project,
  PromptBundle,
  Shot,
  Task,
  VideoParams,
  VideoTaskRequest,
} from "../src/lib/types";
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

function shot(patch: Partial<Shot> = {}): Shot {
  return makeShot({
    id: "shot-1",
    episodeId: "ep-1",
    sceneId: "sc-1",
    no: 1,
    promptBundle: bundle("推门", 5_000),
    ...patch,
  });
}

/** 一集一场；`shots` 为这一场的镜头，`tasks` 直接种进项目。 */
function project(shots: Shot[], tasks: Task[] = []): Project {
  return makeProject(
    {},
    {
      episodes: [
        makeEpisode(1, {
          id: "ep-1",
          scenes: [makeScene({ id: "sc-1", no: 1, shots })],
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

/** 一条已成功、带 video/ 产物的任务。 */
function clipTask(patch: Partial<VideoTaskRequest> = {}, mime = "video/mp4"): Task {
  const task = makeVideoTask("mock", request(patch));
  return {
    ...task,
    status: "succeeded",
    result: { kind: "clip", path: "clips/001_01.mp4", mime },
  };
}

function failedTask(code: string, args?: Record<string, string>, error = "boom"): Task {
  const task = makeVideoTask("kling", request());
  return { ...task, status: "failed", result: { kind: "error", code, args }, error };
}

function runningTask(patch: Partial<VideoTaskRequest> = {}): Task {
  return { ...makeVideoTask("kling", request(patch)), status: "running" };
}

function shotInStore(): Shot {
  return useAppStore.getState().project!.episodes[0].scenes[0].shots[0];
}

function reset(seed: Project = project([shot()])): void {
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

/** 推进若干轮微任务，让列表拉取、提交、取消等 async 编排走完。 */
async function flush(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  ipc.api.saveProject.mockImplementation(async (_path: string, project: Project) => project);
  ipc.api.listVideoGenerators.mockResolvedValue(["kling", "mock"]);
  ipc.api.generateClips.mockResolvedValue([]);
  ipc.api.cancelClipTasks.mockResolvedValue(0);
  reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<GenerateWorkspace /> · 空态与成本", () => {
  it("没有项目 / 没有剧集时给出可操作的提示", () => {
    useAppStore.setState({ project: null });
    const { unmount } = render(<GenerateWorkspace />);
    expect(screen.getByText(/请先新建或打开一个项目/)).toBeTruthy();
    unmount();

    reset(makeProject());
    render(<GenerateWorkspace />);
    expect(screen.getByText(/还没有剧集/)).toBeTruthy();
  });

  it("成本摘要报「条数 × 秒数」", async () => {
    render(<GenerateWorkspace />);
    await flush();

    const cost = screen.getByTestId("gen-cost").textContent ?? "";
    expect(cost).toContain("本次将提交 1 条（1 镜 × 每镜 1 条）");
    expect(cost).toContain("合计约 5 秒素材");
    expect(cost).not.toContain("还没出题");
  });

  it("有镜头没出题时给出数量与清单", async () => {
    reset(project([shot(), shot({ id: "shot-2", no: 2, promptBundle: null })]));

    render(<GenerateWorkspace />);
    await flush();

    expect(screen.getByTestId("gen-cost").textContent).toContain("有 1 镜还没出题");
    const skipped = within(screen.getByTestId("gen-skipped"));
    expect(skipped.getByText("未出题：第 1 集 第 1 场 · 镜 2")).toBeTruthy();
  });
});

describe("<GenerateWorkspace /> · 候选与采用", () => {
  it("非视频产物标「模拟产物」，视频产物用 <video>", async () => {
    const video = clipTask();
    const image = clipTask({ shotId: "shot-1" }, "image/png");
    reset(project([shot()], [video, image]));

    const { container } = render(<GenerateWorkspace />);
    await flush();

    expect(screen.getByText("模拟产物")).toBeTruthy();
    expect(container.querySelector("video")).toBeTruthy();
    expect(container.querySelector("img.thumb__img")).toBeTruthy();
  });

  it("采用 / 取消采用写回 shot.adoptedClipId", async () => {
    const candidate = clipTask();
    reset(project([shot()], [candidate]));

    render(<GenerateWorkspace />);
    await flush();

    const card = within(screen.getByTestId("gen-card"));
    fireEvent.click(card.getByRole("button", { name: "采用" }));
    expect(shotInStore().adoptedClipId).toBe(candidate.id);

    fireEvent.click(card.getByRole("button", { name: "取消采用" }));
    expect(shotInStore().adoptedClipId).toBeNull();
  });

  it("失败原因经 describeError 翻成中文", async () => {
    const failed = failedTask("provider", { provider: "kling", detail: "内容不合规" }, "rejected");
    reset(project([shot()], [failed]));

    render(<GenerateWorkspace />);
    await flush();

    expect(screen.getByTestId("gen-failures").textContent).toContain(
      "「kling」返回错误：内容不合规",
    );
  });
});

describe("<GenerateWorkspace /> · 提交 / 取消 / 重试", () => {
  it("点「开始生成」按当前选择提交", async () => {
    render(<GenerateWorkspace />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await flush();

    expect(ipc.api.generateClips).toHaveBeenCalledTimes(1);
    const [path, provider, jobs] = ipc.api.generateClips.mock.calls[0];
    expect(path).toBe(PROJECT_PATH);
    expect(provider).toBe("kling");
    expect(jobs).toHaveLength(1);
  });

  it("点「取消本场在跑」把进行中的任务交给取消命令", async () => {
    const running = runningTask();
    reset(project([shot()], [running]));

    render(<GenerateWorkspace />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /取消本场在跑（1）/ }));
    await flush();

    expect(ipc.api.cancelClipTasks).toHaveBeenCalledWith([running.id]);
  });

  it("中断任务给出提示，点「重试失败」重新发车", async () => {
    const interrupted: Task = {
      ...makeVideoTask("kling", request()),
      status: "failed",
      result: { kind: "error", code: "interrupted" },
      error: "interrupted",
    };
    reset(project([shot()], [interrupted]));

    render(<GenerateWorkspace />);
    await flush();

    expect(screen.getByTestId("gen-interrupted").textContent).toContain("本场有 1 条任务");
    const retry = screen.getByRole("button", { name: /重试失败（1）/ }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);

    fireEvent.click(retry);
    await flush();

    expect(ipc.api.generateClips).toHaveBeenCalledTimes(1);
    expect(ipc.api.generateClips.mock.calls[0][1]).toBe("kling");
  });
});
