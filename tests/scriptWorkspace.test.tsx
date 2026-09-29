/**
 * 剧本工作区测试：双栏对照的验收口径——"无 Key 也能用模板填充走完剧本，
 * 有 Key 时结果只落进右栏字段"。
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
    llmStream: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { ScriptWorkspace } from "../src/components/script/ScriptWorkspace";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { defaultSettings, type AppSettings, type Project } from "../src/lib/types";
import { useAiChat } from "../src/state/aiChat";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

function settingsWithKey(apiKey: string): AppSettings {
  const base = defaultSettings();
  return { ...base, llm: { ...base.llm, apiKey } };
}

function projectWithScene(): Project {
  return makeProject(
    {},
    {
      episodes: [makeEpisode(1, { id: "ep-1", scenes: [makeScene({ id: "s-1", no: 1 })] })],
    },
  );
}

function reset(project: Project = makeProject(), settings: AppSettings = defaultSettings()): void {
  useAppStore.setState({
    ready: true,
    project,
    projectPath: "C:/projects/demo",
    currentStep: "script",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
    settings,
  });
  useAiChat.setState({ messages: [], busy: false, instruction: "" });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  ipc.api.saveProject.mockImplementation(async (_path: string, project: Project) => project);
  reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<ScriptWorkspace /> · 无 Key 的离线路径", () => {
  it("提示走模板填充，并显示「模板填充」按钮", () => {
    render(<ScriptWorkspace />);
    expect(screen.getByText(/还没填 LLM API Key/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /模板填充/ })).toBeTruthy();
  });

  it("点模板填充后 A 段出现占位符，C 段出现第一场", () => {
    render(<ScriptWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /模板填充/ }));

    expect(useAppStore.getState().project?.script.logline).toContain("【主角】");
    expect(screen.getAllByDisplayValue(/【主角】/).length).toBeGreaterThan(0);
    expect(screen.getByText("第 1 场")).toBeTruthy();
  });

  it("模板填充出的占位角色进入 D 段「待补角色」", () => {
    render(<ScriptWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: /模板填充/ }));

    // 「出场角色」是整段文本，「待补角色」是逐项列表；这里断言列表项。
    expect(screen.getByText("【主角】", { selector: "li" })).toBeTruthy();
    expect(screen.getByText(/这些名字会被第 3 步变成真正的角色卡/)).toBeTruthy();
  });

  it("没有 Key 时三个 AI 动作按钮全部禁用", () => {
    render(<ScriptWorkspace />);

    for (const label of ["生成", "续写", "重写"]) {
      const buttons = screen.getAllByRole("button", { name: label });
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    }
  });
});

describe("<ScriptWorkspace /> · 有 Key", () => {
  it("提示改为已配置，且 AI 动作可点", () => {
    reset(makeProject(), settingsWithKey("sk-test"));
    render(<ScriptWorkspace />);

    expect(screen.getByText(/已经配置好 LLM/)).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: "生成" })) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe("<ScriptWorkspace /> · 右栏是唯一真相源", () => {
  it("改 C 段地点直接写回 store 并标脏", () => {
    reset(projectWithScene());
    render(<ScriptWorkspace />);

    fireEvent.change(screen.getByPlaceholderText("例如：旧城区出租屋"), {
      target: { value: "旧城区出租屋" },
    });

    expect(useAppStore.getState().project?.episodes[0].scenes[0].location).toBe("旧城区出租屋");
    expect(useAppStore.getState().saveState).toBe("dirty");
  });
});
