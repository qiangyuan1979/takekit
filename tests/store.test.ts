/**
 * store 契约测试：自动保存的防抖、竞态保护，以及项目开合的副作用。
 *
 * 这些行为靠手工点界面很难验证（尤其是"保存返回时不能覆盖新编辑"），
 * 但它们一旦坏掉就是丢数据，所以必须锁住。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { defaultSettings, type Project } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

function reset(patch: Partial<ReturnType<typeof useAppStore.getState>> = {}): void {
  useAppStore.setState({
    ready: true,
    project: makeProject(),
    projectPath: PROJECT_PATH,
    currentStep: "project",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
    settings: defaultSettings(),
    ...patch,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  ipc.api.saveProject.mockImplementation(async (_path: string, project: Project) => project);
  ipc.api.listRecentProjects.mockResolvedValue([]);
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("自动保存", () => {
  it("编辑后进入 dirty，停顿 600ms 才落盘", async () => {
    useAppStore.getState().updateMeta({ title: "新标题" });
    expect(useAppStore.getState().saveState).toBe("dirty");
    expect(useAppStore.getState().revision).toBe(1);

    await vi.advanceTimersByTimeAsync(599);
    expect(ipc.api.saveProject).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(ipc.api.saveProject).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().saveState).toBe("saved");
  });

  it("连续编辑只落盘一次，且保存的是最后一版", async () => {
    useAppStore.getState().updateMeta({ title: "A" });
    await vi.advanceTimersByTimeAsync(300);
    useAppStore.getState().updateMeta({ title: "AB" });

    await vi.advanceTimersByTimeAsync(600);

    expect(ipc.api.saveProject).toHaveBeenCalledTimes(1);
    const [, saved] = ipc.api.saveProject.mock.calls[0] as [string, Project];
    expect(saved.meta.title).toBe("AB");
  });

  it("保存返回期间的新编辑不会被后端结果覆盖", async () => {
    let resolveSave: ((value: Project) => void) | undefined;
    ipc.api.saveProject.mockImplementation(
      () =>
        new Promise<Project>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const pending = useAppStore.getState().save();
    expect(useAppStore.getState().saveState).toBe("saving");

    useAppStore.getState().updateMeta({ title: "保存期间的新编辑" });
    resolveSave?.(makeProject({ title: "旧数据" }));
    await pending;

    const state = useAppStore.getState();
    expect(state.project?.meta.title).toBe("保存期间的新编辑");
    expect(state.saveState).toBe("dirty");
  });

  it("没有打开项目时 save 不动后端", async () => {
    reset({ project: null, projectPath: null, saveState: "idle" });
    await useAppStore.getState().save();
    expect(ipc.api.saveProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveState).toBe("idle");
  });

  it("保存失败时置 error 并记录错误对象", async () => {
    ipc.api.saveProject.mockRejectedValue({
      code: "io",
      message: "磁盘满了",
      args: { detail: "满了" },
    });
    await useAppStore.getState().save();

    const state = useAppStore.getState();
    expect(state.saveState).toBe("error");
    expect(state.error?.code).toBe("io");
  });
});

describe("项目开合", () => {
  it("createProject 成功后写入路径并停在立项步骤", async () => {
    ipc.api.createProject.mockResolvedValue({ project: makeProject(), path: "C:/projects/new" });

    const ok = await useAppStore.getState().createProject("C:/projects", "测试项目");

    expect(ok).toBe(true);
    expect(ipc.api.createProject).toHaveBeenCalledWith("C:/projects", "测试项目");
    expect(useAppStore.getState().projectPath).toBe("C:/projects/new");
    expect(useAppStore.getState().currentStep).toBe("project");
    expect(useAppStore.getState().saveState).toBe("saved");
  });

  it("openProject 失败时置错误并返回 false", async () => {
    ipc.api.openProject.mockRejectedValue({ code: "not_found", message: "没有这个目录" });

    const ok = await useAppStore.getState().openProject("C:/nope");

    expect(ok).toBe(false);
    expect(useAppStore.getState().error?.code).toBe("not_found");
    expect(useAppStore.getState().projectPath).toBe(PROJECT_PATH);
  });

  it("closeProject 清空项目并取消待执行的自动保存", async () => {
    useAppStore.getState().updateMeta({ title: "改动" });
    useAppStore.getState().closeProject();

    await vi.advanceTimersByTimeAsync(2000);

    expect(ipc.api.saveProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().project).toBeNull();
    expect(useAppStore.getState().saveState).toBe("idle");
  });
});

describe("bootstrap", () => {
  it("拉取设置与最近项目后置 ready", async () => {
    ipc.api.getSettings.mockResolvedValue(defaultSettings());
    ipc.api.listRecentProjects.mockResolvedValue([
      { path: "C:/projects/demo", name: "测试项目", openedAt: "2026-09-29T00:00:00.000Z" },
    ]);
    reset({ ready: false, recent: [] });

    await useAppStore.getState().bootstrap();

    const state = useAppStore.getState();
    expect(state.ready).toBe(true);
    expect(state.recent).toHaveLength(1);
  });

  it("设置读取失败也要置 ready，避免卡在启动页", async () => {
    ipc.api.getSettings.mockRejectedValue({ code: "internal", message: "boom" });
    reset({ ready: false });

    await useAppStore.getState().bootstrap();

    expect(useAppStore.getState().ready).toBe(true);
    expect(useAppStore.getState().error?.code).toBe("internal");
  });
});
