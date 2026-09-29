/**
 * 出题层测试：LLM 请求的构建契约。
 *
 * 重点锁三件事：用户补充要求必须原样带进 user prompt、被锁字段不得出现在
 * 要求模型输出的 JSON 骨架里、B 段节拍被锁时不能要求模型给 beats。
 * 这三条对应"AI 只改该改的东西"这一产品承诺。
 */

import { describe, expect, it } from "vitest";
import { buildScriptRequest, type PromptContext } from "../src/lib/llmPrompts";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { BEATS_LOCK_KEY, structureById } from "../src/lib/scriptTemplates";
import type { Script } from "../src/lib/types";
import { makeProject } from "./support/project";

const STRUCTURE = structureById("", "short_drama");

function context(scriptPatch: Partial<Script> = {}): PromptContext {
  const base = makeProject();
  const episode = makeEpisode(1, {
    id: "ep-1",
    scenes: [makeScene({ id: "sc-1", no: 1 })],
  });
  return {
    meta: base.meta,
    script: { ...base.script, ...scriptPatch },
    episode,
    scene: episode.scenes[0],
  };
}

/** 取 user prompt（第二条消息）。 */
function userPrompt(request: { messages: { role: string; content: string }[] }): string {
  const message = request.messages.find((item) => item.role === "user");
  if (!message) throw new Error("请求里没有 user 消息");
  return message.content;
}

describe("buildScriptRequest · system", () => {
  it("把立项参数与结构模板带进 system prompt", () => {
    const request = buildScriptRequest("generate", { kind: "creativeCore" }, context(), STRUCTURE);
    const system = request.messages[0].content;

    expect(request.messages[0].role).toBe("system");
    expect(system).toContain("【立项参数】");
    expect(system).toContain(STRUCTURE.label);
    expect(system).toContain("简体中文");
  });
});

describe("buildScriptRequest · 用户补充要求", () => {
  it("有补充要求时原样追加（已去首尾空白）", () => {
    const request = buildScriptRequest(
      "rewrite",
      { kind: "creativeCore" },
      context(),
      STRUCTURE,
      "  更口语化  ",
    );

    const user = userPrompt(request);
    expect(user).toContain("【用户补充要求】");
    expect(user).toContain("更口语化");
  });

  it("没有补充要求时不出现该段", () => {
    const request = buildScriptRequest("generate", { kind: "creativeCore" }, context(), STRUCTURE);
    expect(userPrompt(request)).not.toContain("【用户补充要求】");
  });

  it("只有空白字符的补充要求同样视为没有", () => {
    const request = buildScriptRequest(
      "generate",
      { kind: "creativeCore" },
      context(),
      STRUCTURE,
      "   \n  ",
    );
    expect(userPrompt(request)).not.toContain("【用户补充要求】");
  });
});

describe("buildScriptRequest · A 段字段锁", () => {
  it("被锁字段不出现在要求模型输出的骨架里", () => {
    const request = buildScriptRequest(
      "generate",
      { kind: "creativeCore" },
      context({ lockedFields: ["logline"] }),
      STRUCTURE,
    );

    const user = userPrompt(request);
    expect(user).not.toContain('"logline"');
    expect(user).toContain('"coreConflict"');
  });

  it("当前内容里仍然列出已锁字段，避免模型误判上下文缺失", () => {
    const request = buildScriptRequest(
      "generate",
      { kind: "creativeCore" },
      context({ logline: "一句话", lockedFields: ["logline"] }),
      STRUCTURE,
    );
    expect(userPrompt(request)).toContain("- 一句话故事：一句话");
  });

  it("全部字段锁定时明确要求不要输出任何字段", () => {
    const request = buildScriptRequest(
      "generate",
      { kind: "creativeCore" },
      context({
        lockedFields: ["logline", "coreConflict", "protagonistGoal", "obstacle", "hook", "twist"],
      }),
      STRUCTURE,
    );
    expect(userPrompt(request)).toContain("当前所有字段都已锁定");
  });
});

describe("buildScriptRequest · B 段节拍锁", () => {
  it("节拍锁定时骨架里没有 beats", () => {
    const request = buildScriptRequest(
      "rewrite",
      { kind: "outline", episodeId: "ep-1" },
      context({ lockedFields: [BEATS_LOCK_KEY] }),
      STRUCTURE,
    );

    const user = userPrompt(request);
    expect(user).toContain("节拍已锁定");
    expect(user).not.toContain('"beats"');
  });

  it("未锁定时要求输出 summary 与 beats", () => {
    const request = buildScriptRequest(
      "generate",
      { kind: "outline", episodeId: "ep-1" },
      context(),
      STRUCTURE,
    );

    const user = userPrompt(request);
    expect(user).toContain('"summary"');
    expect(user).toContain('"beats"');
  });
});

describe("buildScriptRequest · C 段", () => {
  it("要求输出场级 JSON 骨架与先画面后对白的提示", () => {
    const request = buildScriptRequest(
      "generate",
      { kind: "scene", episodeId: "ep-1", sceneId: "sc-1" },
      context(),
      STRUCTURE,
    );

    const user = userPrompt(request);
    expect(user).toContain('"actionDesc"');
    expect(user).toContain('"dialogues"');
    expect(user).toContain("先写动作与画面");
  });
});
