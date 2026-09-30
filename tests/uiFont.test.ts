/**
 * 界面字体解析（纯函数）：令牌 → CSS 字体族，素材字体悬空时回落默认。
 */

import { describe, expect, it } from "vitest";
import {
  FONT_PRESETS,
  MATERIAL_FONT_FAMILY,
  materialFontFaceCss,
  materialFontToken,
  resolveUiFont,
} from "../src/lib/uiFont";

describe("resolveUiFont", () => {
  it("空令牌与未知令牌都回落默认字体栈", () => {
    const fallback = FONT_PRESETS[0].stack;
    expect(resolveUiFont("", []).family).toBe(fallback);
    expect(resolveUiFont("不存在", []).family).toBe(fallback);
  });

  it("内置令牌取对应字体栈，且不涉及素材", () => {
    const serif = FONT_PRESETS.find((preset) => preset.id === "serif");
    expect(resolveUiFont("serif", []).family).toBe(serif?.stack);
    expect(resolveUiFont("serif", []).materialId).toBeNull();
  });

  it("素材令牌在素材仍存在时命中素材字体族", () => {
    const token = materialFontToken("m-1");
    expect(resolveUiFont(token, ["m-1"]).family).toBe(MATERIAL_FONT_FAMILY);
    expect(resolveUiFont(token, ["m-1"]).materialId).toBe("m-1");
  });

  it("素材被删后令牌悬空，回落到默认而不是留一片方框", () => {
    const resolved = resolveUiFont(materialFontToken("m-1"), ["m-2"]);
    expect(resolved.materialId).toBeNull();
    expect(resolved.family).toBe(FONT_PRESETS[0].stack);
  });
});

describe("materialFontFaceCss", () => {
  it("产出引用该文件的 @font-face 规则", () => {
    const css = materialFontFaceCss("asset://localhost/C:/fonts/a.ttf");
    expect(css).toContain(`font-family:"${MATERIAL_FONT_FAMILY}"`);
    expect(css).toContain('src:url("asset://localhost/C:/fonts/a.ttf")');
  });
});
