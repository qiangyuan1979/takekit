/**
 * 设置页的「界面」段：界面语言（v1 只有简体中文）与界面字体（内置 + 素材库字体）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: { saveSettings: vi.fn() },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { SettingsPanel } from "../src/components/SettingsPanel";
import { defaultSettings, type Material } from "../src/lib/types";
import { materialFontToken } from "../src/lib/uiFont";
import { useAppStore } from "../src/state/store";

function makeMaterial(patch: Partial<Material> = {}): Material {
  return {
    id: "m-1",
    kind: "font",
    name: "我的圆体",
    ext: "ttf",
    bytes: 1024,
    path: "C:/data/materials/m-1.ttf",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...patch,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  ipc.api.saveSettings.mockImplementation(async (settings: unknown) => settings);
  useAppStore.setState({ settings: defaultSettings(), materials: [], error: null });
});

afterEach(cleanup);

describe("<SettingsPanel /> 界面段", () => {
  it("界面语言在 v1 只有简体中文，并说明原因", () => {
    render(<SettingsPanel onClose={vi.fn()} />);

    const select = screen.getByLabelText("界面语言") as HTMLSelectElement;
    expect(select.value).toBe("zh-CN");
    expect(select.options).toHaveLength(1);
    expect(screen.getByText("v1 只提供简体中文，更多语言在后续版本加入。")).not.toBeNull();
  });

  it("素材库没有字体时，字体下拉只有内置项并引导去素材库导入", () => {
    render(<SettingsPanel onClose={vi.fn()} />);

    const select = screen.getByLabelText("界面字体") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.options).toHaveLength(4);
    expect(screen.queryByText(/素材库 ·/)).toBeNull();
    expect(screen.getByText(/先在顶栏「素材库」里导入字体/)).not.toBeNull();
  });

  it("选中素材库字体后保存，写回设置", async () => {
    useAppStore.setState({ materials: [makeMaterial()] });
    render(<SettingsPanel onClose={vi.fn()} />);

    expect(screen.getByText("素材库 · 我的圆体")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("界面字体"), {
      target: { value: materialFontToken("m-1") },
    });
    fireEvent.click(screen.getByText("保存并关闭"));

    await vi.waitFor(() =>
      expect(useAppStore.getState().settings.uiFont).toBe(materialFontToken("m-1")),
    );
    expect(ipc.api.saveSettings.mock.calls[0][0]).toMatchObject({ uiFont: "font:m-1" });
  });
});
