/**
 * 分镜出题层测试：请求里必须写清枚举与上下文，解析必须把模型的自造词挡在外面。
 *
 * 「宁可回落到默认值，也不让非法值进右栏」是这一步的核心约束，
 * 所以解析用例覆盖了自造景别、越界时长、缺画面描述这几类常见翻车。
 */

import { describe, expect, it } from "vitest";
import { buildShotRequest, parseShotResult } from "../src/lib/shotPrompts";
import { DEFAULT_SHOT_MS, MAX_SHOT_MS, MIN_SHOT_MS } from "../src/lib/shotOps";
import { makeDialogue, makeEpisode, makeScene } from "../src/lib/scriptOps";
import { defaultMeta } from "../src/lib/types";

function sceneWithDialogue() {
  return makeScene({
    id: "sc-1",
    no: 2,
    location: "天台",
    timeOfDay: "夜",
    interior: false,
    characters: ["林晚", "陆沉"],
    actionDesc: "林晚把手机举到他面前。",
    dialogues: [makeDialogue({ characterId: "林晚", text: "你自己看。" })],
  });
}

describe("buildShotRequest", () => {
  it("system 里列出三组枚举，供模型照抄", () => {
    const request = buildShotRequest(makeEpisode(1), sceneWithDialogue(), defaultMeta());
    const system = request.messages[0].content;

    expect(request.messages).toHaveLength(2);
    expect(system).toContain("medium_shot（中景）");
    expect(system).toContain("static_shot（固定镜头）");
    expect(system).toContain("cut（硬切）");
    expect(system).toContain(`${MIN_SHOT_MS}-${20_000}`);
  });

  it("user 里带上这一场的原文与台词，且给出 JSON 结构", () => {
    const request = buildShotRequest(makeEpisode(1), sceneWithDialogue(), defaultMeta());
    const user = request.messages[1].content;

    expect(user).toContain("地点：天台");
    expect(user).toContain("林晚：你自己看。");
    expect(user).toContain('"shots"');
  });

  it("有补充要求时追加到 user 末尾", () => {
    const withOut = buildShotRequest(makeEpisode(1), sceneWithDialogue(), defaultMeta());
    const withIn = buildShotRequest(
      makeEpisode(1),
      sceneWithDialogue(),
      defaultMeta(),
      "多给两个特写",
    );

    expect(withOut.messages[1].content).not.toContain("用户补充要求");
    expect(withIn.messages[1].content).toContain("用户补充要求");
    expect(withIn.messages[1].content).toContain("多给两个特写");
  });

  it("这一场没有台词时，user 里明确写出「没有台词」而不是留空", () => {
    const request = buildShotRequest(makeEpisode(1), makeScene({ no: 1 }), defaultMeta());
    expect(request.messages[1].content).toContain("（这一场没有台词）");
  });
});

describe("parseShotResult", () => {
  it("解析合法数组，字段逐项落位", () => {
    const raw = JSON.stringify({
      shots: [
        {
          shotSize: "close_up",
          cameraMove: "push_in",
          durationMs: 2500,
          visualDesc: "她的手在发抖",
          characters: ["林晚"],
          dialogue: "你别过来。",
          narration: null,
          sfxHint: "玻璃碎裂声",
          transition: "dissolve",
          note: "给特写",
        },
      ],
    });

    const shots = parseShotResult(raw);

    expect(shots).toHaveLength(1);
    expect(shots[0]).toEqual({
      shotSize: "close_up",
      cameraMove: "push_in",
      durationMs: 2500,
      visualDesc: "她的手在发抖",
      characters: ["林晚"],
      dialogue: "你别过来。",
      narration: null,
      sfxHint: "玻璃碎裂声",
      transition: "dissolve",
      note: "给特写",
    });
  });

  it("自造景别 / 运镜 / 转场全部回落到默认档", () => {
    const raw = JSON.stringify({
      shots: [
        {
          shotSize: "中近景",
          cameraMove: "慢慢推",
          transition: "闪白",
          durationMs: 3000,
          visualDesc: "画面",
        },
      ],
    });

    const shots = parseShotResult(raw);

    expect(shots[0].shotSize).toBe("medium_shot");
    expect(shots[0].cameraMove).toBe("static_shot");
    expect(shots[0].transition).toBe("cut");
  });

  it("时长越界被夹进 [MIN, MAX]，缺失则用默认值", () => {
    const raw = JSON.stringify({
      shots: [
        { durationMs: 60_000, visualDesc: "太长" },
        { durationMs: 1, visualDesc: "太短" },
        { visualDesc: "没写时长" },
      ],
    });

    const shots = parseShotResult(raw);

    expect(shots[0].durationMs).toBe(MAX_SHOT_MS);
    expect(shots[1].durationMs).toBe(MIN_SHOT_MS);
    expect(shots[2].durationMs).toBe(DEFAULT_SHOT_MS);
  });

  it("缺画面描述的镜头被丢弃：它在下一步是死路", () => {
    const raw = JSON.stringify({
      shots: [{ shotSize: "close_up" }, { visualDesc: "   " }, { visualDesc: "留下我" }],
    });

    const shots = parseShotResult(raw);

    expect(shots).toHaveLength(1);
    expect(shots[0].visualDesc).toBe("留下我");
  });

  it("容忍 Markdown 代码围栏与前后寒暄", () => {
    const raw = [
      "好的，以下是分镜：",
      "```json",
      '{"shots":[{"visualDesc":"她推开门"}]}',
      "```",
    ].join("\n");

    expect(parseShotResult(raw)).toHaveLength(1);
  });

  it("没有 JSON 对象时抛错，交由编排层提示重试", () => {
    expect(() => parseShotResult("我觉得这一场应该先给个全景。")).toThrow();
  });

  it("shots 不是数组时返回空数组而不是抛错", () => {
    expect(parseShotResult('{"shots":"稍等"}')).toEqual([]);
  });
});
