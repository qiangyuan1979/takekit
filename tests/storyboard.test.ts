/**
 * 分镜编排层测试：离线拆镜与 AI 拆镜都必须经由 store 落进 `project.json`。
 *
 * 关注两件事：① 拆镜结果落在"哪一场"上（跨场不能串）；② AI 回一段散文时
 * 必须抛错而不是把用户已经拆好的镜头抹掉——那是最坏的一种体验。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  api: {
    saveProject: vi.fn(),
    llmStream: vi.fn(),
    llmComplete: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { makeDialogue, makeEpisode, makeScene } from "../src/lib/scriptOps";
import type { Project } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import {
  runShotAi,
  sceneLabel,
  splitEpisodeOffline,
  splitSceneOffline,
} from "../src/state/storyboard";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

/** 两集：第 1 集两场（第一场有 2 条台词），第 2 集一场。 */
function projectWithScript(): Project {
  return makeProject(
    { title: "重生之我在都市当龙王", episodeDurationMs: 60_000 },
    {
      episodes: [
        makeEpisode(1, {
          id: "ep-1",
          scenes: [
            makeScene({
              id: "sc-1",
              no: 1,
              location: "写字楼大堂",
              actionDesc: "他被人拦在门外。",
              dialogues: [
                makeDialogue({ characterId: "林晚", text: "你不能进去。" }),
                makeDialogue({ characterId: "陆沉", text: "让开。" }),
              ],
            }),
            makeScene({ id: "sc-2", no: 2, location: "天台", actionDesc: "风很大。" }),
          ],
        }),
        makeEpisode(2, {
          id: "ep-2",
          scenes: [makeScene({ id: "sc-3", no: 1, location: "车库", actionDesc: "车门打开。" })],
        }),
      ],
    },
  );
}

function reset(project: Project = projectWithScript()): void {
  useAppStore.setState({
    ready: true,
    project,
    projectPath: PROJECT_PATH,
    currentStep: "storyboard",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
  });
}

function sceneShots(episodeId: string, sceneId: string) {
  const episode = useAppStore.getState().project?.episodes.find((item) => item.id === episodeId);
  return episode?.scenes.find((scene) => scene.id === sceneId)?.shots ?? [];
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  ipc.api.saveProject.mockImplementation(async (_path: string, project: Project) => project);
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("离线拆镜", () => {
  it("splitSceneOffline 只覆盖指定的那一场，并返回写入镜头数", () => {
    const count = splitSceneOffline("ep-1", "sc-1");

    // 交代镜 + 2 条台词
    expect(count).toBe(3);
    expect(sceneShots("ep-1", "sc-1")).toHaveLength(3);
    expect(sceneShots("ep-1", "sc-2")).toHaveLength(0);
  });

  it("splitSceneOffline 会整体覆盖这一场已有的镜头", () => {
    splitSceneOffline("ep-1", "sc-1");
    const second = splitSceneOffline("ep-1", "sc-1", { durationMs: 5000 });

    const shots = sceneShots("ep-1", "sc-1");
    expect(second).toBe(3);
    expect(shots.every((shot) => shot.durationMs === 5000)).toBe(true);
  });

  it("splitEpisodeOffline 逐场拆，返回整集镜头总数", () => {
    const count = splitEpisodeOffline("ep-1");

    // (1 + 2) + 1
    expect(count).toBe(4);
    expect(sceneShots("ep-1", "sc-1")).toHaveLength(3);
    expect(sceneShots("ep-1", "sc-2")).toHaveLength(1);
    // 另一集不受影响
    expect(sceneShots("ep-2", "sc-3")).toHaveLength(0);
  });

  it("找不到场时抛错，且不写脏数据", () => {
    expect(() => splitSceneOffline("ep-1", "missing")).toThrow("找不到要拆的这一场");
  });

  it("没有打开项目时抛错", () => {
    useAppStore.setState({ project: null });
    expect(() => splitSceneOffline("ep-1", "sc-1")).toThrow("还没有新建或打开项目");
  });
});

describe("AI 拆镜", () => {
  const goodJson = JSON.stringify({
    shots: [
      {
        shotSize: "long_shot",
        cameraMove: "static_shot",
        durationMs: 3000,
        visualDesc: "写字楼大堂，他站在玻璃门外",
        characters: [],
        dialogue: null,
        narration: null,
        sfxHint: "",
        transition: "cut",
        note: "",
      },
      {
        shotSize: "close_up",
        cameraMove: "push_in",
        durationMs: 2500,
        visualDesc: "林晚挡在门前",
        characters: ["林晚"],
        dialogue: "你不能进去。",
        narration: null,
        sfxHint: "",
        transition: "cut",
        note: "",
      },
    ],
  });

  it("流式增量回调收到全部片段，解析结果整场写回", async () => {
    ipc.api.llmStream.mockImplementation(
      async (_request: unknown, onEvent: (chunk: { delta: string; done: boolean }) => void) => {
        onEvent({ delta: goodJson.slice(0, 20), done: false });
        onEvent({ delta: goodJson.slice(20), done: true });
      },
    );
    const deltas: string[] = [];

    const count = await runShotAi({
      episodeId: "ep-1",
      sceneId: "sc-1",
      onDelta: (delta) => deltas.push(delta),
    });

    expect(count).toBe(2);
    expect(deltas).toHaveLength(2);
    expect(deltas.join("")).toBe(goodJson);

    const shots = sceneShots("ep-1", "sc-1");
    expect(shots).toHaveLength(2);
    expect(shots[0].no).toBe(1);
    expect(shots[0].episodeId).toBe("ep-1");
    expect(shots[0].sceneId).toBe("sc-1");
    expect(shots[1].dialogue).toBe("你不能进去。");
    expect(shots[1].characters).toEqual(["林晚"]);
  });

  it("模型回散文时抛错，已有的镜头原样保留", async () => {
    splitSceneOffline("ep-1", "sc-1");
    const before = sceneShots("ep-1", "sc-1");

    ipc.api.llmStream.mockImplementation(
      async (_request: unknown, onEvent: (chunk: { delta: string; done: boolean }) => void) => {
        onEvent({ delta: "我觉得这一场应该先给一个全景。", done: true });
      },
    );

    await expect(runShotAi({ episodeId: "ep-1", sceneId: "sc-1" })).rejects.toThrow(
      "模型没有返回 JSON 对象",
    );
    expect(sceneShots("ep-1", "sc-1")).toBe(before);
  });

  it("模型回了合法 JSON 但一个可用的镜头都没有时，也抛错并保留原镜头", async () => {
    splitSceneOffline("ep-1", "sc-1");
    const before = sceneShots("ep-1", "sc-1");

    ipc.api.llmStream.mockImplementation(
      async (_request: unknown, onEvent: (chunk: { delta: string; done: boolean }) => void) => {
        onEvent({ delta: '{"shots":[]}', done: true });
      },
    );

    await expect(runShotAi({ episodeId: "ep-1", sceneId: "sc-1" })).rejects.toThrow(
      "模型没有给出可用的镜头",
    );
    expect(sceneShots("ep-1", "sc-1")).toBe(before);
  });
});

describe("sceneLabel", () => {
  it("拼出「第 N 集 第 M 场 · 地点」", () => {
    expect(sceneLabel(useAppStore.getState().project, "ep-1", "sc-1")).toBe(
      "第 1 集 第 1 场 · 写字楼大堂",
    );
  });

  it("找不到时给一个安全的兜底文案", () => {
    expect(sceneLabel(useAppStore.getState().project, "ep-1", "missing")).toBe("这一场");
    expect(sceneLabel(null, "ep-1", "sc-1")).toBe("这一场");
  });
});
