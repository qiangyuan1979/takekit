/**
 * 关键帧编排层测试：生成/导入/删除候选，以及删镜头时先清图片目录。
 *
 * 编排层的规矩与资产图片同构——**先落盘、再写引用**：文件操作成功后才写回
 * `project.json`；失败收敛到全局错误条，不把用户已定稿的东西抹掉。图片 provider
 * 是外部依赖，这里全部 mock，关注点是"点下去之后有没有按约定的顺序落到 state"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  api: {
    saveProject: vi.fn(),
    generateAssetImages: vi.fn(),
    importAssetImage: vi.fn(),
    deleteAssetFiles: vi.fn(),
    deleteAssetDir: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { makeCharacter } from "../src/lib/assetOps";
import { makeFrame } from "../src/lib/frameOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type { Frame, Project, Shot } from "../src/lib/types";
import {
  deleteFrameCandidate,
  generateFrameCandidates,
  importFrameCandidates,
  removeShotWithFrames,
} from "../src/state/keyframes";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";
const LIN_PORTRAIT = "assets/character/char-1/portrait.png";
const STYLE_REF = "assets/style/style/01.png";

function frameWith(role: Frame["role"], patch: Partial<Frame> = {}): Frame {
  return { ...makeFrame(role), ...patch };
}

/** 一集一场一镜，带一个角色卡与画风锁；`patch` 覆盖镜头字段。 */
function projectWithShot(patch: Partial<Shot> = {}): Project {
  return makeProject(
    { aspectRatio: "9:16" },
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
        characters: [makeCharacter("林晚", { id: "char-1", portrait: LIN_PORTRAIT })],
        scenes: [],
        props: [],
        styleLock: { promptTemplate: "统一色调", refImages: [STYLE_REF], seed: 7 },
      },
    },
  );
}

function shotInStore(): Shot | undefined {
  return useAppStore.getState().project?.episodes[0].scenes[0].shots[0];
}

function sceneShots(): Shot[] {
  return useAppStore.getState().project?.episodes[0].scenes[0].shots ?? [];
}

function reset(project: Project = projectWithShot()): void {
  useAppStore.setState({
    ready: true,
    project,
    projectPath: PROJECT_PATH,
    currentStep: "keyframes",
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

describe("generateFrameCandidates", () => {
  it("按「角色 → 画风」收集参考图，透传 seed/count/尺寸并把结果写回候选池", async () => {
    ipc.api.generateAssetImages.mockResolvedValue([
      "assets/frame/shot-1/gen-1-1.png",
      "assets/frame/shot-1/gen-1-2.png",
    ]);

    await generateFrameCandidates("ep-1", "sc-1", "shot-1", "first");

    expect(ipc.api.generateAssetImages).toHaveBeenCalledTimes(1);
    const [path, kind, ownerId, request] = ipc.api.generateAssetImages.mock.calls[0];
    expect(path).toBe(PROJECT_PATH);
    expect(kind).toBe("frame");
    expect(ownerId).toBe("shot-1");
    expect(request.count).toBe(4);
    expect(request.seed).toBe(7);
    expect(request.width).toBe(864);
    expect(request.height).toBe(1536);
    expect(request.refImages).toEqual([LIN_PORTRAIT, STYLE_REF]);
    expect(request.prompt).toContain("关键帧：第 1 集 第 1 场 · 镜 1 · 首帧");

    const frame = shotInStore()?.frames[0];
    expect(frame).toMatchObject({
      role: "first",
      candidates: ["assets/frame/shot-1/gen-1-1.png", "assets/frame/shot-1/gen-1-2.png"],
    });
  });

  it("可以指定张数；目标帧不存在时由写回自动补建", async () => {
    ipc.api.generateAssetImages.mockResolvedValue(["assets/frame/shot-1/last.png"]);

    await generateFrameCandidates("ep-1", "sc-1", "shot-1", "last", { count: 2 });

    expect(ipc.api.generateAssetImages.mock.calls[0][3].count).toBe(2);
    const frame = shotInStore()?.frames.find((item) => item.role === "last");
    expect(frame?.candidates).toEqual(["assets/frame/shot-1/last.png"]);
  });

  it("定位不到镜头时什么都不做", async () => {
    await generateFrameCandidates("ep-1", "sc-1", "shot-missing", "first");
    expect(ipc.api.generateAssetImages).not.toHaveBeenCalled();
  });

  it("生成失败时收敛到全局错误条，不写回任何候选", async () => {
    ipc.api.generateAssetImages.mockRejectedValue(new Error("生成失败"));

    await generateFrameCandidates("ep-1", "sc-1", "shot-1", "first");

    expect(useAppStore.getState().error).toBeTruthy();
    expect(shotInStore()?.frames).toHaveLength(0);
  });
});

describe("importFrameCandidates", () => {
  it("逐张导入本地图片并写回候选", async () => {
    ipc.api.importAssetImage
      .mockResolvedValueOnce("assets/frame/shot-1/ref-1.png")
      .mockResolvedValueOnce("assets/frame/shot-1/ref-2.png");

    await importFrameCandidates("ep-1", "sc-1", "shot-1", "first", ["D:/a.png", "D:/b.png"]);

    expect(ipc.api.importAssetImage).toHaveBeenNthCalledWith(
      1,
      PROJECT_PATH,
      "frame",
      "shot-1",
      "D:/a.png",
    );
    expect(ipc.api.importAssetImage).toHaveBeenNthCalledWith(
      2,
      PROJECT_PATH,
      "frame",
      "shot-1",
      "D:/b.png",
    );
    expect(shotInStore()?.frames[0].candidates).toEqual([
      "assets/frame/shot-1/ref-1.png",
      "assets/frame/shot-1/ref-2.png",
    ]);
  });

  it("没有选到文件时不动 state", async () => {
    await importFrameCandidates("ep-1", "sc-1", "shot-1", "first", []);
    expect(ipc.api.importAssetImage).not.toHaveBeenCalled();
    expect(shotInStore()?.frames).toHaveLength(0);
  });
});

describe("deleteFrameCandidate", () => {
  it("先删文件再摘候选；删的正是定稿时定稿一并清空", async () => {
    reset(
      projectWithShot({
        frames: [frameWith("first", { candidates: ["a.png", "b.png"], adopted: "a.png" })],
      }),
    );
    ipc.api.deleteAssetFiles.mockResolvedValue(1);

    await deleteFrameCandidate("ep-1", "sc-1", "shot-1", "first", "a.png");

    expect(ipc.api.deleteAssetFiles).toHaveBeenCalledWith(PROJECT_PATH, ["a.png"]);
    const frame = shotInStore()?.frames[0];
    expect(frame?.candidates).toEqual(["b.png"]);
    expect(frame?.adopted).toBeNull();
  });
});

describe("removeShotWithFrames", () => {
  it("先清关键帧目录、再删镜头，避免留下孤儿目录", async () => {
    ipc.api.deleteAssetDir.mockImplementation(async () => {
      // 删目录的这一刻，镜头还在 project.json 里
      expect(sceneShots()).toHaveLength(1);
      return 0;
    });

    await removeShotWithFrames("ep-1", "sc-1", "shot-1");

    expect(ipc.api.deleteAssetDir).toHaveBeenCalledWith(PROJECT_PATH, "frame", "shot-1");
    expect(sceneShots()).toHaveLength(0);
  });
});
