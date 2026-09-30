/**
 * 界面字体的解析规则（纯函数，不碰 DOM）。
 *
 * 设置里存的是一个「字体令牌」：
 *   - `""`        跟随系统（默认）
 *   - `sans` / `serif` / `kai`  内置字体栈
 *   - `font:<素材 id>`          取自素材库的字体文件
 *
 * 素材字体被删掉后令牌会悬空，这里统一回落到默认，避免界面变成一片方框。
 */

export interface FontPreset {
  id: string;
  label: string;
  stack: string;
}

export const FONT_PRESETS: FontPreset[] = [
  {
    id: "",
    label: "默认（跟随系统）",
    stack: '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  },
  {
    id: "sans",
    label: "无衬线（黑体）",
    stack: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif',
  },
  {
    id: "serif",
    label: "衬线（宋体）",
    stack: 'SimSun, "Songti SC", "Noto Serif SC", serif',
  },
  {
    id: "kai",
    label: "楷体",
    stack: 'KaiTi, "Kaiti SC", STKaiti, serif',
  },
];

/** 素材库字体在 `@font-face` 里注册的族名（所有素材字体共用，靠令牌切换文件）。 */
export const MATERIAL_FONT_FAMILY = "TakeKitFont";

const MATERIAL_PREFIX = "font:";

/** 素材库字体对应的设置令牌。 */
export function materialFontToken(materialId: string): string {
  return `${MATERIAL_PREFIX}${materialId}`;
}

export interface ResolvedFont {
  /** 直接写进 CSS 的 font-family。 */
  family: string;
  /** 命中的素材字体 id；非素材字体时为 null。 */
  materialId: string | null;
}

/** 把令牌解析成可用的 CSS 字体族；令牌无效（含素材已被删）时回落默认。 */
export function resolveUiFont(token: string, fontMaterialIds: readonly string[]): ResolvedFont {
  const fallback: ResolvedFont = { family: FONT_PRESETS[0].stack, materialId: null };
  if (token.startsWith(MATERIAL_PREFIX)) {
    const id = token.slice(MATERIAL_PREFIX.length);
    if (fontMaterialIds.includes(id)) {
      return { family: MATERIAL_FONT_FAMILY, materialId: id };
    }
    return fallback;
  }
  const preset = FONT_PRESETS.find((item) => item.id === token);
  return preset ? { family: preset.stack, materialId: null } : fallback;
}

/** 为素材字体生成一条 `@font-face` 规则（`url` 由调用方转成本地资源地址）。 */
export function materialFontFaceCss(url: string): string {
  return `@font-face{font-family:"${MATERIAL_FONT_FAMILY}";src:url("${url}");}`;
}
