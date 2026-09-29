/**
 * 步骤守卫测试：既锁住"什么时候不让走下一步"的判断，也锁住提示文案
 * 必须是可以照着做的动作，而不是字段名。
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StepGuard } from "../src/components/StepGuard";
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
    expect(checkStep("script", makeProject()).ok).toBe(true);
    expect(checkStep("post", makeProject()).ok).toBe(true);
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
