/**
 * 关键帧出题层测试：参考图的**优先级、去重、截断**，以及提示词正文的分区标注。
 *
 * 出题层是"确定性地把前面几步拍板过的信息一个不漏地带下来"，所以断言都落在
 * "到底带了哪些参考图、按什么顺序、写没写进提示词"——这正是新手最容易踩坑
 * 的地方（参考图超 4 张后端拼图会直接报错）。
 */

import { describe, expect, it } from "vitest";

import { defaultStyleLock, makeCharacter, makeSceneAsset } from "../src/lib/assetOps";
import { buildFramePrompt, collectFrameRefs } from "../src/lib/framePrompts";
import { MAX_FRAME_REFS, makeFrame } from "../src/lib/frameOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type { Character, Frame, Project, Scene, Shot } from "../src/lib/types";
import { makeProject } from "./support/project";

function frameWith(role: Frame["role"], patch: Partial<Frame> = {}): Frame {
  return { ...makeFrame(role), ...patch };
}

interface BuildArgs {
  shot?: Partial<Shot>;
  scene?: Partial<Scene>;
  characters?: Character[];
  sceneAssets?: ReturnType<typeof makeSceneAsset>[];
}

const LIN_PORTRAIT = "assets/character/char-1/portrait.png";
const LU_REF = "assets/character/char-2/01.png";
const LOBBY_REF = "assets/scene/sca-1/01.png";
const STYLE_REF = "assets/style/style/01.png";
const SHOT2_LAST = "assets/frame/shot-2/last.png";

/** 一个"什么锚都齐"的项目：两角色、一场景、画风锁，两个镜头。 */
function richProject(build: BuildArgs = {}): { project: Project; scene: Scene; shot: Shot } {
  const scene = makeScene({
    id: "sc-1",
    no: 1,
    location: "写字楼大堂",
    characters: ["林晚", "陆沉"],
    ...build.scene,
  });
  const shot = makeShot({
    id: "shot-1",
    episodeId: "ep-1",
    sceneId: "sc-1",
    no: 1,
    shotSize: "medium_shot",
    cameraMove: "static_shot",
    visualDesc: "他被人拦在门外。",
    characters: ["林晚"],
    dialogue: "你不能进去。",
    ...build.shot,
  });
  const shot2 = makeShot({
    id: "shot-2",
    episodeId: "ep-1",
    sceneId: "sc-1",
    no: 2,
    frames: [frameWith("last", { adopted: SHOT2_LAST })],
  });
  scene.shots = [shot, shot2];

  const project = makeProject(
    { visualStyle: "实拍写实感", styleKeywords: [] },
    {
      episodes: [makeEpisode(1, { id: "ep-1", scenes: [scene] })],
      assets: {
        characters: build.characters ?? [
          makeCharacter("林晚", { id: "char-1", portrait: LIN_PORTRAIT }),
          makeCharacter("陆沉", { id: "char-2", refImages: [LU_REF] }),
        ],
        scenes: build.sceneAssets ?? [
          makeSceneAsset("写字楼大堂", { id: "sca-1", refImages: [LOBBY_REF] }),
        ],
        props: [],
        styleLock: { promptTemplate: "统一色调", refImages: [STYLE_REF], seed: 7 },
      },
    },
  );

  return { project, scene, shot };
}

describe("collectFrameRefs · 优先级「角色 → 场景 → 跨镜 → 画风」", () => {
  it("四类锚按固定顺序排开，各带来源说明", () => {
    const { project, scene, shot } = richProject();
    const refs = collectFrameRefs(project, scene, shot, "shot-2");

    expect(refs.map((ref) => ref.path)).toEqual([LIN_PORTRAIT, LOBBY_REF, SHOT2_LAST, STYLE_REF]);
    expect(refs.map((ref) => ref.note)).toEqual([
      "角色·林晚",
      "场景·写字楼大堂",
      "跨镜·尾帧",
      "画风",
    ]);
  });

  it("本镜没写角色时退回整场出场角色", () => {
    const { project, scene, shot } = richProject({ shot: { characters: [] } });
    const refs = collectFrameRefs(project, scene, shot, null);

    expect(refs.map((ref) => ref.path)).toEqual([LIN_PORTRAIT, LU_REF, LOBBY_REF, STYLE_REF]);
  });

  it("同一角色被多次引用时只留一张（去重）", () => {
    const { project, scene, shot } = richProject({
      shot: { characters: ["林晚", "晚晚"] },
      characters: [
        makeCharacter("林晚", { id: "char-1", aliases: ["晚晚"], portrait: LIN_PORTRAIT }),
      ],
    });
    const refs = collectFrameRefs(project, scene, shot, null);

    expect(refs.filter((ref) => ref.path === LIN_PORTRAIT)).toHaveLength(1);
  });

  it("超过 4 张时按优先级截断，先牺牲画风", () => {
    const { project, scene, shot } = richProject({ shot: { characters: ["林晚", "陆沉"] } });
    const refs = collectFrameRefs(project, scene, shot, "shot-2");

    expect(refs).toHaveLength(MAX_FRAME_REFS);
    // 角色 ×2 + 场景 + 跨镜 已占满，画风被截掉
    expect(refs.map((ref) => ref.note)).toEqual([
      "角色·林晚",
      "角色·陆沉",
      "场景·写字楼大堂",
      "跨镜·尾帧",
    ]);
  });

  it("跨镜参考取被引镜头的定稿帧（优先尾帧）", () => {
    const { project, scene, shot } = richProject();
    const refs = collectFrameRefs(project, scene, shot, "shot-2");
    expect(refs.some((ref) => ref.path === SHOT2_LAST && ref.note === "跨镜·尾帧")).toBe(true);
  });

  it("引用的镜头没有定稿帧时不产生跨镜参考", () => {
    const { project, scene, shot } = richProject();
    // 把 shot-2 换成没有定稿帧的镜头
    scene.shots = [shot, makeShot({ id: "shot-2", episodeId: "ep-1", sceneId: "sc-1", no: 2 })];
    const refs = collectFrameRefs(project, scene, shot, "shot-2");
    expect(refs.some((ref) => ref.note.startsWith("跨镜"))).toBe(false);
  });

  it("画风锚退回立项的风格参考图（画风锁为空时）", () => {
    const { project, scene, shot } = richProject();
    project.assets.styleLock = defaultStyleLock();
    project.meta.styleRefImages = ["assets/meta/style.png"];

    const refs = collectFrameRefs(project, scene, shot, null);
    expect(refs.some((ref) => ref.path === "assets/meta/style.png" && ref.note === "画风")).toBe(
      true,
    );
  });
});

describe("buildFramePrompt · 正文与分区标注", () => {
  it("首帧/尾帧给出不同的开场提示，并带上镜头与立项信息", () => {
    const { project, scene, shot } = richProject();

    const first = buildFramePrompt({
      project,
      episode: project.episodes[0],
      scene,
      shot,
      role: "first",
      refShotId: "shot-2",
    });
    expect(first.prompt).toContain("关键帧：第 1 集 第 1 场 · 镜 1 · 首帧");
    expect(first.prompt).toContain("本图是本镜的第一帧——画面开场，需要交代清人物与环境。");
    expect(first.prompt).toContain("景别：中景；运镜：固定镜头；画幅：9:16");
    expect(first.prompt).toContain("画面：他被人拦在门外。");
    expect(first.prompt).toContain("出场角色：林晚");
    expect(first.prompt).toContain("台词/旁白：你不能进去。");
    expect(first.prompt).toContain("统一色调；实拍写实感");

    const last = buildFramePrompt({
      project,
      episode: project.episodes[0],
      scene,
      shot,
      role: "last",
      refShotId: null,
    });
    expect(last.prompt).toContain("本图是本镜的最后一帧——画面收尾，与首帧保持同一场景与人物外观。");
  });

  it("多张参考图写成分区标注，顺序与参考图一致", () => {
    const { project, scene, shot } = richProject();
    const { prompt, refs } = buildFramePrompt({
      project,
      episode: project.episodes[0],
      scene,
      shot,
      role: "first",
      refShotId: "shot-2",
    });

    expect(refs).toHaveLength(4);
    expect(prompt).toContain("参考图是一张拼图，请按分区理解并严格保持各分区主体的外观一致：");
    expect(prompt).toContain("  - 左上：角色·林晚");
    expect(prompt).toContain("  - 右上：场景·写字楼大堂");
    expect(prompt).toContain("  - 左下：跨镜·尾帧");
    expect(prompt).toContain("  - 右下：画风");
  });

  it("只有一张参考图时按整图说明，不伪造分区", () => {
    const shot = makeShot({
      id: "shot-9",
      episodeId: "ep-1",
      sceneId: "sc-9",
      no: 1,
      characters: [],
      visualDesc: "空镜。",
    });
    const scene = makeScene({ id: "sc-9", no: 1, location: "无", shots: [shot] });
    const project = makeProject(
      {},
      {
        episodes: [makeEpisode(1, { id: "ep-1", scenes: [scene] })],
        assets: {
          characters: [],
          scenes: [],
          props: [],
          styleLock: { promptTemplate: "", refImages: ["assets/style/only.png"], seed: null },
        },
      },
    );

    const { prompt, refs } = buildFramePrompt({
      project,
      episode: project.episodes[0],
      scene,
      shot,
      role: "first",
      refShotId: null,
    });

    expect(refs).toHaveLength(1);
    expect(prompt).toContain("参考图：画风（整图即该参考）");
    expect(prompt).not.toContain("参考图是一张拼图");
  });
});
