/**
 * 关键帧纯函数测试：帧工厂/取用、候选增删与定稿、跨镜参考解析、首帧缺失判定，
 * 以及参考表分区标注。
 *
 * 这一层不碰 store 也不做 IO，全部是同步断言。参考表分区是**跨端约定**：
 * 这里钉死的规则必须与 Rust `src-tauri/src/refsheet.rs::layout_for` 的单测一致
 * ——Rust 管像素布局，前端管中文分区文案，两端各写一份、各钉一组。
 */

import { describe, expect, it } from "vitest";

import {
  MAX_FRAME_REFS,
  addCandidates,
  adoptCandidate,
  detachCandidate,
  ensureFrame,
  frameByRole,
  frameRoleLabel,
  makeFrame,
  pendingKeyframeIssues,
  refSheetCells,
  refShotOptions,
  setFrameRefShot,
  shotKeyframeIssue,
  shotReferenceFrame,
  usesRefSheet,
} from "../src/lib/frameOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type { Frame, FrameRole, Project, Shot } from "../src/lib/types";
import { makeProject } from "./support/project";

function shotWith(patch: Partial<Shot> = {}): Shot {
  return makeShot({ episodeId: "ep-1", sceneId: "sc-1", ...patch });
}

function frameWith(role: FrameRole, patch: Partial<Frame> = {}): Frame {
  return { ...makeFrame(role), ...patch };
}

describe("帧工厂与取用", () => {
  it("makeFrame 造出空帧：无候选、未定稿、无跨镜参考", () => {
    const frame = makeFrame("first");
    expect(frame.role).toBe("first");
    expect(frame.candidates).toEqual([]);
    expect(frame.adopted).toBeNull();
    expect(frame.refShotId).toBeNull();
    expect(frame.id.startsWith("frame-")).toBe(true);
  });

  it("frameRoleLabel 给定稿界面用的中文名", () => {
    expect(frameRoleLabel("first")).toBe("首帧");
    expect(frameRoleLabel("last")).toBe("尾帧");
  });

  it("ensureFrame 缺帧才补，已有则原样返回（同一引用）", () => {
    const bare = shotWith();
    const once = ensureFrame(bare, "first");
    expect(frameByRole(once, "first")).toBeTruthy();

    const twice = ensureFrame(once, "first");
    expect(twice).toBe(once);
  });
});

describe("候选增删与定稿", () => {
  it("addCandidates 去重、去空白、保持首次出现顺序", () => {
    const bare = makeFrame("first");
    const next = addCandidates(bare, ["a.png", "a.png", " b.png ", "", "a.png"]);
    expect(next.candidates).toEqual(["a.png", "b.png"]);
  });

  it("addCandidates 全空时返回原帧（同一引用）", () => {
    const bare = makeFrame("first");
    expect(addCandidates(bare, ["", "  "])).toBe(bare);
  });

  it("adoptCandidate 记录定稿图", () => {
    const frame = frameWith("first", { candidates: ["a.png", "b.png"] });
    expect(adoptCandidate(frame, "b.png").adopted).toBe("b.png");
  });

  it("detachCandidate 摘掉候选；摘的正是定稿时定稿一并清空", () => {
    const frame = frameWith("first", { candidates: ["a.png", "b.png"], adopted: "a.png" });
    const next = detachCandidate(frame, "a.png");
    expect(next.candidates).toEqual(["b.png"]);
    expect(next.adopted).toBeNull();
  });

  it("setFrameRefShot 设/解除跨镜参考", () => {
    const frame = makeFrame("first");
    expect(setFrameRefShot(frame, "shot-9").refShotId).toBe("shot-9");
    expect(setFrameRefShot(setFrameRefShot(frame, "shot-9"), null).refShotId).toBeNull();
  });
});

describe("定稿帧解析（跨镜参考的口径）", () => {
  it("优先尾帧定稿，退回首帧定稿", () => {
    const both = shotWith({
      frames: [frameWith("first", { adopted: "f.png" }), frameWith("last", { adopted: "l.png" })],
    });
    expect(shotReferenceFrame(both)).toEqual({ role: "last", path: "l.png" });

    const onlyFirst = shotWith({ frames: [frameWith("first", { adopted: "f.png" })] });
    expect(shotReferenceFrame(onlyFirst)).toEqual({ role: "first", path: "f.png" });
  });

  it("没有任何定稿帧时返回 null", () => {
    expect(shotReferenceFrame(shotWith())).toBeNull();
    expect(
      shotReferenceFrame(shotWith({ frames: [frameWith("first", { candidates: ["a.png"] })] })),
    ).toBeNull();
  });
});

describe("refShotOptions：跨镜参考候选", () => {
  function twoShotProject(): Project {
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
                shots: [
                  shotWith({ id: "shot-1", no: 1 }),
                  shotWith({
                    id: "shot-2",
                    no: 2,
                    frames: [frameWith("first", { adopted: "assets/frame/shot-2/a.png" })],
                  }),
                  shotWith({ id: "shot-3", no: 3 }), // 无定稿帧，不该出现
                ],
              }),
            ],
          }),
        ],
      },
    );
  }

  it("排除自己，只收有定稿帧的镜头，并带上展示名与帧角色", () => {
    const options = refShotOptions(twoShotProject(), "shot-1");
    expect(options.map((option) => option.shotId)).toEqual(["shot-2"]);
    expect(options[0].label).toBe("第 1 集 第 1 场 · 镜 2");
    expect(options[0].role).toBe("first");
    expect(options[0].path).toBe("assets/frame/shot-2/a.png");
  });

  it("当前镜头自己不会出现在候选里", () => {
    const options = refShotOptions(twoShotProject(), "shot-2");
    expect(options.map((option) => option.shotId)).toEqual([]);
  });
});

describe("首帧缺失判定（第 6/7 步的门禁口径）", () => {
  it("首帧未定稿给出可读文案，已定稿返回 null", () => {
    const pending = shotWith({ no: 3 });
    expect(shotKeyframeIssue(pending)).toBe("镜 3：首帧还没定稿");

    const done = shotWith({
      no: 3,
      frames: [frameWith("first", { adopted: "a.png" })],
    });
    expect(shotKeyframeIssue(done)).toBeNull();
  });

  it("pendingKeyframeIssues 扫全集并带上级/场前缀", () => {
    const project = makeProject(
      {},
      {
        episodes: [
          makeEpisode(1, {
            id: "ep-1",
            scenes: [
              makeScene({
                id: "sc-1",
                no: 2,
                shots: [shotWith({ id: "shot-1", no: 3 })],
              }),
            ],
          }),
        ],
      },
    );
    expect(pendingKeyframeIssues(project)).toEqual(["第 1 集 第 2 场 · 镜 3：首帧还没定稿"]);
  });

  it("没有镜头时返回空数组（新项目不误报）", () => {
    expect(pendingKeyframeIssues(makeProject())).toEqual([]);
  });
});

describe("参考表分区标注（与 Rust layout_for 同规则）", () => {
  it("2 张左右、3 张行优先、4 张填满 2×2", () => {
    expect(refSheetCells(2)).toEqual(["左", "右"]);
    expect(refSheetCells(3)).toEqual(["左上", "右上", "左下"]);
    expect(refSheetCells(4)).toEqual(["左上", "右上", "左下", "右下"]);
  });

  it("0/1 张不拼图，超过上限也不适用", () => {
    expect(refSheetCells(0)).toEqual([]);
    expect(refSheetCells(1)).toEqual([]);
    expect(refSheetCells(5)).toEqual([]);
  });

  it("usesRefSheet 只在 2..MAX_FRAME_REFS 之间为真", () => {
    expect(MAX_FRAME_REFS).toBe(4);
    expect(usesRefSheet(1)).toBe(false);
    expect(usesRefSheet(2)).toBe(true);
    expect(usesRefSheet(4)).toBe(true);
    expect(usesRefSheet(5)).toBe(false);
  });
});
