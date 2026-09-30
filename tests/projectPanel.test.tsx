/**
 * 立项面板测试：重点是条件字段（集数只对短剧出现）与"表单 → store"的唯一写回路径。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    createProject: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn(),
    listRecentProjects: vi.fn(),
    duplicateProject: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { ProjectPanel } from "../src/components/panels/ProjectPanel";
import { defaultSettings, type Project } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

beforeEach(() => {
  vi.resetAllMocks();
  ipc.api.saveProject.mockImplementation(async (_path: string, project: Project) => project);
  useAppStore.setState({
    ready: true,
    project: makeProject(),
    projectPath: "C:/projects/demo",
    currentStep: "project",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
    settings: defaultSettings(),
  });
});

afterEach(cleanup);

describe("<ProjectPanel />", () => {
  it("短剧类型显示「总集数」", () => {
    render(<ProjectPanel />);
    expect(screen.queryByText("总集数")).not.toBeNull();
  });

  it("短视频类型隐藏「总集数」", () => {
    useAppStore.setState({ project: makeProject({ kind: "short_video" }) });
    render(<ProjectPanel />);
    expect(screen.queryByText("总集数")).toBeNull();
    expect(screen.queryByText("作品类型")).not.toBeNull();
  });

  it("改作品名写回 store，并标记为待保存", () => {
    render(<ProjectPanel />);
    const input = screen.getByPlaceholderText("例如：重生之我在都市当龙王");

    fireEvent.change(input, { target: { value: "新征程" } });

    expect(useAppStore.getState().project?.meta.title).toBe("新征程");
    expect(useAppStore.getState().saveState).toBe("dirty");
  });

  it("风格关键词以逗号文本编辑，落库为数组", () => {
    render(<ProjectPanel />);
    const input = screen.getByPlaceholderText("例如：高对比，浅景深，胶片颗粒");

    fireEvent.change(input, { target: { value: "高对比, 浅景深，，胶片颗粒" } });

    expect(useAppStore.getState().project?.meta.styleKeywords).toEqual([
      "高对比",
      "浅景深",
      "胶片颗粒",
    ]);
  });

  it("没有项目时给出引导而不是空白", () => {
    useAppStore.setState({ project: null });
    render(<ProjectPanel />);
    expect(screen.getByText("请先新建或打开一个项目。")).toBeTruthy();
  });
});

describe("<ProjectPanel /> · 套用立项预设", () => {
  it("套用后字段整体补齐，并且还能继续手改", () => {
    // 先摆一个"填错赛道"的起点，套用后应被整体覆盖。
    useAppStore.setState({
      project: makeProject({ genre: "古风言情", visualStyle: "国潮插画", mood: "冷" }),
    });
    render(<ProjectPanel />);

    fireEvent.change(screen.getByLabelText("套用立项预设"), {
      target: { value: "builtin-meta-suspense-drama" },
    });

    expect(useAppStore.getState().project?.meta).toMatchObject({
      kind: "short_drama",
      genre: "悬疑推理",
      platform: "抖音",
      aspectRatio: "9:16",
      resolution: "1080x1920",
      fps: 30,
      episodeDurationMs: 60000,
      episodeCount: 3,
      visualStyle: "电影感暗调",
      mood: "紧张",
    });
    expect(screen.getByText("已套用「悬疑推理短剧」")).not.toBeNull();

    // 套用只是给一个起点：随后手改作品名，不应把刚套上的字段带回去。
    fireEvent.change(screen.getByPlaceholderText("例如：重生之我在都市当龙王"), {
      target: { value: "雨夜追凶" },
    });
    expect(useAppStore.getState().project?.meta.title).toBe("雨夜追凶");
    expect(useAppStore.getState().project?.meta.genre).toBe("悬疑推理");
    expect(useAppStore.getState().saveState).toBe("dirty");
  });
});
