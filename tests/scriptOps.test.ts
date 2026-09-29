/**
 * 剧本纯函数测试：场号重排、排序、角色引用收集与纯文本导入解析。
 *
 * 这些逻辑决定了"第 4 步拆镜按场号取镜"能否成立，一旦错位下游全乱，
 * 所以顺序与编号是最该被锁住的部分。
 */

import { describe, expect, it } from "vitest";
import {
  collectCharacterRefs,
  makeEpisode,
  makeScene,
  moveScene,
  parseScenesFromText,
  renumberScenes,
  undefinedCharacterRefs,
} from "../src/lib/scriptOps";
import type { Scene } from "../src/lib/types";
import { makeProject } from "./support/project";

function scenesWithNos(...nos: number[]): Scene[] {
  return nos.map((no, index) => makeScene({ id: `s-${index + 1}`, no }));
}

describe("renumberScenes", () => {
  it("把断档的场号压成 1..n，且保持原顺序", () => {
    const next = renumberScenes(scenesWithNos(1, 3, 5));
    expect(next.map((scene) => scene.no)).toEqual([1, 2, 3]);
    expect(next.map((scene) => scene.id)).toEqual(["s-1", "s-2", "s-3"]);
  });

  it("已经连续时不产生新对象", () => {
    const input = scenesWithNos(1, 2);
    const next = renumberScenes(input);
    expect(next[0]).toBe(input[0]);
    expect(next[1]).toBe(input[1]);
  });
});

describe("moveScene", () => {
  it("上移后顺序改变并重新编号", () => {
    const next = moveScene(scenesWithNos(1, 2, 3), "s-3", -1);
    expect(next.map((scene) => scene.id)).toEqual(["s-1", "s-3", "s-2"]);
    expect(next.map((scene) => scene.no)).toEqual([1, 2, 3]);
  });

  it("越界时原样返回同一个数组（不循环）", () => {
    const input = scenesWithNos(1, 2);
    expect(moveScene(input, "s-1", -1)).toBe(input);
    expect(moveScene(input, "s-2", 1)).toBe(input);
  });

  it("找不到场时不改动", () => {
    const input = scenesWithNos(1);
    expect(moveScene(input, "不存在", 1)).toBe(input);
  });
});

describe("角色引用", () => {
  const project = makeProject(
    {},
    {
      episodes: [
        makeEpisode(1, {
          scenes: [
            makeScene({ characters: [" 林晚 ", "张德海", "林晚"] }),
            makeScene({ characters: ["张德海", ""] }),
          ],
        }),
      ],
    },
  );

  it("去重、去空白并保留首次出现顺序", () => {
    expect(collectCharacterRefs(project)).toEqual(["林晚", "张德海"]);
  });

  it("id / name / aliases 任一命中即视为已建档", () => {
    const withCards = makeProject(
      {},
      {
        episodes: project.episodes,
        assets: {
          characters: [
            { ...emptyCharacter(), id: "c-1", name: "林晚" },
            { ...emptyCharacter(), id: "c-2", name: "老张", aliases: ["张德海"] },
          ],
          scenes: [],
          props: [],
          styleLock: { promptTemplate: "", refImages: [], seed: null },
        },
      },
    );

    expect(undefinedCharacterRefs(withCards)).toEqual([]);
  });

  it("没有角色卡时全员待补", () => {
    expect(undefinedCharacterRefs(project)).toEqual(["林晚", "张德海"]);
  });
});

function emptyCharacter() {
  return {
    id: "",
    name: "",
    aliases: [] as string[],
    age: "",
    gender: "",
    appearance: {
      faceShape: "",
      hair: "",
      hairColor: "",
      eyeColor: "",
      height: "",
      body: "",
    },
    costumes: [],
    personality: "",
    speechStyle: "",
    voice: "",
    refImages: [],
    portrait: null,
  };
}

describe("parseScenesFromText", () => {
  const text = [
    "第 1 场 内景 出租屋 夜",
    "林晚：这房租，我不能交。",
    "（她把信封拍在桌上）",
    "道具：一枚旧怀表",
    "旁白：三年前，她也说过同样的话。",
    "",
    "第 2 场 外景 街道 黄昏",
    "林晚：拦下那辆车。",
  ].join("\n");

  it("按空行分场并解析场头", () => {
    const scenes = parseScenesFromText(text);
    expect(scenes).toHaveLength(2);

    expect(scenes[0].no).toBe(1);
    expect(scenes[0].location).toBe("出租屋");
    expect(scenes[0].timeOfDay).toBe("夜");
    expect(scenes[0].interior).toBe(true);

    expect(scenes[1].no).toBe(2);
    expect(scenes[1].location).toBe("街道");
    expect(scenes[1].timeOfDay).toBe("黄昏");
    expect(scenes[1].interior).toBe(false);
  });

  it("「角色：台词」进对白，旁白不占角色位，其它行并入动作描述", () => {
    const [first] = parseScenesFromText(text);

    expect(first.dialogues).toHaveLength(2);
    expect(first.dialogues[0]).toMatchObject({ characterId: "林晚", isNarration: false });
    expect(first.dialogues[1]).toMatchObject({ characterId: "旁白", isNarration: true });

    expect(first.characters).toEqual(["林晚"]);
    expect(first.actionDesc).toContain("她把信封拍在桌上");
    expect(first.actionDesc).toContain("道具：一枚旧怀表");
  });

  it("空文本得到空数组", () => {
    expect(parseScenesFromText("  \n\n ")).toEqual([]);
  });
});
