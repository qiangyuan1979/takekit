/**
 * 后期出片纯函数层测试：配音句 / 时间线 / 字幕 / 对口型的派生，TTS 事件归并，
 * 以及 BGM、音效与导出预设。
 *
 * 这一层的核心约束是"幂等"：上游没变时重跑必须返回同一批对象引用，
 * 否则每点一次"一键同步"都会把整个项目标脏、触发多余的落盘。
 */

import { describe, expect, it } from "vitest";

import { makeCharacter } from "../src/lib/assetOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import {
  EXPORT_PRESETS,
  applyTtsEvent,
  buildTimeline,
  deriveLipsync,
  deriveSubtitles,
  deriveVoiceLines,
  estimateSpeechMs,
  exportPresetById,
  exportPresetLabel,
  hasFrontFaceCue,
  makeBgmTrack,
  makeSfxCue,
  makeVoiceTask,
  recommendBgmMaterials,
  sfxSuggestions,
  syncPost,
} from "../src/lib/postOps";
import {
  defaultPost,
  type Character,
  type Material,
  type Post,
  type Project,
  type ShotSize,
  type Task,
  type Transition,
} from "../src/lib/types";
import { makeProject } from "./support/project";

interface ShotSpec {
  id: string;
  durationMs?: number;
  dialogue?: string | null;
  narration?: string | null;
  characters?: string[];
  shotSize?: ShotSize;
  visualDesc?: string;
  sfxHint?: string;
  transition?: Transition;
  adoptedClipId?: string | null;
}

function build(
  specs: ShotSpec[],
  extras: { characters?: Character[]; tasks?: Task[]; post?: Partial<Post> } = {},
): Project {
  const shots = specs.map((spec, index) =>
    makeShot({
      id: spec.id,
      episodeId: "ep-1",
      sceneId: "sc-1",
      no: index + 1,
      durationMs: spec.durationMs ?? 1000,
      dialogue: spec.dialogue ?? null,
      narration: spec.narration ?? null,
      characters: spec.characters ?? [],
      shotSize: spec.shotSize ?? "medium_shot",
      visualDesc: spec.visualDesc ?? "",
      sfxHint: spec.sfxHint ?? "",
      transition: spec.transition ?? "cut",
      adoptedClipId: spec.adoptedClipId ?? null,
    }),
  );

  return makeProject(
    { defaultVoice: "默认音色" },
    {
      assets: {
        characters: extras.characters ?? [],
        scenes: [],
        props: [],
        styleLock: { promptTemplate: "", refImages: [], seed: null },
      },
      episodes: [makeEpisode(1, { id: "ep-1", scenes: [makeScene({ id: "sc-1", no: 1, shots })] })],
      tasks: extras.tasks ?? [],
      ...(extras.post ? { post: { ...defaultPost(), ...extras.post } } : {}),
    },
  );
}

/** 一条已成功的视频任务（`result.kind = "clip"`），供 `adoptedClipPath` 取路径。 */
function clipTask(id: string, path: string): Task {
  return {
    id,
    kind: "video",
    provider: "kling",
    request: {},
    status: "succeeded",
    result: { kind: "clip", path, mime: "video/mp4" },
    error: null,
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

function material(id: string, name: string, kind: Material["kind"] = "audio"): Material {
  return {
    id,
    kind,
    name,
    ext: kind === "audio" ? "mp3" : "png",
    bytes: 1,
    path: `C:/materials/${id}.${kind === "audio" ? "mp3" : "png"}`,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
  };
}

describe("deriveVoiceLines", () => {
  it("对白与旁白各成一句：说话人取自 characters[0]，音色优先角色卡", () => {
    const project = build(
      [
        { id: "shot-1", dialogue: "你好", characters: ["char-1"] },
        { id: "shot-2", narration: "夜色降临" },
      ],
      { characters: [makeCharacter("苏晚", { id: "char-1", voice: "zh-female" })] },
    );

    const lines = deriveVoiceLines(project);

    expect(lines.map((line) => [line.shotId, line.isNarration, line.text])).toEqual([
      ["shot-1", false, "你好"],
      ["shot-2", true, "夜色降临"],
    ]);
    expect(lines[0].characterId).toBe("char-1");
    expect(lines[0].voice).toBe("zh-female");
    expect(lines[0].shotNo).toBe(1);
    expect(lines[1].characterId).toBe("");
    expect(lines[1].voice).toBe("默认音色");
  });

  it("上游未变时返回同一数组引用（幂等）", () => {
    const project = build([{ id: "shot-1", dialogue: "你好" }]);

    const first = deriveVoiceLines(project);
    expect(deriveVoiceLines(project, first)).toBe(first);
  });

  it("文本变化时换新对象但保留 id；删掉台词后句子消失", () => {
    const project = build([{ id: "shot-1", dialogue: "你好" }]);
    const first = deriveVoiceLines(project);

    const changed = build([{ id: "shot-1", dialogue: "再见" }]);
    const second = deriveVoiceLines(changed, first);

    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].text).toBe("再见");

    const removed = build([{ id: "shot-1" }]);
    expect(deriveVoiceLines(removed, first)).toHaveLength(0);
  });
});

describe("buildTimeline", () => {
  it("只收编有采用片段的镜，起始时间从 0 累加，转场取自分镜", () => {
    const project = build(
      [
        { id: "shot-1", durationMs: 2000, transition: "fade", adoptedClipId: "task-1" },
        { id: "shot-2", durationMs: 1000 },
        { id: "shot-3", durationMs: 3000, adoptedClipId: "task-2" },
      ],
      { tasks: [clipTask("task-1", "clips/a.mp4"), clipTask("task-2", "clips/b.mp4")] },
    );

    const timeline = buildTimeline(project);

    expect(
      timeline.map((clip) => [clip.shotId, clip.startMs, clip.durationMs, clip.clipPath]),
    ).toEqual([
      ["shot-1", 0, 2000, "clips/a.mp4"],
      ["shot-3", 2000, 3000, "clips/b.mp4"],
    ]);
    expect(timeline[0].transition).toBe("fade");
  });

  it("上游未变时返回同一数组引用", () => {
    const project = build([{ id: "shot-1", adoptedClipId: "task-1" }], {
      tasks: [clipTask("task-1", "clips/a.mp4")],
    });

    const first = buildTimeline(project);
    expect(buildTimeline(project, first)).toBe(first);
  });
});

describe("deriveSubtitles", () => {
  it("起点对齐时间线，同一镜内多句依次顺排", () => {
    const project = build(
      [
        {
          id: "shot-1",
          durationMs: 1000,
          dialogue: "第一句",
          narration: "旁白",
          adoptedClipId: "task-1",
        },
        { id: "shot-2", durationMs: 1000, dialogue: "第三句" },
      ],
      { tasks: [clipTask("task-1", "clips/a.mp4")] },
    );
    const lines = deriveVoiceLines(project).map((line, index) => ({
      ...line,
      durationMs: index === 2 ? 800 : 0,
    }));
    const timeline = buildTimeline(project);

    const subtitles = deriveSubtitles(project, lines, timeline);

    // shot-1 在时间线上 → 起点 0；无实测时长时按文本估算。
    expect(subtitles[0].startMs).toBe(0);
    expect(subtitles[0].endMs).toBe(estimateSpeechMs("第一句"));
    // 同镜第二句从第一句末尾接着排。
    expect(subtitles[1].startMs).toBe(subtitles[0].endMs);
    // shot-2 不在时间线里（没采用片段）→ 退回分镜时长累加，起点 = shot-1 时长。
    expect(subtitles[2].startMs).toBe(1000);
    expect(subtitles[2].endMs).toBe(1800);
  });

  it("文本未变的旧字幕原样保留（不覆盖手工调过的起止时间）", () => {
    const project = build([{ id: "shot-1", dialogue: "你好" }]);
    const lines = deriveVoiceLines(project);
    const manual = {
      id: "sub-manual",
      episodeId: "ep-1",
      voiceLineId: lines[0].id,
      shotId: "shot-1",
      shotNo: 1,
      text: "你好",
      startMs: 111,
      endMs: 999,
      enabled: false,
    };

    const subtitles = deriveSubtitles(project, lines, [], [manual]);

    expect(subtitles[0]).toBe(manual);
  });
});

describe("deriveLipsync", () => {
  it("采用片段 + 已生成对白 + 正面线索三者齐备才入选", () => {
    const project = build(
      [
        {
          id: "shot-1",
          shotSize: "close_up",
          dialogue: "开口说话",
          characters: ["char-1"],
          adoptedClipId: "task-1",
        },
        { id: "shot-2", shotSize: "wide_shot", dialogue: "背影", adoptedClipId: "task-2" },
      ],
      { tasks: [clipTask("task-1", "clips/a.mp4"), clipTask("task-2", "clips/b.mp4")] },
    );
    const lines = deriveVoiceLines(project).map((line) => ({
      ...line,
      audioPath: `voice/${line.id}.mp3`,
      durationMs: 1000,
    }));
    const timeline = buildTimeline(project);

    const lipsync = deriveLipsync(project, timeline, lines);

    expect(lipsync).toHaveLength(1);
    expect(lipsync[0].shotId).toBe("shot-1");
    expect(lipsync[0].reason).toBe("front_face");
    expect(lipsync[0].audioPath).toBe(`voice/${lines[0].id}.mp3`);
  });

  it("hasFrontFaceCue 认得近景与口型关键词", () => {
    expect(
      hasFrontFaceCue(makeShot({ episodeId: "e", sceneId: "s", shotSize: "extreme_close_up" })),
    ).toBe(true);
    expect(
      hasFrontFaceCue(makeShot({ episodeId: "e", sceneId: "s", visualDesc: "角色对着镜头" })),
    ).toBe(true);
    expect(hasFrontFaceCue(makeShot({ episodeId: "e", sceneId: "s", shotSize: "wide_shot" }))).toBe(
      false,
    );
  });
});

describe("applyTtsEvent", () => {
  it("成功事件同时写回任务状态与配音句音频", () => {
    const project = build([{ id: "shot-1", dialogue: "你好" }]);
    const line = deriveVoiceLines(project)[0];
    const task = makeVoiceTask("openai", line);
    const seeded: Project = {
      ...project,
      tasks: [task],
      post: { ...project.post, voiceLines: [line] },
    };

    const next = applyTtsEvent(seeded, {
      taskId: task.id,
      voiceLineId: line.id,
      status: "succeeded",
      audioPath: `voice/${line.id}.mp3`,
      durationMs: 1234,
    });

    expect(next.tasks[0].status).toBe("succeeded");
    expect(next.post.voiceLines[0].audioPath).toBe(`voice/${line.id}.mp3`);
    expect(next.post.voiceLines[0].durationMs).toBe(1234);
  });

  it("没有任何可写字段时返回原项目引用", () => {
    const project = build([{ id: "shot-1", dialogue: "你好" }]);

    const next = applyTtsEvent(project, {
      taskId: "missing",
      voiceLineId: "",
      status: "running",
      durationMs: 0,
    });

    expect(next).toBe(project);
  });
});

describe("syncPost", () => {
  it("派生四轨；再跑一次返回同一 post 引用", () => {
    const project = build([{ id: "shot-1", dialogue: "你好", adoptedClipId: "task-1" }], {
      tasks: [clipTask("task-1", "clips/a.mp4")],
    });

    const post = syncPost(project);
    expect(post.voiceLines).toHaveLength(1);
    expect(post.timeline).toHaveLength(1);
    expect(post.subtitles).toHaveLength(1);

    expect(syncPost({ ...project, post })).toBe(post);
  });

  it("不动用户手动维护的 BGM 与导出预设", () => {
    const project = build([{ id: "shot-1", dialogue: "你好" }]);
    const bgm = makeBgmTrack(material("m-1", "轻快电子"));
    const seeded: Project = { ...project, post: { ...project.post, bgm, exportPreset: "douyin" } };

    const post = syncPost(seeded);

    expect(post.bgm).toBe(bgm);
    expect(post.exportPreset).toBe("douyin");
  });
});

describe("BGM 与音效", () => {
  it("按情绪词把匹配的音频排前", () => {
    const materials = [
      material("m-1", "紧张鼓点"),
      material("m-2", "轻快电子"),
      material("m-3", "片头", "image"),
    ];

    const ordered = recommendBgmMaterials("紧张", materials);

    expect(ordered.map((item) => item.id)).toEqual(["m-1", "m-2"]);
  });

  it("makeBgmTrack 用默认闪避参数", () => {
    expect(makeBgmTrack(material("m-1", "轻快电子"))).toMatchObject({
      materialId: "m-1",
      volume: 50,
      ducking: true,
      duckVolume: 20,
      looping: true,
    });
  });

  it("音效建议取分镜的音效提示与时间线起点", () => {
    const project = build(
      [
        { id: "shot-1", durationMs: 1000, sfxHint: "关门声", adoptedClipId: "task-1" },
        { id: "shot-2", durationMs: 500, sfxHint: "脚步" },
      ],
      { tasks: [clipTask("task-1", "clips/a.mp4")] },
    );
    const timeline = buildTimeline(project);

    const suggestions = sfxSuggestions(project, timeline);

    expect(suggestions.map((item) => [item.shotId, item.hint, item.atMs])).toEqual([
      ["shot-1", "关门声", 0],
      ["shot-2", "脚步", 1000],
    ]);
    expect(makeSfxCue(suggestions[0], material("m-1", "关门"))).toMatchObject({
      shotId: "shot-1",
      materialId: "m-1",
      atMs: 0,
      volume: 80,
    });
  });
});

describe("导出预设", () => {
  it("按 id 查预设与展示名", () => {
    expect(exportPresetById("douyin")?.resolution).toBe("1080x1920");
    expect(exportPresetLabel("bilibili")).toBe("B站");
    expect(exportPresetLabel("unknown")).toBe("unknown");
    expect(EXPORT_PRESETS.map((preset) => preset.id)).toContain("youtube");
  });
});
