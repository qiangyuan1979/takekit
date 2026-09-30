/**
 * 关键帧工作区测试：生成 / 上传 / 定稿 / 删除候选 / 跨镜参考 / 尾帧空态。
 *
 * 图片 provider 与文件对话框都是外部依赖，这里全部 mock；关注点是"点下去之后
 * 有没有按约定落进 `project.json`"，以及尾帧"可选"的空态有没有被正确表达
 * ——新手最容易误以为每一镜都得出满两面帧。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    saveProject: vi.fn(),
    importAssetImage: vi.fn(),
    deleteAssetFiles: vi.fn(),
    deleteAssetDir: vi.fn(),
    generateAssetImages: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

import { KeyframesWorkspace } from "../src/components/keyframes/KeyframesWorkspace";
import { makeFrame } from "../src/lib/frameOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type { Frame, Project, Shot } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

function frameWith(role: Frame["role"], patch: Partial<Frame> = {}): Frame {
  return { ...makeFrame(role), ...patch };
}

function projectWithShots(shots: Shot[]): Project {
  return makeProject(
    {},
    {
      episodes: [
        makeEpisode(1, {
          id: "ep-1",
          scenes: [
            makeScene({
              id: "sc-1",
              no: 1,
              location: "写字楼大堂",
              actionDesc: "他被人拦在门外。",
              shots,
            }),
          ],
        }),
      ],
    },
  );
}

function oneShot(patch: Partial<Shot> = {}): Project {
  return projectWithShots([
    makeShot({
      id: "shot-1",
      episodeId: "ep-1",
      sceneId: "sc-1",
      no: 1,
      visualDesc: "他被人拦在门外。",
      ...patch,
    }),
  ]);
}

/** 两镜：第 2 镜的尾帧已定稿，可作为第 1 镜的跨镜参考。 */
function twoShot(): Project {
  return projectWithShots([
    makeShot({ id: "shot-1", episodeId: "ep-1", sceneId: "sc-1", no: 1, visualDesc: "第一镜。" }),
    makeShot({
      id: "shot-2",
      episodeId: "ep-1",
      sceneId: "sc-1",
      no: 2,
      visualDesc: "第二镜。",
      frames: [frameWith("last", { adopted: "assets/frame/shot-2/last.png" })],
    }),
  ]);
}

function shotInStore(index = 0): Shot {
  return useAppStore.getState().project!.episodes[0].scenes[0].shots[index];
}

function reset(project: Project = oneShot()): void {
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

/** 推进若干轮微任务，让 async 编排（生成/导入/删除 → 写回）走完。 */
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
  dialog.open.mockResolvedValue(null);
  reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<KeyframesWorkspace /> · 空态与汇总", () => {
  it("没有项目 / 没有剧集时给出可操作的提示", () => {
    useAppStore.setState({ project: null });
    const { unmount } = render(<KeyframesWorkspace />);
    expect(screen.getByText(/请先新建或打开一个项目/)).toBeTruthy();
    unmount();

    reset(makeProject());
    render(<KeyframesWorkspace />);
    expect(screen.getByText(/还没有剧集/)).toBeTruthy();
  });

  it("汇总本集镜头数与未定稿首帧数", () => {
    render(<KeyframesWorkspace />);
    expect(screen.getByText(/本集 1 镜，其中 1 镜首帧还没定稿/)).toBeTruthy();
  });

  it("尾帧是可选帧：未建时给「＋ 添加尾帧」，不显示生成按钮", () => {
    render(<KeyframesWorkspace />);
    expect(screen.getByRole("button", { name: /添加尾帧/ })).toBeTruthy();
    // 只有首帧那一面帧有生成按钮
    expect(screen.getAllByRole("button", { name: /生成 4 张候选/ })).toHaveLength(1);
  });

  it("点「＋ 添加尾帧」后补出一面可选尾帧", () => {
    render(<KeyframesWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: /添加尾帧/ }));

    // 首帧以合成空帧渲染、不落库；只有点出来的尾帧真正写进 project.json。
    expect(shotInStore().frames.map((frame) => frame.role)).toEqual(["last"]);
    expect(screen.getAllByRole("button", { name: /生成 4 张候选/ })).toHaveLength(2);
  });
});

describe("<KeyframesWorkspace /> · 生成与上传候选", () => {
  it("点生成会调生成命令并把候选写回", async () => {
    ipc.api.generateAssetImages.mockResolvedValue(["assets/frame/shot-1/gen-1-1.png"]);

    render(<KeyframesWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: /生成 4 张候选/ }));
    await flush();

    expect(ipc.api.generateAssetImages).toHaveBeenCalledTimes(1);
    expect(shotInStore().frames[0].candidates).toEqual(["assets/frame/shot-1/gen-1-1.png"]);
  });

  it("上传图片走导入命令并写回引用", async () => {
    dialog.open.mockResolvedValue(["D:/a.png", "D:/b.png"]);
    ipc.api.importAssetImage
      .mockResolvedValueOnce("assets/frame/shot-1/ref-1.png")
      .mockResolvedValueOnce("assets/frame/shot-1/ref-2.png");

    render(<KeyframesWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: /上传图片/ }));
    await flush();

    expect(ipc.api.importAssetImage).toHaveBeenCalledWith(
      PROJECT_PATH,
      "frame",
      "shot-1",
      "D:/a.png",
    );
    expect(shotInStore().frames[0].candidates).toEqual([
      "assets/frame/shot-1/ref-1.png",
      "assets/frame/shot-1/ref-2.png",
    ]);
  });
});

describe("<KeyframesWorkspace /> · 定稿与删除", () => {
  it("点「设为定稿」把这一面帧钉在选中的候选上，汇总随之归零", () => {
    reset(
      oneShot({
        frames: [
          frameWith("first", {
            candidates: ["assets/frame/shot-1/a.png", "assets/frame/shot-1/b.png"],
          }),
        ],
      }),
    );

    render(<KeyframesWorkspace />);
    fireEvent.click(
      within(screen.getByTestId("frame-first")).getAllByRole("button", { name: "设为定稿" })[0],
    );

    expect(shotInStore().frames[0].adopted).toBe("assets/frame/shot-1/a.png");
    expect(screen.getByText(/本集 1 镜，其中 0 镜首帧还没定稿/)).toBeTruthy();
  });

  it("删除候选会先删文件再摘掉候选", async () => {
    reset(
      oneShot({
        frames: [
          frameWith("first", {
            candidates: ["assets/frame/shot-1/a.png", "assets/frame/shot-1/b.png"],
          }),
        ],
      }),
    );
    ipc.api.deleteAssetFiles.mockResolvedValue(1);

    render(<KeyframesWorkspace />);
    const strip = screen.getByTestId("frame-first");
    fireEvent.click(within(strip).getAllByRole("button", { name: "删除" })[0]);
    await flush();

    expect(ipc.api.deleteAssetFiles).toHaveBeenCalledWith(PROJECT_PATH, [
      "assets/frame/shot-1/a.png",
    ]);
    expect(shotInStore().frames[0].candidates).toEqual(["assets/frame/shot-1/b.png"]);
  });
});

describe("<KeyframesWorkspace /> · 跨镜参考", () => {
  it("下拉只列有定稿帧的其它镜头，选后写进 refShotId", () => {
    reset(twoShot());
    render(<KeyframesWorkspace />);

    const strip = screen.getAllByTestId("frame-first")[0];
    const select = within(strip).getByRole("combobox");
    expect(
      within(select).getByRole("option", { name: "第 1 集 第 1 场 · 镜 2（尾帧）" }),
    ).toBeTruthy();

    fireEvent.change(select, { target: { value: "shot-2" } });

    expect(shotInStore().frames[0].refShotId).toBe("shot-2");
  });
});
