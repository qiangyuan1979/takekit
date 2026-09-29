/**
 * 剧本写回动作测试：右栏字段 → store → 防抖落盘的这条唯一路径。
 *
 * 字段锁是"AI 不能覆盖用户手写内容"这一承诺的唯一生效点，所以
 * `applyScriptPatch` / `applyEpisodePatch` 的跳过行为必须被锁住。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  api: {
    createProject: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn(),
    listRecentProjects: vi.fn(),
    duplicateProject: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { BEATS_LOCK_KEY } from "../src/lib/scriptTemplates";
import { defaultSettings } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const EP_ID = "ep-1";

function withScenes(): ReturnType<typeof makeProject> {
  return makeProject(
    {},
    {
      episodes: [
        makeEpisode(1, {
          id: EP_ID,
          scenes: [
            makeScene({ id: "s-1", no: 1 }),
            makeScene({ id: "s-2", no: 2 }),
            makeScene({ id: "s-3", no: 3 }),
          ],
        }),
      ],
    },
  );
}

function scenes(): { id: string; no: number }[] {
  const episode = useAppStore.getState().project?.episodes[0];
  return episode?.scenes.map((scene) => ({ id: scene.id, no: scene.no })) ?? [];
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  useAppStore.setState({
    ready: true,
    project: makeProject(),
    projectPath: "C:/projects/demo",
    currentStep: "script",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
    settings: defaultSettings(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("场的增删移", () => {
  it("新增一场取下一个场号", () => {
    useAppStore.setState({ project: withScenes() });
    useAppStore.getState().addScene(EP_ID);

    const list = scenes();
    expect(list).toHaveLength(4);
    expect(list[3].no).toBe(4);
    expect(useAppStore.getState().saveState).toBe("dirty");
  });

  it("删场后场号重排，不留断档", () => {
    useAppStore.setState({ project: withScenes() });
    useAppStore.getState().removeScene(EP_ID, "s-2");

    expect(scenes()).toEqual([
      { id: "s-1", no: 1 },
      { id: "s-3", no: 2 },
    ]);
  });

  it("上移一场后顺序与场号都更新", () => {
    useAppStore.setState({ project: withScenes() });
    useAppStore.getState().moveScene(EP_ID, "s-3", -1);

    expect(scenes()).toEqual([
      { id: "s-1", no: 1 },
      { id: "s-3", no: 2 },
      { id: "s-2", no: 3 },
    ]);
  });
});

describe("字段锁", () => {
  it("toggleFieldLock 反复切换", () => {
    const toggle = useAppStore.getState().toggleFieldLock;

    toggle("logline");
    expect(useAppStore.getState().project?.script.lockedFields).toEqual(["logline"]);

    toggle("logline");
    expect(useAppStore.getState().project?.script.lockedFields).toEqual([]);
  });

  it("applyScriptPatch 跳过已锁字段与空值，且不认 structure", () => {
    useAppStore.setState({
      project: makeProject({}, { script: { ...makeProject().script, lockedFields: ["logline"] } }),
    });

    useAppStore.getState().applyScriptPatch({
      logline: "AI 想改这里",
      hook: "AI 写的钩子",
      twist: "   ",
      structure: "drama-suspense",
    });

    const script = useAppStore.getState().project?.script;
    expect(script?.logline).toBe("");
    expect(script?.hook).toBe("AI 写的钩子");
    expect(script?.twist).toBe("");
    expect(script?.structure).toBe("");
  });

  it("applyEpisodePatch 在节拍锁定时不覆盖 beats", () => {
    const base = withScenes();
    useAppStore.setState({
      project: {
        ...base,
        script: { ...base.script, lockedFields: [BEATS_LOCK_KEY] },
      },
    });

    useAppStore.getState().applyEpisodePatch(EP_ID, {
      summary: "新的梗概",
      beats: ["AI 想改节拍"],
    });

    const episode = useAppStore.getState().project?.episodes[0];
    expect(episode?.summary).toBe("新的梗概");
    expect(episode?.beats).toEqual([]);
  });

  it("节拍未锁时 applyEpisodePatch 正常覆盖 beats", () => {
    useAppStore.setState({ project: withScenes() });
    useAppStore.getState().applyEpisodePatch(EP_ID, { beats: ["一", "二"] });

    expect(useAppStore.getState().project?.episodes[0].beats).toEqual(["一", "二"]);
  });
});

describe("离线模板填充", () => {
  it("无 Key 时把 A 段填成带占位符的草稿，并补出一集一场", () => {
    useAppStore.getState().fillFromTemplate();

    const state = useAppStore.getState();
    const project = state.project;
    expect(project?.script.logline).toContain("【主角】");
    expect(project?.script.structure).toBe("drama-four-act");
    expect(project?.episodes).toHaveLength(1);
    expect(project?.episodes[0].title).toBe("第 1 集");
    expect(project?.episodes[0].beats).toHaveLength(4);
    expect(project?.episodes[0].scenes[0].location).toBe("【地点】");
    expect(state.saveState).toBe("dirty");
  });

  it("已写内容与已锁字段都不被覆盖", () => {
    const base = makeProject();
    useAppStore.setState({
      project: {
        ...base,
        script: { ...base.script, obstacle: "手写的阻碍", lockedFields: ["hook"] },
      },
    });

    useAppStore.getState().fillFromTemplate();

    const script = useAppStore.getState().project?.script;
    expect(script?.obstacle).toBe("手写的阻碍");
    expect(script?.hook).toBe("");
    expect(script?.logline).toContain("【主角】");
  });

  it("已有集时不新建，短视频类型的一集叫「主片」", () => {
    useAppStore.setState({
      project: makeProject(
        { kind: "short_video" },
        { episodes: [makeEpisode(1, { id: EP_ID, title: "我自己起的名字" })] },
      ),
    });

    useAppStore.getState().fillFromTemplate();

    const project = useAppStore.getState().project;
    expect(project?.episodes).toHaveLength(1);
    expect(project?.episodes[0].title).toBe("我自己起的名字");

    // 空项目 + 短视频时才走模板命名
    useAppStore.setState({ project: makeProject({ kind: "short_video" }) });
    useAppStore.getState().fillFromTemplate();
    expect(useAppStore.getState().project?.episodes[0].title).toBe("主片");
  });
});
