/**
 * 第 4 步「分镜」的工作区：集选择 + 时长条 + 每场一条操作带 + 双视图主体。
 *
 * 为什么本步不放左栏聊天：拆镜的输入是「这一场」而非一段自由对话，
 * 逐场给一个「AI 拆镜」按钮、结果直接落进该场，比来回聊天更贴近新手。
 * 没有 LLM Key 时按钮不可点，但「离线拆镜」永远可用——流程不因缺 Key 中断。
 */

import { useState } from "react";
import { describeError } from "../../i18n";
import { toApiError } from "../../lib/ipc";
import { episodeShotCount, makeShot } from "../../lib/shotOps";
import {
  cameraSequenceFrom,
  shotSeedsFrom,
  shotSeedsPayload,
  type ShotSeed,
} from "../../lib/templateOps";
import type { CameraMove } from "../../lib/types";
import { useAppStore } from "../../state/store";
import {
  runShotAi,
  splitEpisodeOffline,
  splitSceneOffline,
  type SplitOptions,
} from "../../state/storyboard";
import { Select } from "../controls";
import { TemplatePicker } from "../TemplatePicker";
import { DurationBar } from "./DurationBar";
import { ShotCardView } from "./ShotCardView";
import { ShotTableView } from "./ShotTableView";

type ViewMode = "table" | "card";

interface Status {
  kind: "ok" | "error" | "busy";
  text: string;
}

export function StoryboardWorkspace() {
  const project = useAppStore((state) => state.project);
  const hasKey = useAppStore((state) => state.settings.llm.apiKey.trim().length > 0);
  const setSceneShots = useAppStore((state) => state.setSceneShots);

  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("table");
  const [busyScene, setBusyScene] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  if (!project) return <p className="muted">请先新建或打开一个项目。</p>;
  if (project.episodes.length === 0) {
    return <p className="muted">还没有剧集。先回第 2 步写一集，再回来拆镜。</p>;
  }

  const episode = project.episodes.find((item) => item.id === episodeId) ?? project.episodes[0];
  const characters = project.assets.characters;
  const busy = busyScene !== null;

  const episodeOptions = project.episodes.map((item) => ({
    value: item.id,
    label: `第 ${item.no} 集${item.title ? ` · ${item.title}` : ""}`,
  }));

  const runOffline = (options: SplitOptions): void => {
    try {
      const count = splitEpisodeOffline(episode.id, options);
      setStatus({ kind: "ok", text: `已按场拆出 ${count} 个镜头，接下来逐场微调。` });
    } catch (error) {
      setStatus({ kind: "error", text: describeError(toApiError(error)) });
    }
  };

  const splitScene = (sceneId: string): void => {
    try {
      const count = splitSceneOffline(episode.id, sceneId);
      setStatus({ kind: "ok", text: `这一场拆出 ${count} 个镜头。` });
    } catch (error) {
      setStatus({ kind: "error", text: describeError(toApiError(error)) });
    }
  };

  const clearScene = (sceneId: string): void => {
    setSceneShots(episode.id, sceneId, []);
    setStatus({ kind: "ok", text: "已清空这一场的镜头。" });
  };

  /** 分镜模板：追加而非覆盖，套错了删掉即可，不会毁掉已有镜头。 */
  const appendShots = (sceneId: string, seeds: ShotSeed[]): void => {
    const scene = episode.scenes.find((item) => item.id === sceneId);
    if (!scene || seeds.length === 0) return;
    const added = seeds.map((seed) => makeShot({ ...seed, episodeId: episode.id, sceneId }));
    setSceneShots(episode.id, sceneId, [...scene.shots, ...added]);
    setStatus({ kind: "ok", text: `已套用分镜模板，追加 ${added.length} 个镜头。` });
  };

  /** 运镜模板：只有序列、不删镜头，按序循环套到本场每一镜。 */
  const applyCamera = (sceneId: string, moves: CameraMove[]): void => {
    const scene = episode.scenes.find((item) => item.id === sceneId);
    if (!scene || moves.length === 0) return;
    setSceneShots(
      episode.id,
      sceneId,
      scene.shots.map((shot, index) => ({ ...shot, cameraMove: moves[index % moves.length] })),
    );
    setStatus({ kind: "ok", text: `已套用运镜模板（${moves.length} 个运镜循环使用）。` });
  };

  const aiScene = async (sceneId: string): Promise<void> => {
    if (busy) return;
    setBusyScene(sceneId);
    let received = 0;
    setStatus({ kind: "busy", text: "模型正在拆镜…（已收到 0 字）" });
    try {
      const count = await runShotAi({
        episodeId: episode.id,
        sceneId,
        onDelta: (delta) => {
          received += delta.length;
          setStatus({ kind: "busy", text: `模型正在拆镜…（已收到 ${received} 字）` });
        },
      });
      setStatus({ kind: "ok", text: `AI 拆出 ${count} 个镜头，已写进这一场。` });
    } catch (error) {
      setStatus({ kind: "error", text: describeError(toApiError(error)) });
    } finally {
      setBusyScene(null);
    }
  };

  return (
    <div className="workspace">
      <div className="sdbar">
        <Select
          value={episode.id}
          options={episodeOptions}
          onChange={(next) => {
            setEpisodeId(next);
            setStatus(null);
          }}
        />
        <div className="sdbar__views">
          <button
            type="button"
            className="icon-btn"
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
          >
            表格
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-pressed={view === "card"}
            onClick={() => setView("card")}
          >
            卡片
          </button>
        </div>
        <DurationBar episode={episode} limitMs={project.meta.episodeDurationMs} />
        <button
          type="button"
          className="btn"
          title="按「一场一镜 + 一句台词一镜」的规则先拆一版，离线可用"
          onClick={() => runOffline({})}
        >
          离线拆镜本集
        </button>
      </div>

      {status ? (
        <p
          className={`sdnote sdnote--${status.kind}`}
          role={status.kind === "error" ? "alert" : undefined}
        >
          {status.text}
        </p>
      ) : null}

      <div className="sdscenes">
        {episode.scenes.map((scene) => (
          <div className="scenebar" key={scene.id}>
            <span className="scenebar__title">
              第 {scene.no} 场{scene.location ? ` · ${scene.location}` : ""}
            </span>
            <span className="scenebar__count">{scene.shots.length} 镜</span>
            <div className="scenebar__actions">
              <details className="scenebar__tpl">
                <summary className="icon-btn" title="把模板套到这一场">
                  套模板
                </summary>
                <div className="scenebar__tplbox">
                  <TemplatePicker
                    kind="storyboard"
                    label="套用分镜骨架（追加镜头）"
                    onApply={(payload) => appendShots(scene.id, shotSeedsFrom(payload))}
                    capture={() => (scene.shots.length > 0 ? shotSeedsPayload(scene.shots) : null)}
                  />
                  <TemplatePicker
                    kind="camera"
                    label="套用运镜序列（按序循环）"
                    onApply={(payload) => applyCamera(scene.id, cameraSequenceFrom(payload))}
                    capture={() =>
                      scene.shots.length > 0
                        ? { moves: scene.shots.map((shot) => shot.cameraMove) }
                        : null
                    }
                  />
                </div>
              </details>
              <button
                type="button"
                className="icon-btn"
                disabled={!hasKey || busy}
                title={hasKey ? "让模型把这一场拆成镜头" : "先在顶栏「设置」里填 LLM 的 API Key"}
                onClick={() => void aiScene(scene.id)}
              >
                {scene.shots.length > 0 ? `重新拆镜（覆盖 ${scene.shots.length} 镜）` : "AI 拆镜"}
              </button>
              <button
                type="button"
                className="icon-btn"
                title="按规则把这一场拆成镜头"
                onClick={() => splitScene(scene.id)}
              >
                离线拆镜
              </button>
              {scene.shots.length > 0 ? (
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  title="清空这一场的镜头"
                  onClick={() => clearScene(scene.id)}
                >
                  清空
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="sdbody">
        {view === "table" ? (
          <ShotTableView key={episode.id} episode={episode} characters={characters} />
        ) : (
          <ShotCardView key={episode.id} episode={episode} characters={characters} />
        )}
      </div>

      <p className="sdnote sdnote--hint">
        本集共 {episodeShotCount(episode)}{" "}
        镜。景别与运镜只能下拉选择，避免自由文本导致下游模型理解偏差。
      </p>
    </div>
  );
}
