/**
 * 素材库测试：跨项目复用的最小闭环。
 *
 * 关注三件事：管理弹层能不能导入 / 删除；选择器能不能把库内路径交出去；
 * 资产图片条能不能把库内文件复制进当前项目（复用 `import_asset_image`）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    listMaterials: vi.fn(),
    importMaterial: vi.fn(),
    deleteMaterial: vi.fn(),
    importAssetImage: vi.fn(),
    openProject: vi.fn(),
    listRecentProjects: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

import { ImageStrip } from "../src/components/assets/ImageStrip";
import { MaterialLibrary, MaterialPicker } from "../src/components/MaterialLibrary";
import type { Material } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

function makeMaterial(patch: Partial<Material> = {}): Material {
  return {
    id: "m-1",
    kind: "image",
    name: "角色定妆参考",
    ext: "png",
    bytes: 2048,
    path: "C:/appdata/materials/m-1.png",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...patch,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  useAppStore.setState({ materials: [], project: null, projectPath: PROJECT_PATH, error: null });
});

afterEach(cleanup);

describe("<MaterialLibrary />", () => {
  it("按类别分页签，并显示各有几条", () => {
    useAppStore.setState({
      materials: [makeMaterial(), makeMaterial({ id: "m-2", kind: "audio", name: "片头曲" })],
    });
    render(<MaterialLibrary onClose={vi.fn()} />);

    expect(screen.getByText("图片（1）")).not.toBeNull();
    expect(screen.getByText("音频（1）")).not.toBeNull();
    expect(screen.getByText("字体（0）")).not.toBeNull();
    expect(screen.queryByText("角色定妆参考")).not.toBeNull();
  });

  it("导入：把选中的文件按当前页签类别交给 importMaterial", async () => {
    ipc.api.importMaterial.mockResolvedValue([makeMaterial()]);
    dialog.open.mockResolvedValue("C:/incoming/cover.png");
    render(<MaterialLibrary onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("导入图片"));

    await vi.waitFor(() =>
      expect(ipc.api.importMaterial).toHaveBeenCalledWith(
        "image",
        "C:/incoming/cover.png",
        undefined,
      ),
    );
    await vi.waitFor(() => expect(useAppStore.getState().materials).toHaveLength(1));
  });

  it("删除：调用 deleteMaterial 并刷新列表", async () => {
    ipc.api.deleteMaterial.mockResolvedValue([]);
    useAppStore.setState({ materials: [makeMaterial()] });
    render(<MaterialLibrary onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("删除"));

    await vi.waitFor(() => expect(ipc.api.deleteMaterial).toHaveBeenCalledWith("m-1"));
    await vi.waitFor(() => expect(useAppStore.getState().materials).toHaveLength(0));
  });

  it("空库时给出提示而不是空白", () => {
    render(<MaterialLibrary onClose={vi.fn()} />);
    expect(screen.getByText("这里还没有图片，点下面的按钮导入。")).not.toBeNull();
  });
});

describe("<MaterialPicker />", () => {
  it("空库时提示先去素材库导入", () => {
    render(<MaterialPicker kind="image" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("素材库里还没有图片，先到顶栏「素材库」导入。")).not.toBeNull();
  });

  it("点「选用」把整条素材交给调用方，再关闭", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    useAppStore.setState({ materials: [makeMaterial()] });
    render(<MaterialPicker kind="image" onPick={onPick} onClose={onClose} />);

    fireEvent.click(screen.getByText("选用"));

    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith(makeMaterial()));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("<ImageStrip /> 从素材库选图", () => {
  it("把库内文件复制进当前项目（复用 import_asset_image）", async () => {
    ipc.api.importAssetImage.mockResolvedValue("assets/characters/c1/ref-1.png");
    useAppStore.setState({ materials: [makeMaterial()] });
    render(<ImageStrip kind="character" ownerId="c1" paths={[]} emptyHint="还没有图片" />);

    fireEvent.click(screen.getByText("从素材库选图"));
    fireEvent.click(screen.getByText("选用"));

    await vi.waitFor(() =>
      expect(ipc.api.importAssetImage).toHaveBeenCalledWith(
        PROJECT_PATH,
        "character",
        "c1",
        "C:/appdata/materials/m-1.png",
      ),
    );
  });
});

describe("素材跨项目复用", () => {
  it("在 A 项目上传的图，切到 B 项目仍可用（素材库跨项目共享）", async () => {
    ipc.api.openProject.mockResolvedValue({ project: makeProject(), path: "C:/projects/b" });
    ipc.api.listRecentProjects.mockResolvedValue([]);
    ipc.api.importAssetImage.mockResolvedValue("assets/characters/c9/ref-1.png");
    useAppStore.setState({ materials: [makeMaterial()], projectPath: "C:/projects/a" });

    const opened = await useAppStore.getState().openProject("C:/projects/b");

    expect(opened).toBe(true);
    expect(useAppStore.getState().projectPath).toBe("C:/projects/b");
    // 切项目不清空素材库：库在应用数据目录，与当前项目无关。
    expect(useAppStore.getState().materials).toHaveLength(1);

    // 落点验证：B 项目里的资产图片条仍能把库内文件复制进 B 项目。
    render(<ImageStrip kind="character" ownerId="c9" paths={[]} emptyHint="还没有图片" />);
    fireEvent.click(screen.getByText("从素材库选图"));
    fireEvent.click(screen.getByText("选用"));

    await vi.waitFor(() =>
      expect(ipc.api.importAssetImage).toHaveBeenCalledWith(
        "C:/projects/b",
        "character",
        "c9",
        "C:/appdata/materials/m-1.png",
      ),
    );
  });
});
