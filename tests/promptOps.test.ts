/**
 * 出题层（第 6 步）纯函数测试。
 *
 * 这一层的职责是"确定性地把前面几步拍板过的信息一个不漏地带下来"：
 * 断言因此落在"六段到底拼了什么、受控词汇翻成哪个英文词、默认参数来自哪里"。
 * 体检规则与门禁口径（`shotsWithoutPrompt`）是新手最容易踩坑的两处，单独覆盖。
 */

import { describe, expect, it } from "vitest";

import { makeCharacter, makeSceneAsset } from "../src/lib/assetOps";
import { makeFrame } from "../src/lib/frameOps";
import {
  DEFAULT_MOTION_STRENGTH,
  DEFAULT_NEGATIVE_PROMPT,
  PROMPT_SECTIONS,
  PROMPT_WARN_CHARS,
  buildPromptBundle,
  buildUnifiedPrompt,
  bundleToJson,
  cameraMoveEn,
  checkPromptHealth,
  composeEn,
  composeZh,
  defaultVideoParams,
  glossaryFor,
  shotSizeEn,
  shotsWithoutPrompt,
} from "../src/lib/promptOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type { Character, Project, PromptBundle, Scene, Shot, VideoParams } from "../src/lib/types";
import { makeProject } from "./support/project";

const FIRST_PNG = "assets/frame/shot-1/first.png";
const LAST_PNG = "assets/frame/shot-1/last.png";

interface BuildArgs {
  shot?: Partial<Shot>;
  scene?: Partial<Scene>;
  characters?: Character[];
  sceneAssets?: ReturnType<typeof makeSceneAsset>[];
}

/** 一个"锚都齐"的项目：一角色 + 一场景卡 + 画风锁，一个镜头（首尾帧都已定稿）。 */
function richProject(build: BuildArgs = {}): {
  project: Project;
  episode: ReturnType<typeof makeEpisode>;
  scene: Scene;
  shot: Shot;
} {
  const scene = makeScene({
    id: "sc-1",
    no: 1,
    location: "写字楼大堂",
    timeOfDay: "夜晚",
    interior: true,
    characters: ["林晚"],
    ...build.scene,
  });
  const shot = makeShot({
    id: "shot-1",
    episodeId: "ep-1",
    sceneId: "sc-1",
    no: 1,
    shotSize: "medium_shot",
    cameraMove: "push_in",
    durationMs: 3000,
    visualDesc: "他被人拦在门外。",
    characters: ["林晚"],
    frames: [
      { ...makeFrame("first"), adopted: FIRST_PNG },
      { ...makeFrame("last"), adopted: LAST_PNG },
    ],
    ...build.shot,
  });
  scene.shots = [shot];

  const episode = makeEpisode(1, { id: "ep-1", scenes: [scene] });
  const project = makeProject(
    {
      visualStyle: "实拍写实感",
      styleKeywords: ["冷色", "高对比"],
      mood: "爽",
    },
    {
      episodes: [episode],
      assets: {
        characters: build.characters ?? [
          makeCharacter("林晚", {
            id: "char-1",
            gender: "女",
            age: "25",
            appearance: {
              faceShape: "鹅蛋脸",
              hair: "长发",
              hairColor: "黑",
              eyeColor: "",
              height: "",
              body: "",
            },
          }),
        ],
        scenes: build.sceneAssets ?? [
          makeSceneAsset("写字楼大堂", {
            id: "sca-1",
            lighting: "冷白光",
            weather: "小雨",
            description: "大理石地面",
          }),
        ],
        props: [],
        styleLock: { promptTemplate: "统一色调", refImages: [], seed: 7 },
      },
    },
  );

  return { project, episode, scene, shot };
}

const GOLDEN = {
  subject: "林晚（女25）鹅蛋脸，长发，黑；他被人拦在门外。",
  environment: "内景 写字楼大堂，夜晚，小雨，大理石地面",
  camera: "中景，推近",
  lighting: "冷白光，爽的情绪基调",
  style: "统一色调；冷色、高对比；实拍写实感",
  quality: "电影级质感，细节清晰，构图稳定，无明显畸变",
};

describe("buildUnifiedPrompt · 六段拼装（主体 → 环境 → 镜头 → 光线 → 风格 → 画质）", () => {
  it("字段齐全时把角色卡、场景卡、画风锁与立项信息全部带上", () => {
    const { project, episode, scene, shot } = richProject();
    expect(buildUnifiedPrompt({ project, episode, scene, shot })).toEqual(GOLDEN);
  });

  it("角色卡缺失时保留镜头里写的原文，不凭空编造外观", () => {
    const { project, episode, scene, shot } = richProject({
      shot: { characters: ["神秘人"], visualDesc: "" },
    });
    const unified = buildUnifiedPrompt({ project, episode, scene, shot });
    expect(unified.subject).toBe("神秘人");
  });

  it("没有场景卡时只带场记里的内/外景、地点与时间", () => {
    const { project, episode, scene, shot } = richProject({ sceneAssets: [] });
    const unified = buildUnifiedPrompt({ project, episode, scene, shot });
    expect(unified.environment).toBe("内景 写字楼大堂，夜晚");
    expect(unified.lighting).toBe("爽的情绪基调");
  });

  it("既无角色也无画面描述时主体为空（交给体检提示，不在这里造字）", () => {
    const { project, episode, scene, shot } = richProject({
      shot: { characters: [], visualDesc: "" },
    });
    expect(buildUnifiedPrompt({ project, episode, scene, shot }).subject).toBe("");
  });
});

describe("composeZh / composeEn · 中英同时产出", () => {
  it("中文六段以逗号串联、以句号收尾，段尾标点被去掉不重复", () => {
    const { project, episode, scene, shot } = richProject();
    const unified = buildUnifiedPrompt({ project, episode, scene, shot });
    expect(composeZh(unified)).toBe(
      "林晚（女25）鹅蛋脸，长发，黑；他被人拦在门外，内景 写字楼大堂，夜晚，小雨，大理石地面，中景，推近，冷白光，爽的情绪基调，统一色调；冷色、高对比；实拍写实感，电影级质感，细节清晰，构图稳定，无明显畸变。",
    );
  });

  it("英文的景别与运镜走词典，自由描述沿用原文", () => {
    const { project, episode, scene, shot } = richProject();
    const en = composeEn({ project, episode, scene, shot });
    expect(en).toContain("medium shot, slow push-in");
    expect(en).toContain("cinematic quality, sharp details");
    expect(en.endsWith(".")).toBe(true);
  });

  it("受控词汇的英文对照覆盖全部枚举值", () => {
    expect(shotSizeEn("medium_shot")).toBe("medium shot");
    expect(shotSizeEn("extreme_close_up")).toBe("extreme close-up");
    expect(cameraMoveEn("push_in")).toBe("slow push-in");
    expect(cameraMoveEn("static_shot")).toBe("static camera");
  });
});

describe("defaultVideoParams / buildPromptBundle · 参数层默认值", () => {
  it("画幅/分辨率/帧率取自立项，运动强度取默认值，种子取画风锁", () => {
    const { project, shot } = richProject();
    expect(defaultVideoParams(project, shot)).toEqual({
      durationMs: 3000,
      aspectRatio: "9:16",
      resolution: "1080x1920",
      fps: 30,
      motionStrength: DEFAULT_MOTION_STRENGTH,
      seed: 7,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      refImages: [],
      firstFrame: FIRST_PNG,
      lastFrame: LAST_PNG,
    });
  });

  it("时长就近取整到合法区间；没有帧时首尾帧为 null", () => {
    const { project, shot } = richProject({ shot: { durationMs: 100, frames: [] } });
    const params = defaultVideoParams(project, shot);
    expect(params.durationMs).toBe(500);
    expect(params.firstFrame).toBeNull();
    expect(params.lastFrame).toBeNull();
  });

  it("打包出的 bundle：六段 + 中英提示词 + 参数，各家请求体初始为空", () => {
    const { project, episode, scene, shot } = richProject();
    const args = { project, episode, scene, shot };
    const bundle = buildPromptBundle(args);

    expect(bundle.unified).toEqual(GOLDEN);
    expect(bundle.zh).toBe(composeZh(bundle.unified));
    expect(bundle.en).toBe(composeEn(args));
    expect(bundle.params).toEqual(defaultVideoParams(project, shot));
    expect(bundle.perProvider).toEqual({});
  });

  it("bundleToJson 可无损往返（一键复制用）", () => {
    const { project, episode, scene, shot } = richProject();
    const bundle = buildPromptBundle({ project, episode, scene, shot });
    expect(JSON.parse(bundleToJson(bundle))).toEqual(bundle);
  });
});

function baseBundle(): PromptBundle {
  return {
    unified: {
      subject: "林晚在门前",
      environment: "内景 写字楼大堂",
      camera: "中景，固定镜头",
      lighting: "冷白光",
      style: "统一色调",
      quality: "电影级质感",
    },
    zh: "林晚在门前，内景 写字楼大堂，中景，固定镜头，冷白光，统一色调，电影级质感。",
    en: "medium shot, static camera, cinematic quality.",
    params: {
      durationMs: 3000,
      aspectRatio: "9:16",
      resolution: "1080x1920",
      fps: 30,
      motionStrength: DEFAULT_MOTION_STRENGTH,
      seed: null,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      refImages: [],
      firstFrame: null,
      lastFrame: null,
    } satisfies VideoParams,
    perProvider: {},
  };
}

function rulesOf(bundle: PromptBundle): string[] {
  return checkPromptHealth(bundle).map((issue) => issue.rule);
}

describe("checkPromptHealth · 体检（只提示不阻塞）", () => {
  it("健康的提示词不报任何问题", () => {
    expect(checkPromptHealth(baseBundle())).toEqual([]);
  });

  it("主体为空 → missing_subject", () => {
    const bundle = baseBundle();
    bundle.unified.subject = "";
    expect(rulesOf(bundle)).toContain("missing_subject");
  });

  it("镜头语言为空 → missing_camera", () => {
    const bundle = baseBundle();
    bundle.unified.camera = "";
    expect(rulesOf(bundle)).toContain("missing_camera");
  });

  it("超过阈值字数 → too_long", () => {
    const bundle = baseBundle();
    bundle.zh = "啊".repeat(PROMPT_WARN_CHARS + 1);
    expect(rulesOf(bundle)).toContain("too_long");
  });

  it("「固定镜头」与运动运镜同时出现 → contradiction", () => {
    const bundle = baseBundle();
    bundle.unified.camera = "固定镜头，推近";
    expect(rulesOf(bundle)).toContain("contradiction");
  });

  it("画面里同时出现「夜晚」与「阳光」→ contradiction", () => {
    const bundle = baseBundle();
    bundle.zh = "夜晚的大堂，阳光斜射进来。";
    expect(rulesOf(bundle)).toContain("contradiction");
  });

  it("负向词出现在正向提示词里 → contradiction，并点出是哪个词", () => {
    const bundle = baseBundle();
    bundle.zh = "画面有些模糊，主体不清晰。";
    const issues = checkPromptHealth(bundle);
    expect(issues.map((issue) => issue.rule)).toContain("contradiction");
    expect(issues.some((issue) => issue.message.includes("模糊"))).toBe(true);
  });
});

describe("shotsWithoutPrompt · 第 6 步门禁口径", () => {
  it("有镜头没出题时列出「第 N 集 第 M 场 · 镜 K」", () => {
    const { project } = richProject();
    expect(shotsWithoutPrompt(project)).toEqual(["第 1 集 第 1 场 · 镜 1"]);
  });

  it("每个镜头都出过题后返回空数组", () => {
    const { project } = richProject();
    project.episodes[0].scenes[0].shots[0].promptBundle = baseBundle();
    expect(shotsWithoutPrompt(project)).toEqual([]);
  });
});

describe("词条词典 · 新手悬浮「为什么这么写」", () => {
  it("六段结构与 Rust 导出标签一致", () => {
    expect(PROMPT_SECTIONS.map((section) => section.label)).toEqual([
      "主体",
      "环境",
      "镜头",
      "光线",
      "风格",
      "画质",
    ]);
  });

  it("按 key 命中词条，未收录的 key 返回 undefined", () => {
    expect(glossaryFor("camera")?.label).toBe("镜头语言");
    expect(glossaryFor("negativePrompt")?.label).toBe("负向提示词");
    expect(glossaryFor("nope")).toBeUndefined();
  });
});
