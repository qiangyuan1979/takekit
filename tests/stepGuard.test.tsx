/**
 * 步骤守卫测试：既锁住"什么时候不让走下一步"的判断，也锁住提示文案
 * 必须是可以照着做的动作，而不是字段名。
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StepGuard } from "../src/components/StepGuard";
import { buildPromptBundle } from "../src/lib/promptOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import { defaultScript } from "../src/lib/types";
import { checkStep } from "../src/state/steps";
import { makeProject } from "./support/project";

afterEach(cleanup);

describe("checkStep('project')", () => {
  it("作品名为空时不放行，并指出要填哪张卡", () => {
    const result = checkStep("project", makeProject());
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("卡1：填写作品名");
  });

  it("标题与规格齐备后放行", () => {
    expect(checkStep("project", makeProject({ title: "重生之我在都市当龙王" })).ok).toBe(true);
  });

  it("短剧集数为 0 时拦住，并提示可改成短视频", () => {
    const result = checkStep("project", makeProject({ title: "剧", episodeCount: 0 }));
    expect(result.ok).toBe(false);
    expect(result.issues.join()).toContain("集数至少为 1");
  });

  it("短视频不校验集数", () => {
    const result = checkStep(
      "project",
      makeProject({ title: "单条视频", kind: "short_video", episodeCount: 0 }),
    );
    expect(result.ok).toBe(true);
  });

  it("帧率与单集时长非法时分别报错", () => {
    const result = checkStep("project", makeProject({ title: "剧", fps: 0, episodeDurationMs: 0 }));
    expect(result.issues).toEqual(
      expect.arrayContaining(["卡2：帧率必须大于 0", "卡2：选择单集时长"]),
    );
  });

  it("没有项目时直接拦住", () => {
    const result = checkStep("project", null);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
  });

  it("尚未实现的环节暂时一律放行", () => {
    expect(checkStep("assets", makeProject()).ok).toBe(true);
    expect(checkStep("post", makeProject()).ok).toBe(true);
  });
});

describe("checkStep('script')", () => {
  const script = { ...defaultScript(), logline: "外卖员一夜之间成了公司继承人。" };
  const oneScene = makeScene({
    no: 1,
    location: "写字楼大堂",
    characters: ["【主角】"],
    actionDesc: "他被人拦在门外，只能隔着玻璃看着里面的人举杯。",
  });

  it("一句话故事为空时不放行", () => {
    const result = checkStep("script", makeProject({}, { script: defaultScript() }));
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("A 段：用一句话写清这个故事");
  });

  it("一集都没有时提示可以先用模板填充", () => {
    const result = checkStep("script", makeProject({}, { script }));
    expect(result.ok).toBe(false);
    expect(result.issues.join()).toContain("模板填充");
  });

  it("每一场的必填项缺失时逐条报出场号", () => {
    const project = makeProject(
      {},
      {
        script,
        episodes: [makeEpisode(1, { scenes: [oneScene, makeScene({ no: 2, location: "天台" })] })],
      },
    );

    const result = checkStep("script", project);

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("第 1 集 第 2 场：写清这一场发生了什么");
    expect(result.issues).toContain("第 1 集 第 2 场：至少写一个出场角色");
    expect(result.issues).not.toContain("第 1 集 第 1 场：填写地点");
  });

  it("场次写全（允许占位角色名）后放行", () => {
    const project = makeProject(
      {},
      {
        script,
        episodes: [makeEpisode(1, { scenes: [oneScene] })],
      },
    );

    expect(checkStep("script", project).ok).toBe(true);
  });
});

describe("checkStep('storyboard')", () => {
  const shot = makeShot({ episodeId: "ep-1", sceneId: "s-1" });

  it("某场还没拆镜时不放行，并指出是哪一集哪一场", () => {
    const project = makeProject(
      {},
      {
        episodes: [
          makeEpisode(1, {
            id: "ep-1",
            scenes: [
              makeScene({ id: "s-1", no: 1, shots: [shot] }),
              makeScene({ id: "s-2", no: 2, location: "天台" }),
            ],
          }),
        ],
      },
    );

    const result = checkStep("storyboard", project);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(["第 1 集 第 2 场：还没有镜头，先拆镜"]);
  });

  it("每场都有镜头后放行（总时长超标不阻塞）", () => {
    const project = makeProject(
      { episodeDurationMs: 1000 },
      {
        episodes: [
          makeEpisode(1, {
            id: "ep-1",
            scenes: [makeScene({ id: "s-1", no: 1, shots: [shot, { ...shot, id: "shot-2" }] })],
          }),
        ],
      },
    );

    expect(checkStep("storyboard", project).ok).toBe(true);
  });
});

describe("checkStep('prompt')", () => {
  /** 一集一场，`shots` 为这一场的镜头。 */
  function projectWithShots(shots: ReturnType<typeof makeShot>[]): ReturnType<typeof makeProject> {
    return makeProject(
      {},
      {
        episodes: [
          makeEpisode(1, { id: "ep-1", scenes: [makeScene({ id: "s-1", no: 1, shots })] }),
        ],
      },
    );
  }

  it("有镜头还没出题时不放行，并点名是哪一集哪一场哪一镜", () => {
    const project = projectWithShots([makeShot({ episodeId: "ep-1", sceneId: "s-1", no: 1 })]);

    const result = checkStep("prompt", project);

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain("第 1 集 第 1 场 · 镜 1");
    expect(result.issues.join()).toContain("整集出题");
  });

  it("待出题的镜头超过 5 个时补一句总数", () => {
    const shots = Array.from({ length: 6 }, (_, index) =>
      makeShot({ episodeId: "ep-1", sceneId: "s-1", no: index + 1 }),
    );

    const result = checkStep("prompt", projectWithShots(shots));

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain("等 6 镜");
  });

  it("每一镜都出过题后放行", () => {
    const shot = makeShot({ episodeId: "ep-1", sceneId: "s-1", no: 1 });
    const scene = makeScene({ id: "s-1", no: 1, shots: [shot] });
    const episode = makeEpisode(1, { id: "ep-1", scenes: [scene] });
    const base = makeProject({}, { episodes: [episode] });
    const bundle = buildPromptBundle({ project: base, episode, scene, shot });

    const project = projectWithShots([{ ...shot, promptBundle: bundle }]);

    expect(checkStep("prompt", project).ok).toBe(true);
  });
});

describe("<StepGuard />", () => {
  it("未通过时列出待办", () => {
    render(
      <StepGuard result={{ ok: false, issues: ["卡1：填写作品名", "卡2：选择画面分辨率"] }} />,
    );
    expect(screen.getByText("还差这些才能进入下一步：")).toBeTruthy();
    expect(screen.getByText("卡1：填写作品名")).toBeTruthy();
    expect(screen.getByText("卡2：选择画面分辨率")).toBeTruthy();
  });

  it("通过时不渲染任何内容", () => {
    const { container } = render(<StepGuard result={{ ok: true, issues: [] }} />);
    expect(container.textContent).toBe("");
  });
});
