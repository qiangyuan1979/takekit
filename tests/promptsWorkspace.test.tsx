/**
 * 出题工作区测试：汇总、逐镜出题、六段编辑、各家请求体预览、导出与导入。
 *
 * provider 翻译、导出命令、文件对话框都是外部依赖，全部 mock；关注点是
 * "点下去之后有没有按约定落进 `project.json`"，以及给新手的措辞是否可操作。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    saveProject: vi.fn(),
    listVideoProviders: vi.fn(),
    translateVideoRequest: vi.fn(),
    exportStoryboard: vi.fn(),
    importStoryboard: vi.fn(),
    exportHandoverPack: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { PromptsWorkspace } from "../src/components/prompts/PromptsWorkspace";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type { ExportRecord, Project, Shot } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

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
              shots: [
                makeShot({
                  id: "shot-1",
                  episodeId: "ep-1",
                  sceneId: "sc-1",
                  no: 1,
                  visualDesc: "他被人拦在门外。",
                  ...patch,
                }),
              ],
            }),
          ],
        }),
      ],
    },
  );
}

function shotInStore(index = 0): Shot {
  return useAppStore.getState().project!.episodes[0].scenes[0].shots[index];
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

/** 推进若干轮微任务，让 useEffect 里的 provider 拉取与 async 编排走完。 */
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
  ipc.api.listVideoProviders.mockResolvedValue(["kling", "jimeng"]);
  dialog.open.mockResolvedValue(null);
  dialog.save.mockResolvedValue(null);
  reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<PromptsWorkspace /> · 空态与汇总", () => {
  it("没有项目 / 没有剧集时给出可操作的提示", () => {
    useAppStore.setState({ project: null });
    const { unmount } = render(<PromptsWorkspace />);
    expect(screen.getByText(/请先新建或打开一个项目/)).toBeTruthy();
    unmount();

    reset(makeProject());
    render(<PromptsWorkspace />);
    expect(screen.getByText(/还没有剧集/)).toBeTruthy();
  });

  it("汇总本集镜头数与未出题数", async () => {
    render(<PromptsWorkspace />);
    await flush();
    expect(screen.getByText(/本集 1 镜，其中 1 镜还没出题/)).toBeTruthy();
  });
});

describe("<PromptsWorkspace /> · 出题", () => {
  it("点「生成提示词」把 bundle 写回，卡片转为已出题并露出六段", async () => {
    render(<PromptsWorkspace />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "生成提示词" }));

    expect(shotInStore().promptBundle).toBeTruthy();
    expect(screen.getByText("已出题")).toBeTruthy();
    expect(screen.getByTestId("prompt-sections")).toBeTruthy();
    expect(screen.getByText(/本集 1 镜，其中 0 镜还没出题/)).toBeTruthy();
  });

  it("点「整集出题」批量补齐本集所有镜头", async () => {
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

    render(<PromptsWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "整集出题" }));

    const shots = useAppStore.getState().project!.episodes[0].scenes[0].shots;
    expect(shots.every((shot) => Boolean(shot.promptBundle))).toBe(true);
    expect(screen.getByText(/本集 2 镜，其中 0 镜还没出题/)).toBeTruthy();
  });

  it("改六段中的一段会重算中文成品", async () => {
    render(<PromptsWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "生成提示词" }));

    const sections = within(screen.getByTestId("prompt-sections")).getAllByRole("textbox");
    fireEvent.change(sections[0], { target: { value: "外卖员站在门外" } });

    const bundle = shotInStore().promptBundle!;
    expect(bundle.unified.subject).toBe("外卖员站在门外");
    expect(bundle.zh.startsWith("外卖员站在门外")).toBe(true);
  });
});

describe("<PromptsWorkspace /> · 各家请求体预览", () => {
  it("列出后端支持的厂商，点预览把请求体缓存并渲染出来", async () => {
    render(<PromptsWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "生成提示词" }));

    expect(screen.getByRole("button", { name: /预览 可灵 请求体/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /预览 即梦 请求体/ })).toBeTruthy();

    ipc.api.translateVideoRequest.mockResolvedValue({
      provider: "kling",
      body: { model_name: "kling-v1" },
      notes: [],
    });

    fireEvent.click(screen.getByRole("button", { name: /预览 可灵 请求体/ }));
    await flush();

    expect(ipc.api.translateVideoRequest).toHaveBeenCalledWith("kling", "", expect.anything());
    const body = screen.getByTestId("provider-kling");
    expect(body.textContent).toContain("kling-v1");
  });
});

describe("<PromptsWorkspace /> · 导出与交接", () => {
  const record: ExportRecord = {
    id: "exp-1",
    kind: "storyboard",
    path: "D:/out/分镜表.xlsx",
    createdAt: "2026-09-30T00:00:00.000Z",
  };

  it("选格式后导出分镜表并登记记录", async () => {
    ipc.api.exportStoryboard.mockResolvedValue(record);
    dialog.save.mockResolvedValue("D:/out/分镜表.xlsx");

    render(<PromptsWorkspace />);
    await flush();

    const row = screen.getByText("分镜表").closest(".export-row") as HTMLElement;
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "xlsx" } });
    const before = useAppStore.getState().project;
    fireEvent.click(within(row).getByRole("button", { name: "导出" }));
    await flush();

    expect(ipc.api.exportStoryboard).toHaveBeenCalledWith(before, "xlsx", "D:/out/分镜表.xlsx");
    expect(useAppStore.getState().project!.exports).toEqual([record]);
    expect(screen.getByTestId("export-status").textContent).toContain("已导出分镜表");
  });

  it("导入并覆盖后回报覆盖 / 跳过行数", async () => {
    const imported = projectWithShot({ visualDesc: "导入后的描述。" });
    ipc.api.importStoryboard.mockResolvedValue({ project: imported, updated: 3, skipped: 1 });
    dialog.open.mockResolvedValue("D:/out/分镜表.csv");

    render(<PromptsWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "导入并覆盖" }));
    await flush();

    expect(useAppStore.getState().project).toBe(imported);
    expect(screen.getByTestId("export-status").textContent).toContain("覆盖 3 镜，跳过 1 行");
  });

  it("导出交接包并回报目录与文件数", async () => {
    ipc.api.exportHandoverPack.mockResolvedValue({
      dir: "D:/handover",
      record: { ...record, kind: "handover" },
      files: ["storyboard.csv", "prompts.md"],
    });
    dialog.open.mockResolvedValue("D:/handover");

    render(<PromptsWorkspace />);
    await flush();
    const before = useAppStore.getState().project;
    fireEvent.click(screen.getByRole("button", { name: "导出交接包" }));
    await flush();

    expect(ipc.api.exportHandoverPack).toHaveBeenCalledWith(PROJECT_PATH, before, "D:/handover");
    expect(screen.getByTestId("export-status").textContent).toContain("2 个文件");
  });

  it("交接包缺关键帧时，导出失败并指出缺什么", async () => {
    // 后端在导出前会做完整性校验：缺首帧就直接拒绝，而不是产出一个残包。
    ipc.api.exportHandoverPack.mockRejectedValue({
      code: "validation",
      message: "缺少首帧：第 1 集 第 1 场 · 镜 1",
      args: { field: "handover" },
    });
    dialog.open.mockResolvedValue("D:/handover");

    render(<PromptsWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "导出交接包" }));
    await flush();

    expect(screen.getByTestId("export-status").textContent).toContain("导出交接包失败");
    expect(useAppStore.getState().error?.message).toContain("缺少首帧");
    // 失败不登记导出记录，项目里不该多出一条假记录。
    expect(useAppStore.getState().project!.exports).toEqual([]);
  });
});
