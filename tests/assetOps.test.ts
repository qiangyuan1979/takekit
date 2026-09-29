/**
 * 资产纯函数测试：工厂默认值、三种出图提示词的一致性锚、尺寸与本地图片 URL。
 *
 * 这里只测"提示词里到底带了哪些一致性锚"——跨图风格是否真的稳定，全靠
 * `styleAnchor` 被拼进每一条提示词；厂商适配器的翻译不在本层职责内。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  assetSrc,
  buildCharacterPrompt,
  buildScenePrompt,
  buildStylePrompt,
  defaultAppearance,
  defaultStyleLock,
  imageSizeFor,
  makeCharacter,
  makeCostume,
  makeProp,
  makeSceneAsset,
  styleAnchor,
  STYLE_OWNER_ID,
} from "../src/lib/assetOps";
import { defaultMeta, type Meta } from "../src/lib/types";

const convertFileSrcMock = vi.mocked(convertFileSrc);

function meta(patch: Partial<Meta> = {}): Meta {
  return { ...defaultMeta(), ...patch };
}

describe("工厂默认值", () => {
  it("makeCharacter 给出全新的空角色，id 带 char- 前缀", () => {
    const character = makeCharacter("林晚");
    expect(character.id.startsWith("char-")).toBe(true);
    expect(character.name).toBe("林晚");
    expect(character.aliases).toEqual([]);
    expect(character.appearance).toEqual(defaultAppearance());
    expect(character.costumes).toEqual([]);
    expect(character.refImages).toEqual([]);
    expect(character.portrait).toBeNull();
  });

  it("工厂的 patch 能覆盖默认字段", () => {
    const character = makeCharacter("林晚", { name: "陆沉", age: "28" });
    expect(character.name).toBe("陆沉");
    expect(character.age).toBe("28");
  });

  it("makeSceneAsset 默认内景、无参考图", () => {
    const scene = makeSceneAsset("出租屋");
    expect(scene.id.startsWith("scene-")).toBe(true);
    expect(scene.interior).toBe(true);
    expect(scene.refImages).toEqual([]);
  });

  it("makeProp 与 makeCostume 都是单图槽位", () => {
    expect(makeProp("怀表").refImage).toBeNull();
    expect(makeCostume().refImage).toBeNull();
    expect(defaultStyleLock()).toEqual({ promptTemplate: "", refImages: [], seed: null });
  });

  it("STYLE_OWNER_ID 是稳定约定，Rust 侧据此落到 assets/style/style/", () => {
    expect(STYLE_OWNER_ID).toBe("style");
  });
});

describe("styleAnchor · 每张图共享的一致性锚", () => {
  it("把画风模板、风格关键词、视觉风格拼在一起", () => {
    const anchor = styleAnchor(defaultStyleLock(), meta());
    expect(typeof anchor).toBe("string");
  });

  it("三者齐备时以「；」串联，顺序为 模板 → 关键词 → 视觉风格", () => {
    const anchor = styleAnchor(
      { promptTemplate: "电影感", refImages: [], seed: null },
      meta({ styleKeywords: ["冷调", "赛博"], visualStyle: "写实" }),
    );
    expect(anchor).toBe("电影感；冷调、赛博；写实");
  });

  it("全空时返回空串，不会污染提示词", () => {
    const anchor = styleAnchor(
      { promptTemplate: "  ", refImages: [], seed: null },
      meta({ styleKeywords: [], visualStyle: "" }),
    );
    expect(anchor).toBe("");
  });
});

describe("buildCharacterPrompt · 定妆照提示词", () => {
  const styleLock = { promptTemplate: "电影感", refImages: [], seed: null };

  it("带上角色名与外貌六项", () => {
    const character = makeCharacter("林晚", {
      gender: "女",
      age: "28",
      appearance: {
        faceShape: "鹅蛋脸",
        hair: "齐肩直发",
        hairColor: "自然黑",
        eyeColor: "丹凤眼",
        height: "170cm 偏瘦",
        body: "左眉有疤",
      },
    });
    const prompt = buildCharacterPrompt(character, styleLock, meta());

    expect(prompt).toContain("角色定妆照：林晚");
    expect(prompt).toContain("女 28");
    expect(prompt).toContain("鹅蛋脸");
    expect(prompt).toContain("左眉有疤");
    expect(prompt).toContain("单人正面半身");
    expect(prompt).toContain("电影感");
  });

  it("传了 costume 就写进「服装：」，且格式是 名：描述", () => {
    const prompt = buildCharacterPrompt(makeCharacter("林晚"), styleLock, meta(), {
      id: "c-1",
      name: "灰西装",
      description: "灰色三件套 + 白衬衫",
      refImage: null,
    });
    expect(prompt).toContain("服装：灰西装：灰色三件套 + 白衬衫");
  });

  it("没有 costume 就不出现「服装：」，也不会是 undefined", () => {
    const prompt = buildCharacterPrompt(makeCharacter("林晚"), styleLock, meta());
    expect(prompt).not.toContain("服装：");
    expect(prompt).not.toContain("undefined");
  });

  it("名字为空时回落到「主角」，不留空白锚点", () => {
    expect(buildCharacterPrompt(makeCharacter(""), styleLock, meta())).toContain(
      "角色定妆照：主角",
    );
  });
});

describe("buildScenePrompt · 场景参考图提示词", () => {
  const styleLock = { promptTemplate: "电影感", refImages: [], seed: null };

  it("内景标注 + 时间天气 + 光线，且强调无人空镜", () => {
    const scene = makeSceneAsset("出租屋", {
      interior: true,
      timeOfDay: "深夜",
      weather: "雨",
      description: "狭小单间，墙皮剥落",
      lighting: "窗外霓虹透进来",
    });
    const prompt = buildScenePrompt(scene, styleLock, meta());

    expect(prompt).toContain("场景参考图：出租屋");
    expect(prompt).toContain("内景");
    expect(prompt).toContain("深夜");
    expect(prompt).toContain("雨");
    expect(prompt).toContain("光线：窗外霓虹透进来");
    expect(prompt).toContain("无人空镜");
    expect(prompt).toContain("电影感");
  });

  it("interior 为 false 时标注「外景」", () => {
    const prompt = buildScenePrompt(makeSceneAsset("天台", { interior: false }), styleLock, meta());
    expect(prompt).toContain("外景");
    expect(prompt).not.toContain("内景");
  });
});

describe("buildStylePrompt · 画风参考图提示词", () => {
  it("标注画风参考图并接上一致性锚", () => {
    const prompt = buildStylePrompt(
      { promptTemplate: "电影感", refImages: [], seed: null },
      meta(),
    );
    expect(prompt).toContain("画风参考图");
    expect(prompt).toContain("电影感");
    expect(prompt).toContain("作为全片所有画面的风格基准");
  });
});

describe("imageSizeFor · 按画幅给尺寸", () => {
  it("竖屏 → 864×1536", () => {
    expect(imageSizeFor("9:16")).toEqual({ width: 864, height: 1536 });
  });
  it("横屏 → 1536×864", () => {
    expect(imageSizeFor("16:9")).toEqual({ width: 1536, height: 864 });
  });
  it("方图 → 1024×1024", () => {
    expect(imageSizeFor("1:1")).toEqual({ width: 1024, height: 1024 });
  });
});

describe("assetSrc · 项目相对路径 → 本地图片 URL", () => {
  it("任一为空都返回空串，且不调用 convertFileSrc", () => {
    convertFileSrcMock.mockClear();
    expect(assetSrc(null, "a.png")).toBe("");
    expect(assetSrc("C:/p", "")).toBe("");
    expect(convertFileSrcMock).not.toHaveBeenCalled();
  });

  it("Windows 反斜杠项目路径拼成反斜杠相对路径", () => {
    expect(assetSrc("C:\\projects\\demo", "assets/character/c1/1.png")).toBe(
      "asset://localhost/C:\\projects\\demo\\assets\\character\\c1\\1.png",
    );
  });

  it("正斜杠项目路径保留正斜杠，并去掉尾部斜杠", () => {
    expect(assetSrc("C:/projects/demo/", "assets/style/1.png")).toBe(
      "asset://localhost/C:/projects/demo/assets/style/1.png",
    );
  });
});
