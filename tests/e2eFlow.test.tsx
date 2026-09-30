/**
 * 端到端冒烟：全新用户从「刚建的空项目」一路走到「导出交接包」。
 *
 * 刻意不外接任何模型：第 5 步的帧、第 7 步的片段都直接写回，等价于用本地
 * mock 生成器跑通。沿途每一步都用 `checkStep` 断言门禁由「挡」变「放」，
 * 最后一步才落到真实 UI —— 在出题工作区点「导出交接包」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    saveProject: vi.fn(),
    listVideoProviders: vi.fn(),
    translateVideoRequest: vi.fn(),
    exportHandoverPack: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { PromptsWorkspace } from "../src/components/prompts/PromptsWorkspace";
import { metaPatchFrom } from "../src/lib/templateOps";
import { findTemplate } from "../src/lib/templates";
import type { Project } from "../src/lib/types";
import { generateShotPrompt } from "../src/state/prompts";
import { checkStep } from "../src/state/steps";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/e2e";

/** 推进若干轮微任务，让 useEffect 里的 provider 拉取与 async 编排走完。 */
async function flush(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await Promise.resolve();
    }
  });
}

function current(): Project {
  return useAppStore.getState().project!;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  ipc.api.saveProject.mockImplementation(async (_path: string, project: Project) => project);
  ipc.api.listVideoProviders.mockResolvedValue(["mock"]);
  dialog.open.mockResolvedValue(null);
  dialog.save.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("全新用户走完 v1 全流程", () => {
  it("从空项目到导出交接包，每一步的门禁都由挡变放", async () => {
    // 起点：刚建、什么都还没填的项目。
    useAppStore.setState({
      ready: true,
      project: makeProject({
        title: "",
        genre: "",
        platform: "",
        resolution: "",
        fps: 0,
        episodeDurationMs: 0,
        episodeCount: 0,
      }),
      projectPath: PROJECT_PATH,
      currentStep: "project",
      saveState: "saved",
      revision: 0,
      error: null,
      recent: [],
      templates: [],
      materials: [],
    });

    // 第 1 步 · 立项：套用预设把参数补齐，再起个名字。
    expect(checkStep("project", current()).ok).toBe(false);
    const preset = findTemplate("builtin-meta-urban-drama", [])!;
    useAppStore.getState().updateMeta(metaPatchFrom(preset.payload));
    useAppStore.getState().updateMeta({ title: "重生之我在都市当龙王" });
    expect(checkStep("project", current()).ok).toBe(true);

    // 第 2 步 · 剧本：离线模板补齐 A 段，并起一集一场。
    expect(checkStep("script", current()).ok).toBe(false);
    useAppStore.getState().fillFromTemplate();
    expect(checkStep("script", current()).ok).toBe(true);

    const episodeId = current().episodes[0].id;
    const sceneId = current().episodes[0].scenes[0].id;

    // 第 3 步 · 资产：把 C 段出现、还没建档的角色一键补卡。
    expect(checkStep("assets", current()).ok).toBe(false);
    useAppStore.getState().fillCharactersFromScript();
    expect(checkStep("assets", current()).ok).toBe(true);

    // 第 4 步 · 分镜：拆出第一个镜头。
    expect(checkStep("storyboard", current()).ok).toBe(false);
    useAppStore.getState().addShot(episodeId, sceneId, {
      visualDesc: "林默站在雨中，抬头看向写字楼。",
    });
    expect(checkStep("storyboard", current()).ok).toBe(true);
    const shotId = current().episodes[0].scenes[0].shots[0].id;

    // 第 5 步 · 关键帧：建首帧、放一张候选、定稿。
    expect(checkStep("keyframes", current()).ok).toBe(false);
    const frame = "frames/ep1-sc1-shot1-a.png";
    useAppStore.getState().ensureShotFrame(episodeId, sceneId, shotId, "first");
    useAppStore.getState().addFrameCandidates(episodeId, sceneId, shotId, "first", [frame]);
    useAppStore.getState().adoptFrame(episodeId, sceneId, shotId, "first", frame);
    expect(checkStep("keyframes", current()).ok).toBe(true);

    // 第 6 步 · 出题：给这镜拼出提示词。
    expect(checkStep("prompt", current()).ok).toBe(false);
    generateShotPrompt(episodeId, sceneId, shotId);
    expect(checkStep("prompt", current()).ok).toBe(true);

    // 第 7 步 · 生成：采用一段 mock 生成结果。
    expect(checkStep("generate", current()).ok).toBe(false);
    useAppStore.getState().adoptClip(episodeId, sceneId, shotId, "clip-mock-1");
    expect(checkStep("generate", current()).ok).toBe(true);

    // 收尾：回到出题工作区，用真实 UI 导出交接包。
    useAppStore.setState({ currentStep: "post" });
    ipc.api.exportHandoverPack.mockResolvedValue({
      dir: "D:/handover",
      record: {
        id: "exp-h",
        kind: "handover",
        path: "D:/handover",
        createdAt: "2026-09-30T00:00:00.000Z",
      },
      files: [
        "storyboard.csv",
        "storyboard.json",
        "storyboard.xlsx",
        "prompts.md",
        "params.json",
        "keyframes.json",
        "frames/",
      ],
    });
    dialog.open.mockResolvedValue("D:/handover");

    render(<PromptsWorkspace />);
    await flush();
    const before = current();
    fireEvent.click(screen.getByRole("button", { name: "导出交接包" }));
    await flush();

    expect(ipc.api.exportHandoverPack).toHaveBeenCalledWith(PROJECT_PATH, before, "D:/handover");
    expect(screen.getByTestId("export-status").textContent).toContain("7 个文件");
    expect(current().exports).toHaveLength(1);
    expect(useAppStore.getState().error).toBeNull();
  });
});
