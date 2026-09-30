/**
 * 项目管理测试：欢迎页「最近打开」的复制 / 归档，以及顶栏的「复制项目」。
 *
 * 复制走保存对话框取新名字，归档只动「最近打开」——两者都不能悄悄改磁盘上的原项目。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    getSettings: vi.fn(),
    listRecentProjects: vi.fn(),
    listTemplates: vi.fn(),
    listMaterials: vi.fn(),
    duplicateProject: vi.fn(),
    archiveProject: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

import { AppShell } from "../src/components/AppShell";
import { defaultSettings } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const ITEM = { name: "旧剧", path: "C:\\projects\\old", updatedAt: "2026-09-29T10:00:00Z" };

beforeEach(() => {
  vi.resetAllMocks();
  ipc.api.getSettings.mockResolvedValue(defaultSettings());
  ipc.api.listRecentProjects.mockResolvedValue([]);
  ipc.api.listTemplates.mockResolvedValue([]);
  ipc.api.listMaterials.mockResolvedValue([]);
  useAppStore.setState({
    ready: true,
    project: null,
    projectPath: null,
    currentStep: "project",
    saveState: "idle",
    revision: 0,
    error: null,
    recent: [],
    settings: defaultSettings(),
  });
});

afterEach(cleanup);

describe("<AppShell /> 项目管理", () => {
  it("欢迎页「复制」按所选位置整份复制，并切到新项目", async () => {
    useAppStore.setState({ recent: [ITEM] });
    ipc.api.duplicateProject.mockResolvedValue({
      project: makeProject({ title: "旧剧 副本" }),
      path: "D:\\backup\\旧剧 副本",
    });
    dialog.save.mockResolvedValue("D:\\backup\\旧剧 副本");
    render(<AppShell />);

    fireEvent.click(screen.getByText("复制"));

    await waitFor(() => expect(ipc.api.duplicateProject).toHaveBeenCalledTimes(1));
    expect(ipc.api.duplicateProject).toHaveBeenCalledWith(ITEM.path, "D:\\backup", "旧剧 副本");
    await waitFor(() => expect(useAppStore.getState().projectPath).toBe("D:\\backup\\旧剧 副本"));
  });

  it("复制时取消对话框则什么都不做", async () => {
    useAppStore.setState({ recent: [ITEM] });
    dialog.save.mockResolvedValue(null);
    render(<AppShell />);

    fireEvent.click(screen.getByText("复制"));

    await waitFor(() => expect(dialog.save).toHaveBeenCalledTimes(1));
    expect(ipc.api.duplicateProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().project).toBeNull();
  });

  it("「归档」把它移出最近列表，磁盘上的项目不动", async () => {
    useAppStore.setState({ recent: [ITEM] });
    ipc.api.archiveProject.mockResolvedValue([]);
    render(<AppShell />);

    fireEvent.click(screen.getByText("归档"));

    await waitFor(() => expect(ipc.api.archiveProject).toHaveBeenCalledWith(ITEM.path));
    await waitFor(() => expect(useAppStore.getState().recent).toEqual([]));
    expect(screen.queryByText("旧剧")).toBeNull();
  });

  it("顶栏「复制项目」也能触发复制", async () => {
    useAppStore.setState({
      project: makeProject({ title: "在做的剧" }),
      projectPath: "C:\\projects\\wip",
    });
    ipc.api.duplicateProject.mockResolvedValue({
      project: makeProject({ title: "在做的剧 副本" }),
      path: "C:\\projects\\wip 副本",
    });
    dialog.save.mockResolvedValue("C:\\projects\\wip 副本");
    render(<AppShell />);

    fireEvent.click(screen.getByText("复制项目"));

    await waitFor(() => expect(ipc.api.duplicateProject).toHaveBeenCalledTimes(1));
    expect(ipc.api.duplicateProject).toHaveBeenCalledWith(
      "C:\\projects\\wip",
      "C:\\projects",
      "wip 副本",
    );
  });
});
