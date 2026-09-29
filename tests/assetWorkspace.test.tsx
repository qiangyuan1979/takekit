/**
 * 资产工作区测试：M3 的验收口径——"剧本里的占位角色 → 角色卡 → 生成定妆照"闭环。
 *
 * 图片 provider 是外部依赖，这里全部 mock 掉；本文件的关注点是"点下去之后
 * 有没有按约定的顺序落进 `project.json`"，以及无 Key 时按钮是否明确禁用。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    createProject: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn(),
    listRecentProjects: vi.fn(),
    duplicateProject: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    llmComplete: vi.fn(),
    llmStream: vi.fn(),
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

import { AssetsWorkspace } from "../src/components/assets/AssetsWorkspace";
import { defaultStyleLock, makeCharacter } from "../src/lib/assetOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { defaultSettings, type AppSettings, type Project } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

function settingsWithImageKey(apiKey: string): AppSettings {
  const base = defaultSettings();
  return { ...base, image: { ...base.image, apiKey } };
}

/** 剧本 C 段里有两个还没建档的名字。 */
function projectWithPendingRefs(): Project {
  return makeProject(
    {},
    {
      episodes: [
        makeEpisode(1, {
          id: "ep-1",
          scenes: [makeScene({ id: "s-1", no: 1, characters: ["林晚", "陆沉"] })],
        }),
      ],
    },
  );
}

/** 剧本与资产已对齐：有一个角色卡「林晚」。 */
function projectWithCharacter(): Project {
  return makeProject(
    {},
    {
      episodes: [
        makeEpisode(1, {
          id: "ep-1",
          scenes: [makeScene({ id: "s-1", no: 1, characters: ["林晚"] })],
        }),
      ],
      assets: {
        characters: [makeCharacter("林晚", { id: "char-1" })],
        scenes: [],
        props: [],
        styleLock: defaultStyleLock(),
      },
    },
  );
}

function reset(project: Project = projectWithPendingRefs(), settings = defaultSettings()): void {
  useAppStore.setState({
    ready: true,
    project,
    projectPath: PROJECT_PATH,
    currentStep: "assets",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
    settings,
  });
}

/** 推进若干轮微任务，让 async 编排（生成/导入 → 写回）走完。 */
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

describe("<AssetsWorkspace /> · 占位 → 资产闭环", () => {
  it("剧本里的未建档角色会列出来，并给出「一键建档（N）」", () => {
    render(<AssetsWorkspace />);

    expect(screen.getByRole("button", { name: /一键建档（2）/ })).toBeTruthy();
    expect(screen.getByText(/这些名字还没有角色卡：林晚、陆沉/)).toBeTruthy();
  });

  it("点一键建档后角色卡建起来，占位提示转为「都已建档」", () => {
    render(<AssetsWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /一键建档/ }));

    const characters = useAppStore.getState().project?.assets.characters ?? [];
    expect(characters.map((character) => character.name)).toEqual(["林晚", "陆沉"]);
    expect(screen.getByText(/剧本里的角色都已建档/)).toBeTruthy();
  });

  it("「＋ 角色」能以空名直接建卡", () => {
    render(<AssetsWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /＋ 角色/ }));

    const characters = useAppStore.getState().project?.assets.characters ?? [];
    expect(characters.length).toBe(1);
    expect(characters[0].name).toBe("");
  });
});

describe("<AssetsWorkspace /> · 生成定妆照", () => {
  it("有图片 Key 时点生成，候选图追加进 refImages 且首张成为基准", async () => {
    reset(projectWithCharacter(), settingsWithImageKey("sk-image"));
    const saved = [
      "assets/character/char-1/01.png",
      "assets/character/char-1/02.png",
      "assets/character/char-1/03.png",
      "assets/character/char-1/04.png",
    ];
    ipc.api.generateAssetImages.mockResolvedValue(saved);

    render(<AssetsWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /生成定妆照（4 张）/ }));
    await flush();

    expect(ipc.api.generateAssetImages).toHaveBeenCalledTimes(1);
    const [path, kind, ownerId, request] = ipc.api.generateAssetImages.mock.calls[0];
    expect(path).toBe(PROJECT_PATH);
    expect(kind).toBe("character");
    expect(ownerId).toBe("char-1");
    expect(request.count).toBe(4);

    const character = useAppStore.getState().project?.assets.characters[0];
    expect(character?.refImages).toEqual(saved);
    expect(character?.portrait).toBe(saved[0]);
  });

  it("没有图片 Key 时生成按钮禁用并说明原因，上传仍可用", () => {
    reset(projectWithCharacter(), defaultSettings());
    render(<AssetsWorkspace />);

    const generate = screen.getByRole("button", {
      name: /生成定妆照（4 张）/,
    }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    expect(screen.getAllByText(/还没配图片模型/).length).toBeGreaterThan(0);

    const upload = screen.getByRole("button", { name: /上传图片/ }) as HTMLButtonElement;
    expect(upload.disabled).toBe(false);
  });

  it("上传图片走导入命令并写回引用", async () => {
    reset(projectWithCharacter(), settingsWithImageKey("sk-image"));
    dialog.open.mockResolvedValue("D:/pics/lin.png");
    ipc.api.importAssetImage.mockResolvedValue("assets/character/char-1/lin.png");

    render(<AssetsWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /上传图片/ }));
    await flush();

    expect(ipc.api.importAssetImage).toHaveBeenCalledWith(
      PROJECT_PATH,
      "character",
      "char-1",
      "D:/pics/lin.png",
    );
    const character = useAppStore.getState().project?.assets.characters[0];
    expect(character?.refImages).toEqual(["assets/character/char-1/lin.png"]);
  });

  it("删除角色卡会先清图片目录再摘卡片", async () => {
    reset(projectWithCharacter(), settingsWithImageKey("sk-image"));
    ipc.api.deleteAssetDir.mockResolvedValue(undefined);

    render(<AssetsWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await flush();

    expect(ipc.api.deleteAssetDir).toHaveBeenCalledWith(PROJECT_PATH, "character", "char-1");
    expect(useAppStore.getState().project?.assets.characters.length).toBe(0);
  });
});
