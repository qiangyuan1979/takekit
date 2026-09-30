/**
 * 新手引导测试：三步文案（这步干什么 / 常见错误 / 示例）齐备，
 * 引导卡默认出现、可「跳过」本步、也能被设置里的总开关整体关闭。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    getSettings: vi.fn(),
    listRecentProjects: vi.fn(),
    listTemplates: vi.fn(),
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
import { OnboardingCard } from "../src/components/OnboardingCard";
import { defaultSettings, type AppSettings } from "../src/lib/types";
import { STEPS, stepById, type StepId } from "../src/state/steps";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

function seedProject(settings: AppSettings, step: StepId = "post"): void {
  useAppStore.setState({
    ready: true,
    project: makeProject({ title: "测试剧" }),
    projectPath: PROJECT_PATH,
    currentStep: step,
    settings,
    error: null,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  ipc.api.getSettings.mockResolvedValue(defaultSettings());
  ipc.api.listRecentProjects.mockResolvedValue([]);
  ipc.api.listTemplates.mockResolvedValue([]);
});

afterEach(cleanup);

describe("STEPS 引导文案", () => {
  it("每一步都带非空的示例文案", () => {
    for (const step of STEPS) {
      expect(step.example.trim().length, `第 ${step.no} 步缺示例`).toBeGreaterThan(0);
      expect(step.goal.trim().length, `第 ${step.no} 步缺这一步干什么`).toBeGreaterThan(0);
      expect(step.tip.trim().length, `第 ${step.no} 步缺常见错误`).toBeGreaterThan(0);
    }
  });
});

describe("<OnboardingCard />", () => {
  it("摆出这步干什么 / 常见错误 / 示例三段，并保留跳过入口", () => {
    const step = stepById("storyboard");
    const onSkip = vi.fn();
    render(<OnboardingCard step={step} onSkip={onSkip} />);

    expect(screen.getByText("这步干什么")).not.toBeNull();
    expect(screen.getByText("常见错误")).not.toBeNull();
    expect(screen.getByText("示例")).not.toBeNull();
    expect(screen.getByText(step.example)).not.toBeNull();

    fireEvent.click(screen.getByText("跳过"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe("<AppShell /> 新手引导", () => {
  it("默认在本步展示引导卡", () => {
    seedProject(defaultSettings());
    render(<AppShell />);

    expect(screen.getByLabelText("第 8 步新手引导")).not.toBeNull();
    expect(screen.getByText(stepById("post").example)).not.toBeNull();
  });

  it("点「跳过」后本步引导消失", () => {
    seedProject(defaultSettings());
    render(<AppShell />);

    fireEvent.click(screen.getByText("跳过"));

    expect(screen.queryByLabelText("第 8 步新手引导")).toBeNull();
  });

  it("设置里关掉引导后不再展示任何引导卡", () => {
    seedProject({ ...defaultSettings(), onboardingEnabled: false });
    ipc.api.getSettings.mockResolvedValue({ ...defaultSettings(), onboardingEnabled: false });
    render(<AppShell />);

    expect(screen.queryByLabelText("第 8 步新手引导")).toBeNull();
    expect(screen.queryByText("新手引导")).toBeNull();
  });
});
