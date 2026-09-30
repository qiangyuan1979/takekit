/**
 * 分镜纯函数层测试：字典、防御式转换、拆镜兜底、时长累计与超标比较。
 *
 * 这些函数是第 4 步的"算术底座"——界面上的每次输入最终都要经过它们，
 * 所以这里的边界（恰好等于限额 / 超 1 毫秒 / 严重超标）必须锁死。
 */

import { describe, expect, it } from "vitest";
import {
  CAMERA_MOVE_OPTIONS,
  DEFAULT_SHOT_MS,
  MAX_SHOT_MS,
  MIN_SHOT_MS,
  SHOT_SIZE_OPTIONS,
  TRANSITION_OPTIONS,
  cameraMoveLabel,
  clampDurationMs,
  compareDuration,
  episodeDurationMs,
  episodeShotCount,
  formatDuration,
  makeShot,
  moveShots,
  renumberShots,
  shotSizeLabel,
  splitSceneIntoShots,
  sumDurationMs,
  toCameraMove,
  toShotSize,
  toTransition,
  transitionLabel,
} from "../src/lib/shotOps";
import { makeDialogue, makeEpisode, makeScene } from "../src/lib/scriptOps";

describe("下拉字典", () => {
  it("景别 / 运镜 / 转场都给出了值到中文的对应", () => {
    expect(SHOT_SIZE_OPTIONS).toHaveLength(5);
    expect(CAMERA_MOVE_OPTIONS).toHaveLength(8);
    expect(TRANSITION_OPTIONS).toHaveLength(5);
    expect(shotSizeLabel("close_up")).toBe("近景");
    expect(cameraMoveLabel("push_in")).toBe("推近");
    expect(transitionLabel("dissolve")).toBe("叠化");
  });

  it("枚举值即 Rust 端字面量，没有多余的大小写变形", () => {
    expect(SHOT_SIZE_OPTIONS.map((option) => option.value)).toContain("extreme_close_up");
    expect(CAMERA_MOVE_OPTIONS.map((option) => option.value)).toContain("static_shot");
    expect(TRANSITION_OPTIONS.map((option) => option.value)).toContain("whip_pan");
  });
});

describe("防御式转换：模型自造的词不许进右栏", () => {
  it("合法值原样返回，前后空格被容忍", () => {
    expect(toShotSize(" close_up ")).toBe("close_up");
    expect(toCameraMove("orbit")).toBe("orbit");
    expect(toTransition("cut")).toBe("cut");
  });

  it("非法值 / 非字符串回落到默认档", () => {
    expect(toShotSize("中近景")).toBe("medium_shot");
    expect(toCameraMove("慢慢推")).toBe("static_shot");
    expect(toTransition(3)).toBe("cut");
    expect(toCameraMove(undefined, "follow")).toBe("follow");
  });
});

describe("clampDurationMs", () => {
  it("非法输入回落到默认时长", () => {
    expect(clampDurationMs(0)).toBe(DEFAULT_SHOT_MS);
    expect(clampDurationMs(-100)).toBe(DEFAULT_SHOT_MS);
    expect(clampDurationMs(Number.NaN)).toBe(DEFAULT_SHOT_MS);
    expect(clampDurationMs("abc")).toBe(DEFAULT_SHOT_MS);
  });

  it("超上限截到上限，低于下限抬到下限", () => {
    expect(clampDurationMs(60_000)).toBe(MAX_SHOT_MS);
    expect(clampDurationMs(10)).toBe(MIN_SHOT_MS);
  });

  it("字符串数字可用，并四舍五入到整数毫秒", () => {
    expect(clampDurationMs("2500")).toBe(2500);
    expect(clampDurationMs(1999.6)).toBe(2000);
  });
});

describe("镜头工厂与重排", () => {
  it("makeShot 给出可用的默认值，patch 覆盖之", () => {
    const shot = makeShot({ episodeId: "ep-1", sceneId: "sc-1", visualDesc: "她推开门" });
    expect(shot.episodeId).toBe("ep-1");
    expect(shot.sceneId).toBe("sc-1");
    expect(shot.shotSize).toBe("medium_shot");
    expect(shot.cameraMove).toBe("static_shot");
    expect(shot.durationMs).toBe(DEFAULT_SHOT_MS);
    expect(shot.visualDesc).toBe("她推开门");
    expect(shot.dialogue).toBeNull();
    expect(shot.characters).toEqual([]);
    expect(shot.id.startsWith("shot-")).toBe(true);
  });

  it("renumberShots 把镜号连续化为 1..n", () => {
    const shots = [
      makeShot({ episodeId: "ep-1", sceneId: "sc-1", no: 7 }),
      makeShot({ episodeId: "ep-1", sceneId: "sc-1", no: 7 }),
    ];
    expect(renumberShots(shots).map((shot) => shot.no)).toEqual([1, 2]);
  });

  it("moveShots 交换位置并重编号", () => {
    const shots = renumberShots([
      makeShot({ episodeId: "ep-1", sceneId: "sc-1", visualDesc: "A" }),
      makeShot({ episodeId: "ep-1", sceneId: "sc-1", visualDesc: "B" }),
      makeShot({ episodeId: "ep-1", sceneId: "sc-1", visualDesc: "C" }),
    ]);
    const moved = moveShots(shots, shots[2].id, -1);
    expect(moved.map((shot) => shot.visualDesc)).toEqual(["A", "C", "B"]);
    expect(moved.map((shot) => shot.no)).toEqual([1, 2, 3]);
  });

  it("moveShots 越界时原样返回，不循环", () => {
    const shots = renumberShots([makeShot({ episodeId: "ep-1", sceneId: "sc-1" })]);
    expect(moveShots(shots, shots[0].id, -1)).toBe(shots);
    expect(moveShots(shots, shots[0].id, 1)).toBe(shots);
    expect(moveShots(shots, "not-exist", 1)).toBe(shots);
  });
});

describe("规则兜底拆镜", () => {
  it("没有台词的场至少产出 1 个交代镜，并带上场里的角色", () => {
    const scene = makeScene({
      id: "sc-1",
      no: 1,
      location: "写字楼大堂",
      interior: true,
      characters: ["林晚"],
      actionDesc: "她隔着玻璃看着里面的人举杯。",
    });

    const shots = splitSceneIntoShots(scene, { episodeId: "ep-1" });

    expect(shots).toHaveLength(1);
    expect(shots[0].no).toBe(1);
    expect(shots[0].visualDesc).toBe("她隔着玻璃看着里面的人举杯。");
    expect(shots[0].characters).toEqual(["林晚"]);
    expect(shots[0].episodeId).toBe("ep-1");
    expect(shots[0].sceneId).toBe("sc-1");
  });

  it("每条台词各一镜，说话人自动进出场角色；旁白进 narration", () => {
    const scene = makeScene({
      id: "sc-1",
      no: 2,
      location: "天台",
      actionDesc: "",
      dialogues: [
        makeDialogue({ characterId: "林晚", text: "你别过来。" }),
        makeDialogue({ characterId: "陆沉", text: "我只想问一句。" }),
        makeDialogue({ text: "风把两人的话吹散了。", isNarration: true }),
      ],
    });

    const shots = splitSceneIntoShots(scene, { episodeId: "ep-1" });

    // 交代镜 + 2 条台词 + 1 条旁白
    expect(shots).toHaveLength(4);
    expect(shots[1].dialogue).toBe("你别过来。");
    expect(shots[1].characters).toEqual(["林晚"]);
    expect(shots[2].characters).toEqual(["陆沉"]);
    expect(shots[3].narration).toBe("风把两人的话吹散了。");
    expect(shots[3].dialogue).toBeNull();
    expect(shots[3].characters).toEqual([]);
  });

  it("空台词被跳过；交代镜没有动作描述时回落到「内景/外景 + 地点」", () => {
    const scene = makeScene({
      id: "sc-1",
      no: 3,
      location: "旧仓库",
      interior: false,
      actionDesc: "   ",
      dialogues: [makeDialogue({ text: "   " })],
    });

    const shots = splitSceneIntoShots(scene, { episodeId: "ep-1" });

    expect(shots).toHaveLength(1);
    expect(shots[0].visualDesc).toBe("外景 旧仓库");
  });

  it("options.durationMs 统一作用到派生镜头，非法值回落默认", () => {
    const scene = makeScene({ id: "sc-1", no: 1 });
    expect(splitSceneIntoShots(scene, { episodeId: "ep-1", durationMs: 5000 })[0].durationMs).toBe(
      5000,
    );
    expect(splitSceneIntoShots(scene, { episodeId: "ep-1", durationMs: -1 })[0].durationMs).toBe(
      DEFAULT_SHOT_MS,
    );
  });
});

describe("时长累计与超标比较", () => {
  it("sumDurationMs 累加各镜时长", () => {
    const scene = makeScene({
      no: 1,
      shots: [
        makeShot({ episodeId: "ep-1", sceneId: "sc-1", durationMs: 3000 }),
        makeShot({ episodeId: "ep-1", sceneId: "sc-1", durationMs: 4500 }),
      ],
    });
    expect(sumDurationMs(scene.shots)).toBe(7500);
  });

  it("episodeDurationMs / episodeShotCount 跨场汇总", () => {
    const episode = makeEpisode(1, {
      scenes: [
        makeScene({
          no: 1,
          shots: [makeShot({ episodeId: "ep-1", sceneId: "sc-1", durationMs: 3000 })],
        }),
        makeScene({
          no: 2,
          shots: [
            makeShot({ episodeId: "ep-1", sceneId: "sc-2", durationMs: 2000 }),
            makeShot({ episodeId: "ep-1", sceneId: "sc-2", durationMs: 1000 }),
          ],
        }),
      ],
    });

    expect(episodeDurationMs(episode)).toBe(6000);
    expect(episodeShotCount(episode)).toBe(3);
  });

  it("恰好等于限额不算超标", () => {
    const result = compareDuration(60_000, 60_000);
    expect(result.over).toBe(false);
    expect(result.deltaMs).toBe(0);
    expect(result.ratio).toBe(1);
  });

  it("超出 1 毫秒即算超标", () => {
    const result = compareDuration(60_001, 60_000);
    expect(result.over).toBe(true);
    expect(result.deltaMs).toBe(1);
  });

  it("严重超标时比例大于 1，供时长条撑满", () => {
    const result = compareDuration(180_000, 60_000);
    expect(result.over).toBe(true);
    expect(result.ratio).toBe(3);
  });

  it("限额为 0 时比例回落到 0，不做除零", () => {
    expect(compareDuration(3000, 0).ratio).toBe(0);
  });

  it("formatDuration 说人话", () => {
    expect(formatDuration(0)).toBe("0 秒");
    expect(formatDuration(45_000)).toBe("45 秒");
    expect(formatDuration(65_000)).toBe("1 分 05 秒");
    expect(formatDuration(120_000)).toBe("2 分 00 秒");
  });
});
