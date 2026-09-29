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
