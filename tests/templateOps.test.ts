/**
 * 模板载荷的纯函数测试：白名单提取、非法值丢弃、只补空段的套用语义。
 *
 * 这里的每一句断言都对应「一条格式不对的模板最多不生效」这条底线：
 * 只要校验守住，模板库就永远不会写坏 `project.json`。
 */

import { describe, expect, it } from "vitest";

import { makeShot } from "../src/lib/shotOps";
import {
  cameraSequenceFrom,
  fillPromptBundle,
  metaPatchFrom,
  metaPayloadFrom,
  promptTemplatePayload,
  scriptPatchFrom,
  scriptPayloadFrom,
  shotSeedsFrom,
  shotSeedsPayload,
} from "../src/lib/templateOps";
import { defaultMeta, defaultScript, type PromptBundle, type VideoParams } from "../src/lib/types";

function makeParams(patch: Partial<VideoParams> = {}): VideoParams {
  return {
    durationMs: 3000,
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    motionStrength: 0.5,
    seed: null,
    negativePrompt: "",
    refImages: [],
    firstFrame: null,
    lastFrame: null,
    ...patch,
  };
}

function makeBundle(patch: Partial<PromptBundle> = {}): PromptBundle {
  return {
    unified: { subject: "", environment: "", camera: "", lighting: "", style: "", quality: "" },
    zh: "",
    en: "",
    params: makeParams(),
    perProvider: {},
    ...patch,
  };
}

describe("metaPatchFrom", () => {
  it("只收白名单字段，作品名与未知键一律丢弃", () => {
    const patch = metaPatchFrom({
      title: "不该被模板改写",
      genre: "都市逆袭",
      fps: 25,
      nonsense: 1,
    });

    expect(patch.title).toBeUndefined();
    expect(patch).not.toHaveProperty("nonsense");
    expect(patch.genre).toBe("都市逆袭");
    expect(patch.fps).toBe(25);
  });

  it("非法枚举与非正数被丢弃", () => {
    const patch = metaPatchFrom({ aspectRatio: "5:5", fps: 0, episodeCount: -1 });

    expect(patch.aspectRatio).toBeUndefined();
    expect(patch.fps).toBeUndefined();
    expect(patch.episodeCount).toBeUndefined();
  });

  it("风格关键词过滤空白项", () => {
    const patch = metaPatchFrom({ styleKeywords: ["高对比", "  ", 3] });

    expect(patch.styleKeywords).toEqual(["高对比"]);
  });
});

describe("scriptPatchFrom", () => {
  it("取 A 段六字段与结构 id，lockedFields 不进模板", () => {
    const patch = scriptPatchFrom({
      logline: "一句话",
      structure: "drama-four-act",
      lockedFields: ["logline"],
      unknown: "x",
    });

    expect(patch.logline).toBe("一句话");
    expect(patch.structure).toBe("drama-four-act");
    expect(patch).not.toHaveProperty("lockedFields");
    expect(patch).not.toHaveProperty("unknown");
  });
});

describe("shotSeedsFrom", () => {
  it("丢弃非法枚举、夹紧时长、跳过空对象", () => {
    const seeds = shotSeedsFrom({
      shots: [
        { shotSize: "close_up", cameraMove: "bogus", durationMs: 999_999, visualDesc: "近景" },
        {},
        { transition: "cut" },
      ],
    });

    expect(seeds).toHaveLength(2);
    expect(seeds[0].shotSize).toBe("close_up");
    expect(seeds[0].cameraMove).toBeUndefined();
    expect(seeds[0].durationMs).toBe(20_000);
    expect(seeds[1].transition).toBe("cut");
  });

  it("非数组载荷返回空表", () => {
    expect(shotSeedsFrom({ shots: "nope" })).toEqual([]);
  });
});

describe("cameraSequenceFrom", () => {
  it("只保留合法运镜", () => {
    expect(cameraSequenceFrom({ moves: ["push_in", "bad", "orbit"] })).toEqual([
      "push_in",
      "orbit",
    ]);
  });
});

describe("fillPromptBundle", () => {
  it("只补空段，已写内容原样保留，并刷新中文", () => {
    const bundle = makeBundle({
      unified: {
        subject: "他推开门",
        environment: "",
        camera: "",
        lighting: "",
        style: "",
        quality: "",
      },
    });

    const next = fillPromptBundle(bundle, { lighting: "夜色霓虹", style: "电影质感" });

    expect(next.unified.subject).toBe("他推开门");
    expect(next.unified.lighting).toBe("夜色霓虹");
    expect(next.unified.style).toBe("电影质感");
    expect(next.zh).toContain("夜色霓虹");
  });

  it("没有可补的段时原样返回，不算改动", () => {
    const bundle = makeBundle({
      unified: {
        subject: "x",
        environment: "",
        camera: "",
        lighting: "已有",
        style: "",
        quality: "",
      },
    });

    expect(fillPromptBundle(bundle, { lighting: "新光" })).toBe(bundle);
  });

  it("负向词只补空值", () => {
    const bundle = makeBundle({ params: makeParams({ negativePrompt: "已有负向" }) });
    expect(fillPromptBundle(bundle, { negativePrompt: "模板负向" })).toBe(bundle);
  });
});

describe("反向提炼（存为模板）", () => {
  it("立项载荷可被 metaPatchFrom 还原，且不含作品名", () => {
    const meta = { ...defaultMeta(), genre: "悬疑反转", fps: 24, title: "我的剧" };
    const payload = metaPayloadFrom(meta);

    expect(payload.title).toBeUndefined();
    expect(metaPatchFrom(payload)).toMatchObject({ genre: "悬疑反转", fps: 24 });
  });

  it("剧本载荷可被 scriptPatchFrom 还原", () => {
    const script = { ...defaultScript(), logline: "钩子", structure: "drama-suspense" };
    expect(scriptPatchFrom(scriptPayloadFrom(script))).toMatchObject({
      logline: "钩子",
      structure: "drama-suspense",
    });
  });

  it("分镜载荷可被 shotSeedsFrom 还原结构性字段", () => {
    const shots = [
      makeShot({
        episodeId: "ep-1",
        sceneId: "sc-1",
        shotSize: "long_shot",
        cameraMove: "push_in",
        durationMs: 4000,
      }),
    ];
    const seeds = shotSeedsFrom(shotSeedsPayload(shots));

    expect(seeds).toHaveLength(1);
    expect(seeds[0].shotSize).toBe("long_shot");
    expect(seeds[0].durationMs).toBe(4000);
  });

  it("提示词载荷可被 fillPromptBundle 还原到空 bundle", () => {
    const source = makeBundle({
      unified: {
        subject: "主体",
        environment: "",
        camera: "",
        lighting: "侧逆光",
        style: "胶片",
        quality: "4K",
      },
      params: makeParams({ negativePrompt: "糊" }),
    });

    const payload = promptTemplatePayload(source);
    expect(payload).not.toHaveProperty("subject");

    const target = fillPromptBundle(makeBundle(), payload);
    expect(target.unified.lighting).toBe("侧逆光");
    expect(target.unified.quality).toBe("4K");
    expect(target.params.negativePrompt).toBe("糊");
  });
});
