/**
 * 出题编排层测试：生成 / 改参数 / 预览各家请求体 / 导出导入。
 *
 * 编排层只做三件事——解析三层 id、调后端纯翻译命令、落盘 IO；拼装本身由
 * `promptOps` 覆盖。provider 翻译与导出命令都是外部依赖，这里全部 mock，
 * 关注点是"点下去之后有没有按约定落到 state / project.json"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  api: {
    saveProject: vi.fn(),
    translateVideoRequest: vi.fn(),
    exportStoryboard: vi.fn(),
    importStoryboard: vi.fn(),
    exportHandoverPack: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { makeCharacter } from "../src/lib/assetOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type { ExportRecord, Project, Shot } from "../src/lib/types";
import {
  clearShotPrompt,
  exportHandoverPackFile,
  exportStoryboardFile,
  generatePromptBundles,
  generateShotPrompt,
  importStoryboardFile,
  previewProviderBodies,
  updateShotParams,
} from "../src/state/prompts";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

/** 一集一场一镜，带一个角色卡；`patch` 覆盖镜头字段。 */
function projectWithShot(patch: Partial<Shot> = {}): Project {
  return makeProject(
    { aspectRatio: "9:16", resolution: "1080p", fps: 30 },
    {
      episodes: [
        makeEpisode(1, {
          id: "ep-1",
          scenes: [
            makeScene({
              id: "sc-1",
              no: 1,
              location: "写字楼大堂",
              characters: ["林晚"],
              shots: [
                makeShot({
                  id: "shot-1",
                  episodeId: "ep-1",
                  sceneId: "sc-1",
                  no: 1,
                  visualDesc: "他被人拦在门外。",
                  characters: ["林晚"],
                  ...patch,
                }),
              ],
            }),
          ],
        }),
      ],
      assets: {
        characters: [
          makeCharacter("林晚", { id: "char-1", portrait: "assets/character/char-1/p.png" }),
        ],
        scenes: [],
        props: [],
        styleLock: { promptTemplate: "", refImages: [], seed: 7 },
      },
    },
  );
}

function shotInStore(): Shot | undefined {
  return useAppStore.getState().project?.episodes[0].scenes[0].shots[0];
}

function reset(project: Project = projectWithShot()): void {
  useAppStore.setState({
    ready: true,
    project,
    projectPath: PROJECT_PATH,
    currentStep: "prompt",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  ipc.api.saveProject.mockImplementation(async (_path: string, project: Project) => project);
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("generateShotPrompt", () => {
  it("拼出完整 bundle（六段 + 中英成品 + 参数 + 空 perProvider）并写回", () => {
    generateShotPrompt("ep-1", "sc-1", "shot-1");

    const bundle = shotInStore()?.promptBundle;
    expect(bundle).toBeTruthy();
    expect(bundle?.unified.subject).toContain("林晚");
    expect(bundle?.unified.camera).toBeTruthy();
    expect(bundle?.zh.length).toBeGreaterThan(0);
    expect(bundle?.en.length).toBeGreaterThan(0);
    expect(bundle?.params.aspectRatio).toBe("9:16");
    expect(bundle?.params.fps).toBe(30);
    expect(bundle?.params.seed).toBe(7);
    expect(bundle?.perProvider).toEqual({});
  });

  it("定位不到镜头时什么都不写", () => {
    generateShotPrompt("ep-1", "sc-1", "shot-missing");
    expect(shotInStore()?.promptBundle).toBeFalsy();
  });
});

describe("generatePromptBundles", () => {
  it("整场批量出题：每个镜头都拿到 bundle", () => {
    reset(
      makeProject(
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
                    makeShot({ id: "shot-1", episodeId: "ep-1", sceneId: "sc-1", no: 1 }),
                    makeShot({ id: "shot-2", episodeId: "ep-1", sceneId: "sc-1", no: 2 }),
                  ],
                }),
              ],
            }),
          ],
        },
      ),
    );

    generatePromptBundles("ep-1", "sc-1");

    const shots = useAppStore.getState().project?.episodes[0].scenes[0].shots ?? [];
    expect(shots.map((shot) => Boolean(shot.promptBundle))).toEqual([true, true]);
  });
});

describe("clearShotPrompt", () => {
  it("把已出的题清空", () => {
    generateShotPrompt("ep-1", "sc-1", "shot-1");
    expect(shotInStore()?.promptBundle).toBeTruthy();

    clearShotPrompt("ep-1", "sc-1", "shot-1");
    expect(shotInStore()?.promptBundle).toBeNull();
  });
});

describe("updateShotParams", () => {
  it("只改传入的字段，其余保持原样", () => {
    generateShotPrompt("ep-1", "sc-1", "shot-1");

    updateShotParams("ep-1", "sc-1", "shot-1", { fps: 24, seed: null });

    const params = shotInStore()?.promptBundle?.params;
    expect(params?.fps).toBe(24);
    expect(params?.seed).toBeNull();
    expect(params?.resolution).toBe("1080p");
    expect(params?.aspectRatio).toBe("9:16");
  });

  it("还没出题时不动手（不造半成品 bundle）", () => {
    updateShotParams("ep-1", "sc-1", "shot-1", { fps: 24 });
    expect(shotInStore()?.promptBundle).toBeFalsy();
  });
});

describe("previewProviderBodies", () => {
  it("逐家翻译，把请求体缓存进 perProvider", async () => {
    generateShotPrompt("ep-1", "sc-1", "shot-1");
    ipc.api.translateVideoRequest
      .mockResolvedValueOnce({ provider: "kling", body: { model_name: "kling-v1" }, notes: [] })
      .mockResolvedValueOnce({ provider: "jimeng", body: { req_key: "jimeng" }, notes: [] });

    await previewProviderBodies("ep-1", "sc-1", "shot-1", ["kling", "jimeng"]);

    expect(ipc.api.translateVideoRequest).toHaveBeenCalledTimes(2);
    expect(ipc.api.translateVideoRequest.mock.calls[0][0]).toBe("kling");
    const perProvider = shotInStore()?.promptBundle?.perProvider;
    expect(perProvider).toEqual({
      kling: { model_name: "kling-v1" },
      jimeng: { req_key: "jimeng" },
    });
  });

  it("翻译失败时收敛到全局错误条，不写回半截结果", async () => {
    generateShotPrompt("ep-1", "sc-1", "shot-1");
    ipc.api.translateVideoRequest.mockRejectedValue(new Error("翻译失败"));

    await previewProviderBodies("ep-1", "sc-1", "shot-1", ["kling"]);

    expect(useAppStore.getState().error).toBeTruthy();
    expect(shotInStore()?.promptBundle?.perProvider).toEqual({});
  });

  it("还没出题时直接返回，不调翻译命令", async () => {
    await previewProviderBodies("ep-1", "sc-1", "shot-1", ["kling"]);
    expect(ipc.api.translateVideoRequest).not.toHaveBeenCalled();
  });
});

describe("exportStoryboardFile", () => {
  const record: ExportRecord = {
    id: "exp-1",
    kind: "storyboard",
    path: "D:/out/分镜表.csv",
    createdAt: "2026-09-30T00:00:00.000Z",
  };

  it("导出成功后登记一条记录", async () => {
    ipc.api.exportStoryboard.mockResolvedValue(record);
    const before = useAppStore.getState().project;

    const result = await exportStoryboardFile("csv", "D:/out/分镜表.csv");

    expect(ipc.api.exportStoryboard).toHaveBeenCalledWith(before, "csv", "D:/out/分镜表.csv");
    expect(result).toEqual(record);
    expect(useAppStore.getState().project?.exports).toEqual([record]);
  });

  it("失败返回 null 并置错误，不登记记录", async () => {
    ipc.api.exportStoryboard.mockRejectedValue(new Error("写盘失败"));

    const result = await exportStoryboardFile("csv", "D:/out/分镜表.csv");

    expect(result).toBeNull();
    expect(useAppStore.getState().error).toBeTruthy();
    expect(useAppStore.getState().project?.exports).toEqual([]);
  });

  it("没有目标路径时不动手", async () => {
    const result = await exportStoryboardFile("csv", "");
    expect(result).toBeNull();
    expect(ipc.api.exportStoryboard).not.toHaveBeenCalled();
  });
});

describe("importStoryboardFile", () => {
  it("用后端返回的项目整体替换，并返回覆盖结果", async () => {
    const imported = projectWithShot({ visualDesc: "导入后的描述。" });
    ipc.api.importStoryboard.mockResolvedValue({ project: imported, updated: 1, skipped: 0 });

    const outcome = await importStoryboardFile("D:/out/分镜表.csv");

    expect(outcome).toEqual({ project: imported, updated: 1, skipped: 0 });
    expect(useAppStore.getState().project).toBe(imported);
  });

  it("失败返回 null 并置错误，原项目不动", async () => {
    const before = useAppStore.getState().project;
    ipc.api.importStoryboard.mockRejectedValue(new Error("读盘失败"));

    const outcome = await importStoryboardFile("D:/out/分镜表.csv");

    expect(outcome).toBeNull();
    expect(useAppStore.getState().error).toBeTruthy();
    expect(useAppStore.getState().project).toBe(before);
  });
});

describe("exportHandoverPackFile", () => {
  const record: ExportRecord = {
    id: "exp-2",
    kind: "handover",
    path: "D:/handover",
    createdAt: "2026-09-30T00:00:00.000Z",
  };

  it("用 projectPath + project 调命令，并登记记录", async () => {
    ipc.api.exportHandoverPack.mockResolvedValue({
      dir: "D:/handover",
      record,
      files: ["storyboard.csv", "prompts.md"],
    });
    const before = useAppStore.getState().project;

    const outcome = await exportHandoverPackFile("D:/handover");

    expect(ipc.api.exportHandoverPack).toHaveBeenCalledWith(PROJECT_PATH, before, "D:/handover");
    expect(outcome?.files).toHaveLength(2);
    expect(useAppStore.getState().project?.exports).toEqual([record]);
  });

  it("项目还没落盘（没有 projectPath）时不调命令", async () => {
    useAppStore.setState({ projectPath: null });

    const outcome = await exportHandoverPackFile("D:/handover");

    expect(outcome).toBeNull();
    expect(ipc.api.exportHandoverPack).not.toHaveBeenCalled();
  });

  it("交接包不完整时失败：返回 null、置错误，不登记记录", async () => {
    ipc.api.exportHandoverPack.mockRejectedValue({
      code: "validation",
      message: "handover pack incomplete",
      args: { field: "handover", detail: "缺少首帧：第 1 集 第 1 场 第 1 镜" },
    });

    const outcome = await exportHandoverPackFile("D:/handover");

    expect(outcome).toBeNull();
    expect(useAppStore.getState().error?.code).toBe("validation");
    expect(useAppStore.getState().error?.args?.field).toBe("handover");
    expect(useAppStore.getState().project?.exports).toEqual([]);
  });
});
