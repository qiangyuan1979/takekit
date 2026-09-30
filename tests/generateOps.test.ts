/**
 * 生成（第 7 步）纯函数层测试：抽卡计划、全局镜号、成本估算、事件归并、
 * 候选筛选、重试与中断恢复。
 *
 * 这一层不碰 store、不发请求，所以只喂数据、只看返回值；编排与落盘在
 * `generate.test.ts` 覆盖。
 */

import { describe, expect, it } from "vitest";

import {
  MAX_COPIES,
  applyGenerateEvent,
  clampCopies,
  clipCandidates,
  clipOf,
  failureOf,
  globalShotNo,
  interruptedTasks,
  isOpenTask,
  jobFromTask,
  jobsFromTasks,
  makeVideoTask,
  markInterrupted,
  planGeneration,
  retryTasks,
  summarizeGeneration,
  taskStatusLabel,
  tasksForShot,
  videoTaskRequest,
} from "../src/lib/generateOps";
import { makeEpisode, makeScene } from "../src/lib/scriptOps";
import { makeShot } from "../src/lib/shotOps";
import type {
  GenerateEvent,
  Project,
  PromptBundle,
  Task,
  VideoParams,
  VideoTaskRequest,
} from "../src/lib/types";
import { makeProject } from "./support/project";

function params(durationMs: number): VideoParams {
  return {
    durationMs,
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    motionStrength: 0.5,
    seed: null,
    negativePrompt: "",
    refImages: [],
    firstFrame: null,
    lastFrame: null,
  };
}

function bundle(zh: string, durationMs: number): PromptBundle {
  return {
    unified: { subject: "", environment: "", camera: "", lighting: "", style: "", quality: "" },
    zh,
    en: zh,
    params: params(durationMs),
    perProvider: {},
  };
}

/** 一集两场：场 1 两镜（镜 1 已出题 5s、镜 2 没出题），场 2 一镜（已出题 3s）。 */
function project(): Project {
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
                makeShot({
                  id: "shot-1",
                  episodeId: "ep-1",
                  sceneId: "sc-1",
                  no: 1,
                  promptBundle: bundle("推门", 5_000),
                }),
                makeShot({ id: "shot-2", episodeId: "ep-1", sceneId: "sc-1", no: 2 }),
              ],
            }),
            makeScene({
              id: "sc-2",
              no: 2,
              shots: [
                makeShot({
                  id: "shot-3",
                  episodeId: "ep-1",
                  sceneId: "sc-2",
                  no: 1,
                  promptBundle: bundle("回头", 3_000),
                }),
              ],
            }),
          ],
        }),
      ],
    },
  );
}

function request(patch: Partial<VideoTaskRequest> = {}): VideoTaskRequest {
  return {
    episodeId: "ep-1",
    sceneId: "sc-1",
    shotId: "shot-1",
    shotNo: 1,
    prompt: "推门",
    params: params(5_000),
    ...patch,
  };
}

function task(patch: Partial<VideoTaskRequest> = {}, status: Task["status"] = "queued"): Task {
  return { ...makeVideoTask("mock", request(patch)), status };
}

function clipTask(patch: Partial<VideoTaskRequest> = {}): Task {
  return {
    ...task(patch, "succeeded"),
    result: { kind: "clip", path: "clips/001_01.mp4", mime: "video/mp4" },
  };
}

describe("clampCopies", () => {
  it("夹进 [1, MAX_COPIES]，非法值退回 1", () => {
    expect(clampCopies(0)).toBe(1);
    expect(clampCopies(1)).toBe(1);
    expect(clampCopies(MAX_COPIES)).toBe(MAX_COPIES);
    expect(clampCopies(MAX_COPIES + 1)).toBe(MAX_COPIES);
    expect(clampCopies(2.6)).toBe(3);
    expect(clampCopies("3")).toBe(3);
    expect(clampCopies(Number.NaN)).toBe(1);
    expect(clampCopies(undefined)).toBe(1);
    expect(clampCopies("abc")).toBe(1);
  });
});

describe("globalShotNo", () => {
  it("跨集 / 场连续编号：归档文件名的前缀靠它保证唯一", () => {
    const target = project();
    expect(globalShotNo(target, "shot-1")).toBe(1);
    expect(globalShotNo(target, "shot-2")).toBe(2);
    expect(globalShotNo(target, "shot-3")).toBe(3);
    expect(globalShotNo(target, "shot-missing")).toBe(0);
  });
});

describe("planGeneration", () => {
  it("整集：已出题的镜各出 count 条，没出题的进 skipped，成本按条数 × 秒数算", () => {
    const plan = planGeneration(project(), "ep-1", null, "mock", 2);

    expect(plan.tasks).toHaveLength(4);
    expect(plan.skipped).toEqual(["第 1 集 第 1 场 · 镜 2"]);
    expect(plan.cost).toEqual({ clips: 4, shots: 2, totalMs: 16_000 });

    const first = videoTaskRequest(plan.tasks[0]);
    expect(first?.prompt).toBe("推门");
    expect(first?.shotNo).toBe(1);
    expect(first?.episodeId).toBe("ep-1");
    expect(first?.sceneId).toBe("sc-1");
    expect(plan.tasks.every((item) => item.status === "queued" && item.provider === "mock")).toBe(
      true,
    );
    // 同一镜的多条载荷相同，但任务 id 必须各不相同（各自是一条后端作业）。
    expect(videoTaskRequest(plan.tasks[1])).toEqual(first);
    expect(plan.tasks[0].id).not.toBe(plan.tasks[1].id);
  });

  it("单场：只覆盖指定场，且不把别场的未出题镜算进 skipped", () => {
    const plan = planGeneration(project(), "ep-1", "sc-2", "mock", 1);

    expect(plan.tasks).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
    expect(plan.cost).toEqual({ clips: 1, shots: 1, totalMs: 3_000 });
  });

  it("定位不到剧集时返回空计划", () => {
    expect(planGeneration(project(), "ep-x", null, "mock", 1)).toEqual({
      tasks: [],
      skipped: [],
      cost: { clips: 0, shots: 0, totalMs: 0 },
    });
  });

  it("全都没出题：不提交任何任务，但把待出题的镜列出来", () => {
    const bare = makeProject(
      {},
      {
        episodes: [
          makeEpisode(1, {
            id: "ep-1",
            scenes: [
              makeScene({
                id: "sc-1",
                no: 1,
                shots: [makeShot({ id: "shot-1", episodeId: "ep-1", sceneId: "sc-1", no: 1 })],
              }),
            ],
          }),
        ],
      },
    );

    const plan = planGeneration(bare, "ep-1", null, "mock", 1);
    expect(plan.tasks).toEqual([]);
    expect(plan.skipped).toEqual(["第 1 集 第 1 场 · 镜 1"]);
    expect(plan.cost.clips).toBe(0);
  });
});

describe("summarizeGeneration", () => {
  it("由任务列表反推条数 / 镜数 / 总时长（同一镜多条只算一镜）", () => {
    const plan = planGeneration(project(), "ep-1", null, "mock", 2);

    expect(summarizeGeneration(plan.tasks)).toEqual({ clips: 4, shots: 2, totalMs: 16_000 });
    expect(summarizeGeneration([])).toEqual({ clips: 0, shots: 0, totalMs: 0 });
  });
});

describe("applyGenerateEvent", () => {
  it("成功事件写回片段产物", () => {
    const subject = task();
    const event: GenerateEvent = {
      taskId: subject.id,
      status: "succeeded",
      clipPath: "clips/001_01.mp4",
      mime: "video/mp4",
    };

    const next = applyGenerateEvent([subject], event);

    expect(next[0].status).toBe("succeeded");
    expect(next[0].result).toEqual({ kind: "clip", path: "clips/001_01.mp4", mime: "video/mp4" });
    expect(next[0].error).toBeNull();

    // 同一事件再写一次：内容没变，任务对象保持同一个引用。
    expect(applyGenerateEvent(next, event)[0]).toBe(next[0]);
  });

  it("成功但没带片段路径时不产生产物（只翻状态）", () => {
    const subject = task();
    const next = applyGenerateEvent([subject], { taskId: subject.id, status: "succeeded" });

    expect(next[0].status).toBe("succeeded");
    expect(next[0].result).toBeNull();
  });

  it("失败事件把错误码与翻译参数一并写回", () => {
    const subject = task();
    const next = applyGenerateEvent([subject], {
      taskId: subject.id,
      status: "failed",
      error: "boom",
      errorCode: "provider",
      errorArgs: { detail: "x" },
    });

    expect(next[0].status).toBe("failed");
    expect(next[0].error).toBe("boom");
    expect(next[0].result).toEqual({ kind: "error", code: "provider", args: { detail: "x" } });
  });

  it("找不到对应任务时返回原引用（任务可能已被删）", () => {
    const list = [task()];
    expect(applyGenerateEvent(list, { taskId: "task-missing", status: "failed" })).toBe(list);
  });
});

describe("任务查询", () => {
  const succeeded = clipTask();
  const failed: Task = {
    ...task(),
    status: "failed",
    result: { kind: "error", code: "auth", args: { detail: "x" } },
    error: "x",
  };
  const running = task({}, "running");
  const otherScene = clipTask({ sceneId: "sc-2", shotId: "shot-3", shotNo: 3 });

  it("tasksForShot 只认同一镜的任务", () => {
    const found = tasksForShot([succeeded, failed, running, otherScene], "ep-1", "sc-1", "shot-1");
    expect(found.map((item) => item.status)).toEqual(["succeeded", "failed", "running"]);
  });

  it("clipCandidates 只收成功产出的片段", () => {
    expect(
      clipCandidates([succeeded, failed, running, otherScene], "ep-1", "sc-1", "shot-1"),
    ).toEqual([{ taskId: succeeded.id, path: "clips/001_01.mp4", mime: "video/mp4" }]);
  });

  it("clipOf / failureOf 各看各的状态", () => {
    expect(clipOf(running)).toBeNull();
    expect(clipOf(succeeded)).toEqual({ path: "clips/001_01.mp4", mime: "video/mp4" });
    expect(failureOf(succeeded)).toBeNull();
    expect(failureOf(failed)).toEqual({ code: "auth", args: { detail: "x" } });
    // 失败态但没记错误码：兜底成 unknown，界面仍能给出可读文案。
    expect(failureOf({ ...task(), status: "failed" })).toEqual({ code: "unknown" });
  });

  it("taskStatusLabel 给全五种状态的中文名", () => {
    expect(taskStatusLabel("queued")).toBe("排队中");
    expect(taskStatusLabel("running")).toBe("生成中");
    expect(taskStatusLabel("succeeded")).toBe("已完成");
    expect(taskStatusLabel("failed")).toBe("失败");
    expect(taskStatusLabel("canceled")).toBe("已取消");
  });
});

describe("任务载荷读写", () => {
  it("videoTaskRequest 只认字段完整的视频任务", () => {
    const subject = task();
    expect(videoTaskRequest(subject)?.shotId).toBe("shot-1");
    expect(videoTaskRequest({ ...subject, kind: "image" })).toBeNull();
    expect(videoTaskRequest({ ...subject, request: { prompt: "只有提示词" } })).toBeNull();
    expect(videoTaskRequest({ ...subject, request: null })).toBeNull();
  });

  it("jobFromTask / jobsFromTasks 只翻译出统一请求体，丢掉非生成任务", () => {
    const subject = task();
    expect(jobFromTask(subject)).toEqual({
      taskId: subject.id,
      shotNo: 1,
      request: { prompt: "推门", params: params(5_000) },
    });
    expect(jobsFromTasks([subject, { ...subject, kind: "image" }])).toHaveLength(1);
  });
});

describe("retryTasks", () => {
  it("只挑失败与已取消的任务，重排成新 id 的排队任务（载荷照搬）", () => {
    const succeeded = clipTask();
    const failed = task({}, "failed");
    const canceled = task({ shotId: "shot-2", shotNo: 2 }, "canceled");
    const queued = task();
    const imageFailed: Task = { ...task({}, "failed"), kind: "image" };

    const retried = retryTasks([succeeded, failed, canceled, queued, imageFailed]);

    expect(retried).toHaveLength(2);
    expect(retried[0].id).not.toBe(failed.id);
    expect(retried[1].id).not.toBe(canceled.id);
    expect(retried.every((item) => item.status === "queued")).toBe(true);
    expect(retried.every((item) => item.result === null && item.error === null)).toBe(true);
    expect(retried.map((item) => item.provider)).toEqual(["mock", "mock"]);
    expect(videoTaskRequest(retried[0])).toEqual(videoTaskRequest(failed));
    expect(videoTaskRequest(retried[1])?.shotNo).toBe(2);
  });
});

describe("中断恢复", () => {
  const closed = clipTask();

  it("interruptedTasks / isOpenTask 认「排队 / 生成中」", () => {
    expect(isOpenTask(task())).toBe(true);
    expect(isOpenTask(task({}, "running"))).toBe(true);
    expect(isOpenTask(closed)).toBe(false);
    expect(interruptedTasks([task(), task({}, "running"), closed])).toHaveLength(2);
  });

  it("markInterrupted 把进行中的任务落成「已中断」，其余原样保留", () => {
    const next = markInterrupted([task(), task({}, "running"), closed]);

    expect(next[0].status).toBe("failed");
    expect(next[0].result).toEqual({ kind: "error", code: "interrupted" });
    expect(next[0].error).toBe("interrupted");
    expect(next[2]).toBe(closed);
  });

  it("没有需要清洗的任务时返回原引用（不制造无意义的脏标记）", () => {
    const list = [closed];
    expect(markInterrupted(list)).toBe(list);
  });
});
