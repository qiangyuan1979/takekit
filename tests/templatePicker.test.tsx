/**
 * 模板选择器测试：下拉套用、存为模板、删除我的模板。
 *
 * 组件本身只负责"把 payload 交出去"和"管理我的模板"，
 * 套用语义由各自的调用方负责，所以在隔离渲染里用 spy 断言 payload 即可。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    saveTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    listTemplates: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { TemplatePicker } from "../src/components/TemplatePicker";
import type { Template } from "../src/lib/types";
import { useAppStore } from "../src/state/store";

function makeTemplate(patch: Partial<Template> = {}): Template {
  return {
    id: "t-1",
    kind: "meta",
    name: "我的都市预设",
    description: "",
    payload: { genre: "都市逆袭" },
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...patch,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  useAppStore.setState({ templates: [] });
});

afterEach(cleanup);

describe("<TemplatePicker />", () => {
  it("列出内置模板，选中即把原始 payload 交给调用方", () => {
    const onApply = vi.fn();
    render(<TemplatePicker kind="meta" label="套用立项预设" onApply={onApply} />);

    expect(screen.queryByText("都市逆袭短剧")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("套用立项预设"), {
      target: { value: "builtin-meta-urban-drama" },
    });

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ genre: "都市逆袭" });
  });

  it("存为模板：把当前内容交给 saveTemplate 并进入我的模板", async () => {
    ipc.api.saveTemplate.mockResolvedValue([makeTemplate()]);
    const capture = vi.fn(() => ({ genre: "悬疑反转" }));
    render(<TemplatePicker kind="meta" label="套用立项预设" onApply={vi.fn()} capture={capture} />);

    fireEvent.click(screen.getByText("存为模板"));
    fireEvent.change(screen.getByPlaceholderText("套用立项预设名称"), {
      target: { value: "我的悬疑预设" },
    });
    fireEvent.click(screen.getByText("确定"));

    await vi.waitFor(() => expect(ipc.api.saveTemplate).toHaveBeenCalledTimes(1));
    expect(ipc.api.saveTemplate.mock.calls[0][0]).toMatchObject({
      id: "",
      kind: "meta",
      name: "我的悬疑预设",
      payload: { genre: "悬疑反转" },
    });
    await vi.waitFor(() => expect(useAppStore.getState().templates).toHaveLength(1));
  });

  it("当前没有可存内容时给出提示且不调用保存", () => {
    render(
      <TemplatePicker kind="meta" label="套用立项预设" onApply={vi.fn()} capture={() => null} />,
    );

    fireEvent.click(screen.getByText("存为模板"));
    fireEvent.click(screen.getByText("确定"));

    expect(ipc.api.saveTemplate).not.toHaveBeenCalled();
    expect(screen.getByText("当前没有可存为模板的内容")).not.toBeNull();
  });

  it("删除我的模板会调用 deleteTemplate", async () => {
    ipc.api.deleteTemplate.mockResolvedValue([]);
    useAppStore.setState({ templates: [makeTemplate()] });
    render(<TemplatePicker kind="meta" label="套用立项预设" onApply={vi.fn()} />);

    fireEvent.click(screen.getByText("管理我的模板（1）"));
    fireEvent.click(screen.getByText("删除"));

    await vi.waitFor(() => expect(ipc.api.deleteTemplate).toHaveBeenCalledWith("t-1"));
  });
});
