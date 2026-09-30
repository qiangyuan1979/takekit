/**
 * 分镜工作区测试：M4 的验收口径——"一集能拆出 ≥10 镜、时长累计正确、超标有提示、
 * 两种视图切换数据一致"，外加表格批量编辑这条"表格比卡片快"的唯一理由。
 *
 * LLM 是外部依赖，这里全部 mock；本文件的关注点是"点下去之后有没有按约定落进 store"、
 * 无 Key 时按钮是否明确禁用，以及两百多镜时是否真的只渲染视口那一段。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  api: {
    createProject: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn(),
    listRecentProjects: vi.fn(),
    duplicateProject: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    llmComplete: vi.fn(),
    llmStream: vi.fn(),
  },
  toApiError: vi.fn((value: unknown) => value),
}));

vi.mock("../src/lib/ipc", () => ipc);

import { StoryboardWorkspace } from "../src/components/storyboard/StoryboardWorkspace";
import { makeDialogue, makeEpisode, makeScene } from "../src/lib/scriptOps";
import { defaultSettings, type AppSettings, type Project, type Shot } from "../src/lib/types";
import { useAppStore } from "../src/state/store";
import { makeProject } from "./support/project";

const PROJECT_PATH = "C:/projects/demo";

function settingsWithLlmKey(apiKey: string): AppSettings {
  const base = defaultSettings();
  return { ...base, llm: { ...base.llm, apiKey } };
}

/** 造 n 个字段齐备的镜头，镜号从 1 连续编号。 */
function makeShots(count: number, durationMs = 3000, sceneId = "sc-1"): Shot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${sceneId}-shot-${index + 1}`,
    no: index + 1,
    shotSize: "medium_shot" as const,
    cameraMove: "static_shot" as const,
    durationMs,
    visualDesc: `画面 ${index + 1}`,
    characters: [],
    dialogue: null,
    narration: null,
    sfxHint: "",
    transition: "cut" as const,
    note: "",
    promptBundle: null,
    adoptedClipId: null,
    frames: [],
  }));
}

function projectWithShots(
  options: { count?: number; durationMs?: number; limitMs?: number } = {},
): Project {
  const { count = 2, durationMs = 3000, limitMs = 60_000 } = options;
  return makeProject(
    { episodeDurationMs: limitMs },
    {
      episodes: [
        makeEpisode(1, {
          id: "ep-1",
          title: "开场",
          scenes: [
            makeScene({
              id: "sc-1",
              no: 1,
              location: "天台",
              characters: ["林晚"],
              actionDesc: "她站在栏杆边",
              shots: makeShots(count, durationMs),
            }),
          ],
        }),
      ],
    },
  );
}

/** 还没拆镜的项目：一场三句台词，供"离线拆镜"往回填。 */
function projectWithScript(): Project {
  return makeProject(
    {},
    {
      episodes: [
        makeEpisode(1, {
          id: "ep-1",
          scenes: [
            makeScene({
              id: "sc-1",
              no: 1,
              location: "天台",
              characters: ["林晚"],
              actionDesc: "她站在栏杆边，风把外套吹起来。",
              dialogues: [
                makeDialogue({ characterId: "林晚", text: "你自己看。" }),
                makeDialogue({
                  characterId: "",
                  text: "整座城市在她脚下亮着。",
                  isNarration: true,
                }),
              ],
            }),
          ],
        }),
      ],
    },
  );
}

function reset(project: Project = projectWithShots(), settings = defaultSettings()): void {
  useAppStore.setState({
    ready: true,
    project,
    projectPath: PROJECT_PATH,
    currentStep: "storyboard",
    saveState: "saved",
    revision: 0,
    error: null,
    recent: [],
    settings,
  });
}

/** 推进若干轮微任务，让 async 编排（流式拆镜 → 写回）走完。 */
async function flush(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await Promise.resolve();
    }
  });
}

/** 批量条上的下拉：按占位选项文案定位，避开每行同名的景别 / 运镜下拉。 */
function bulkSelect(placeholder: string): HTMLSelectElement {
  const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
  const found = selects.find((select) =>
    Array.from(select.options).some((option) => option.textContent === placeholder),
  );
  if (!found) throw new Error(`找不到批量下拉：${placeholder}`);
  return found;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  ipc.toApiError.mockImplementation((value: unknown) => value);
  ipc.api.saveProject.mockImplementation(async (_path: string, project: Project) => project);
  reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<StoryboardWorkspace /> · 拆镜", () => {
  it("没有镜头时表格给出可照做的下一步", () => {
    reset(projectWithScript());
    render(<StoryboardWorkspace />);

    expect(screen.getByText(/这一集还没有镜头/)).toBeTruthy();
    expect(screen.getByText(/本集还没拆镜/)).toBeTruthy();
  });

  it("「离线拆镜本集」按场落镜、给出回执，并更新时长条", () => {
    reset(projectWithScript());
    render(<StoryboardWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /离线拆镜本集/ }));

    const shots = useAppStore.getState().project?.episodes[0].scenes[0].shots ?? [];
    // 1 个交代镜 + 1 条台词 + 1 条旁白 = 3
    expect(shots.length).toBe(3);
    expect(shots[0].no).toBe(1);
    expect(shots[0].shotSize).toBe("long_shot");
    expect(shots[2].narration).toBe("整座城市在她脚下亮着。");

    expect(screen.getByText(/已按场拆出 3 个镜头/)).toBeTruthy();
    expect(screen.getByText(/本集分镜 9 秒 \/ 单集 1 分 00 秒/)).toBeTruthy();
  });

  it("没有 LLM Key 时 AI 拆镜禁用，离线拆镜仍可用", () => {
    reset(projectWithScript(), defaultSettings());
    render(<StoryboardWorkspace />);

    const ai = screen.getByRole("button", { name: "AI 拆镜" }) as HTMLButtonElement;
    expect(ai.disabled).toBe(true);

    const offline = screen.getByRole("button", { name: "离线拆镜" }) as HTMLButtonElement;
    expect(offline.disabled).toBe(false);
  });

  it("有 Key 时 AI 拆镜流式落地，并把镜数写进回执", async () => {
    reset(projectWithScript(), settingsWithLlmKey("sk-llm"));
    const payload = JSON.stringify({
      shots: [
        {
          shotSize: "close_up",
          cameraMove: "push_in",
          durationMs: 2500,
          visualDesc: "林晚的特写",
          characters: ["林晚"],
          dialogue: "你自己看。",
          narration: null,
          sfxHint: "风声",
          transition: "cut",
          note: "注意眼神",
        },
      ],
    });
    ipc.api.llmStream.mockImplementation(
      async (_request: unknown, onChunk: (chunk: { delta: string }) => void) => {
        onChunk({ delta: payload });
      },
    );

    render(<StoryboardWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "AI 拆镜" }));
    await flush();

    expect(ipc.api.llmStream).toHaveBeenCalledTimes(1);
    const shots = useAppStore.getState().project?.episodes[0].scenes[0].shots ?? [];
    expect(shots.length).toBe(1);
    expect(shots[0].shotSize).toBe("close_up");
    expect(shots[0].characters).toEqual(["林晚"]);
    expect(screen.getByText(/AI 拆出 1 个镜头，已写进这一场/)).toBeTruthy();
  });
});

describe("<StoryboardWorkspace /> · 时长条", () => {
  it("未超标时说明在预算内", () => {
    reset(projectWithShots({ count: 2, durationMs: 3000, limitMs: 60_000 }));
    const { container } = render(<StoryboardWorkspace />);

    const bar = container.querySelector(".dbar");
    expect(bar?.getAttribute("data-over")).toBe(null);
    expect(screen.getByText(/时长在预算内/)).toBeTruthy();
    expect(screen.getByText(/本集分镜 6 秒 \/ 单集 1 分 00 秒/)).toBeTruthy();
  });

  it("超标时标红并给出下一步动作", () => {
    reset(projectWithShots({ count: 2, durationMs: 3000, limitMs: 4000 }));
    const { container } = render(<StoryboardWorkspace />);

    const bar = container.querySelector(".dbar");
    expect(bar?.getAttribute("data-over")).toBe("true");
    expect(screen.getByText(/本集分镜 6 秒 \/ 单集 4 秒 · 超出 2 秒，删镜或压时长/)).toBeTruthy();
  });
});

describe("<StoryboardWorkspace /> · 表格批量编辑", () => {
  it("多选后批量设为景别会写回 store 并落盘", async () => {
    reset(projectWithShots({ count: 3 }));
    render(<StoryboardWorkspace />);

    fireEvent.click(screen.getByLabelText("选择第 1 镜"));
    fireEvent.click(screen.getByLabelText("选择第 2 镜"));
    expect(screen.getByText("已选 2 镜")).toBeTruthy();

    fireEvent.change(bulkSelect("批量设为景别…"), { target: { value: "close_up" } });

    const shots = useAppStore.getState().project?.episodes[0].scenes[0].shots ?? [];
    expect(shots.map((shot) => shot.shotSize)).toEqual(["close_up", "close_up", "medium_shot"]);
    // 应用后清空选择
    expect(screen.queryByText(/已选/)).toBe(null);

    // 防抖落盘后 project.json 与 store 一致
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await flush();
    expect(ipc.api.saveProject).toHaveBeenCalled();
    const calls = ipc.api.saveProject.mock.calls;
    const saved = calls[calls.length - 1][1] as Project;
    expect(saved.episodes[0].scenes[0].shots[0].shotSize).toBe("close_up");
  });

  it("批量改时长按秒录入、按毫秒落盘", async () => {
    reset(projectWithShots({ count: 2 }));
    render(<StoryboardWorkspace />);

    fireEvent.click(screen.getByLabelText("全选"));
    // 批量条上的秒数输入框排在所有行之前，取第一个即可。
    const seconds = screen.getAllByRole("spinbutton")[0] as HTMLInputElement;
    fireEvent.change(seconds, { target: { value: "4.5" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    const shots = useAppStore.getState().project?.episodes[0].scenes[0].shots ?? [];
    expect(shots.map((shot) => shot.durationMs)).toEqual([4500, 4500]);
  });
});

describe("<StoryboardWorkspace /> · 双视图一致", () => {
  it("表格里改过的字段，切到卡片视图仍是同一份数据", () => {
    reset(projectWithShots({ count: 2 }));
    render(<StoryboardWorkspace />);

    fireEvent.change(screen.getAllByPlaceholderText("镜头里能看见什么")[0], {
      target: { value: "改成：下雨了" },
    });
    expect(useAppStore.getState().project?.episodes[0].scenes[0].shots[0].visualDesc).toBe(
      "改成：下雨了",
    );

    fireEvent.click(screen.getByRole("button", { name: "卡片" }));
    const cards = screen.getAllByTestId("shot-card");
    expect(cards.length).toBe(2);
    expect(screen.getByDisplayValue("改成：下雨了")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "表格" }));
    expect(screen.getAllByTestId("shot-row").length).toBe(2);
    expect(screen.getByDisplayValue("改成：下雨了")).toBeTruthy();
  });

  it("卡片视图每场可加镜，加完表格视图同步多一行", () => {
    reset(projectWithShots({ count: 2 }));
    render(<StoryboardWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "卡片" }));
    fireEvent.click(screen.getByRole("button", { name: /加一个镜头/ }));
    expect(screen.getAllByTestId("shot-card").length).toBe(3);

    fireEvent.click(screen.getByRole("button", { name: "表格" }));
    expect(screen.getAllByTestId("shot-row").length).toBe(3);
  });
});

describe("<StoryboardWorkspace /> · 大集虚拟滚动", () => {
  it("两百多镜只渲染视口内的行", () => {
    reset(projectWithShots({ count: 260 }));
    render(<StoryboardWorkspace />);

    const rendered = screen.getAllByTestId("shot-row").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);

    const spacer = document.querySelector(".shot-table__spacer") as HTMLElement | null;
    expect(spacer?.style.height).toBe(`${260 * 48}px`);
  });
});
