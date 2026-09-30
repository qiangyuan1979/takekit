/**
 * 错误文案翻译：Rust 侧错误是英文，展示给新手的中文在这里按 `code` 翻译。
 *
 * 关注两点：通用模板按 code 选中、`args` 占位符被替换；以及交接包不完整
 * （`validation` + `field = "handover"`）走的是单独文案而非通用的「「handover」填写有误」。
 */

import { describe, expect, it } from "vitest";

import { describeError } from "../src/i18n";

describe("describeError", () => {
  it("按 code 选中模板并替换 args 占位符", () => {
    expect(describeError({ code: "io", message: "boom", args: { detail: "磁盘满了" } })).toBe(
      "读写文件失败：磁盘满了",
    );
  });

  it("交接包不完整时用专门文案，而不是通用 validation 模板", () => {
    const text = describeError({
      code: "validation",
      message: "handover pack incomplete",
      args: { field: "handover", detail: "缺少首帧：第 1 集 第 1 场 第 1 镜" },
    });

    expect(text).toBe("交接包还不完整：缺少首帧：第 1 集 第 1 场 第 1 镜");
    expect(text).not.toContain("handover");
  });

  it("其它 validation 字段仍走通用模板", () => {
    expect(
      describeError({
        code: "validation",
        message: "bad format",
        args: { field: "format", detail: "unsupported storyboard format: pdf" },
      }),
    ).toBe("「format」填写有误：unsupported storyboard format: pdf");
  });

  it("未知 code 退回 message 原文", () => {
    expect(describeError({ code: "mystery", message: "说不清哪里错了" })).toBe("说不清哪里错了");
  });
});
