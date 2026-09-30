/**
 * 第 7 步「生成」的工作区：选好范围与生成器，批量提交抽卡，再逐镜择优。
 *
 * 这一步不调 LLM，也不手写提示词：提示词在第 6 步已经拼好，这里只做三件事——
 * 提交一批任务、盯着进度、把满意的片段「采用」成这一镜的定稿。
 * 任务与产物都由 Rust 队列推进，界面只是它们的镜子。
 */

import { useEffect, useState } from "react";
import { describeError } from "../../i18n";
import { assetSrc } from "../../lib/assetOps";
import {
  MAX_COPIES,
  clipCandidates,
  failureOf,
  isOpenTask,
  planGeneration,
  taskStatusLabel,
  tasksForShot,
  videoTaskRequest,
} from "../../lib/generateOps";
import { shotSizeLabel } from "../../lib/shotOps";
import type { Project, Scene, Shot, Task } from "../../lib/types";
import { api } from "../../lib/ipc";
import { cancelGeneration, retryGeneration, submitGeneration } from "../../state/generate";
import { useAppStore } from "../../state/store";
import { Select } from "../controls";

const GENERATOR_LABELS: Record<string, string> = {
  kling: "可灵 Kling",
  jimeng: "即梦",
  mock: "本地模拟（无需 Key）",
};

function generatorLabel(name: string): string {
  return GENERATOR_LABELS[name] ?? name;
}

function inScene(task: Task, sceneId: string): boolean {
  const request = videoTaskRequest(task);
  return request !== null && request.sceneId === sceneId;
}

/** 一秒取整，成本摘要只报「条数 × 秒数」，不折算金额。 */
function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

export function GenerateWorkspace() {
  const project = useAppStore((state) => state.project);
  const projectPath = useAppStore((state) => state.projectPath);
  const adoptClip = useAppStore((state) => state.adoptClip);

  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState("");
  const [generator, setGenerator] = useState<string | null>(null);
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState<"submit" | "retry" | null>(null);
  const [generators, setGenerators] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void api
      .listVideoGenerators()
      .then((list) => {
        if (alive) setGenerators(list);
      })
      .catch(() => {
        if (alive) setGenerators([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!project) return <p className="muted">请先新建或打开一个项目。</p>;
  if (project.episodes.length === 0) {
    return <p className="muted">还没有剧集。先回第 2 步写一集、第 6 步出题，再回来生成。</p>;
  }

  const episode = project.episodes.find((item) => item.id === episodeId) ?? project.episodes[0];
  const chosen =
    generator ??
    (generators.includes(project.meta.defaultVideoModel)
      ? project.meta.defaultVideoModel
      : (generators[0] ?? ""));

  const scopeId = sceneId || null;
  const scenes = scopeId ? episode.scenes.filter((scene) => scene.id === scopeId) : episode.scenes;
  const plan = planGeneration(project, episode.id, scopeId, chosen, copies);

  const episodeOptions = project.episodes.map((item) => ({
    value: item.id,
    label: `第 ${item.no} 集${item.title ? ` · ${item.title}` : ""}`,
  }));
  const sceneOptions = [
    { value: "", label: "整集" },
    ...episode.scenes.map((scene) => ({
      value: scene.id,
      label: `第 ${scene.no} 场${scene.location ? ` · ${scene.location}` : ""}`,
    })),
  ];
  const generatorOptions = generators.map((name) => ({
    value: name,
    label: generatorLabel(name),
  }));
  const copyOptions = Array.from({ length: MAX_COPIES }, (_, index) => ({
    value: index + 1,
    label: `每镜 ${index + 1} 条`,
  }));

  const submit = async (): Promise<void> => {
    if (!chosen) return;
    setBusy("submit");
    try {
      await submitGeneration(episode.id, scopeId, chosen, copies);
    } finally {
      setBusy(null);
    }
  };

  const retryScene = async (target: string): Promise<void> => {
    setBusy("retry");
    try {
      await retryGeneration(episode.id, target);
    } finally {
      setBusy(null);
    }
  };

  const cancelTasks = (tasks: Task[]): void => {
    void cancelGeneration(tasks.map((task) => task.id));
  };

  return (
    <div className="workspace">
      <div className="sdbar">
        <Select value={episode.id} options={episodeOptions} onChange={setEpisodeId} />
        <Select value={sceneId} options={sceneOptions} onChange={setSceneId} />
        <Select value={chosen} options={generatorOptions} onChange={setGenerator} />
        <Select value={copies} options={copyOptions} onChange={setCopies} />
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy !== null || !chosen || plan.tasks.length === 0}
          onClick={() => void submit()}
        >
          {busy === "submit" ? "生成中…" : "开始生成"}
        </button>
      </div>

      <p className="sdnote sdnote--hint" data-testid="gen-cost">
        本次将提交 {plan.cost.clips} 条（{plan.cost.shots} 镜 × 每镜 {copies} 条）， 合计约{" "}
        {seconds(plan.cost.totalMs)} 秒素材。
        {plan.skipped.length > 0 ? ` 有 ${plan.skipped.length} 镜还没出题，先回第 6 步补齐。` : ""}
      </p>

      {plan.skipped.length > 0 ? (
        <ul className="gen-issues" data-testid="gen-skipped">
          {plan.skipped.slice(0, 5).map((label) => (
            <li key={label}>未出题：{label}</li>
          ))}
        </ul>
      ) : null}

      <div className="prompt-cards">
        {scenes.map((scene) => (
          <SceneGroup
            key={scene.id}
            project={project}
            projectPath={projectPath}
            episodeId={episode.id}
            scene={scene}
            busy={busy !== null}
            onAdopt={(shotId, clipId) => adoptClip(episode.id, scene.id, shotId, clipId)}
            onCancel={cancelTasks}
            onRetry={() => void retryScene(scene.id)}
          />
        ))}
      </div>

      <p className="sdnote sdnote--hint">
        同一条任务只会产出一个片段；同一镜可以多提交几条挑一条。采用后这一镜才算"有画面"。
      </p>
    </div>
  );
}

interface SceneGroupProps {
  project: Project;
  projectPath: string | null;
  episodeId: string;
  scene: Scene;
  busy: boolean;
  onAdopt: (shotId: string, clipId: string | null) => void;
  onCancel: (tasks: Task[]) => void;
  onRetry: () => void;
}

function SceneGroup({
  project,
  projectPath,
  episodeId,
  scene,
  busy,
  onAdopt,
  onCancel,
  onRetry,
}: SceneGroupProps) {
  const sceneTasks = project.tasks.filter((task) => inScene(task, scene.id));
  const open = sceneTasks.filter(isOpenTask);
  const retryable = sceneTasks.filter(
    (task) => task.status === "failed" || task.status === "canceled",
  );
  const interrupted = retryable.filter((task) => failureOf(task)?.code === "interrupted").length;

  return (
    <section className="prompt-group">
      <div className="scenebar">
        <span className="scenebar__title">
          第 {scene.no} 场{scene.location ? ` · ${scene.location}` : ""}
        </span>
        <span className="scenebar__count">{scene.shots.length} 镜</span>
        <button
          type="button"
          className="link-btn"
          disabled={open.length === 0}
          onClick={() => onCancel(open)}
        >
          取消本场在跑（{open.length}）
        </button>
        <button
          type="button"
          className="link-btn"
          disabled={busy || retryable.length === 0}
          onClick={onRetry}
        >
          {busy ? "重试中…" : `重试失败（${retryable.length}）`}
        </button>
      </div>

      {interrupted > 0 ? (
        <p className="sdnote sdnote--error" data-testid="gen-interrupted">
          本场有 {interrupted} 条任务上次没跑完就中断了，点「重试失败」可以重来。
        </p>
      ) : null}

      {scene.shots.map((shot) => (
        <ShotGenerateCard
          key={shot.id}
          project={project}
          projectPath={projectPath}
          episodeId={episodeId}
          sceneId={scene.id}
          shot={shot}
          onAdopt={onAdopt}
          onCancel={onCancel}
        />
      ))}
    </section>
  );
}

interface ShotGenerateCardProps {
  project: Project;
  projectPath: string | null;
  episodeId: string;
  sceneId: string;
  shot: Shot;
  onAdopt: (shotId: string, clipId: string | null) => void;
  onCancel: (tasks: Task[]) => void;
}

function ShotGenerateCard({
  project,
  projectPath,
  episodeId,
  sceneId,
  shot,
  onAdopt,
  onCancel,
}: ShotGenerateCardProps) {
  const tasks = tasksForShot(project.tasks, episodeId, sceneId, shot.id);
  const candidates = clipCandidates(project.tasks, episodeId, sceneId, shot.id);
  const pending = tasks.filter((task) => !isOpenTask(task) && task.status !== "succeeded");
  const open = tasks.filter(isOpenTask);

  return (
    <article className="kf-card" data-testid="gen-card">
      <header className="kf-card__head">
        <span className="kf-card__no">第 {shot.no} 镜</span>
        <span className="kf-card__meta">
          {shotSizeLabel(shot.shotSize)} · {seconds(shot.durationMs)} 秒
        </span>
        {shot.adoptedClipId ? (
          <span className="prompt-card__flag">已采用</span>
        ) : (
          <span className="prompt-card__flag--todo">
            {candidates.length > 0 ? "待择优" : "还没产物"}
          </span>
        )}
        <span className="prompt-card__count">
          {open.length > 0 ? `${open.length} 条进行中` : `${candidates.length} 条候选`}
        </span>
      </header>

      {!shot.promptBundle ? (
        <p className="muted kf-card__desc">
          这一镜还没出题，先回第 6 步点「出题」，这里才有提示词可提交。
        </p>
      ) : null}

      {candidates.length === 0 ? (
        <p className="muted kf-card__desc">还没有可用片段。</p>
      ) : (
        <div className="thumbs">
          {candidates.map((candidate, index) => (
            <figure className="thumb" key={candidate.taskId}>
              {candidate.mime.startsWith("video/") ? (
                <video
                  className="thumb__video"
                  src={assetSrc(projectPath, candidate.path)}
                  controls
                  muted
                  loop
                  preload="metadata"
                />
              ) : (
                <img
                  className="thumb__img"
                  src={assetSrc(projectPath, candidate.path)}
                  alt={`第 ${shot.no} 镜候选 ${index + 1}`}
                />
              )}
              <figcaption className="thumb__bar">
                {candidate.mime.startsWith("video/") ? null : (
                  <span className="thumb__note">模拟产物</span>
                )}
                {shot.adoptedClipId === candidate.taskId ? (
                  <>
                    <span className="thumb__flag">已采用</span>
                    <button
                      type="button"
                      className="thumb__btn"
                      onClick={() => onAdopt(shot.id, null)}
                    >
                      取消采用
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="thumb__btn"
                    title="把这条片段定为这一镜的画面"
                    onClick={() => onAdopt(shot.id, candidate.taskId)}
                  >
                    采用
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {open.length > 0 ? (
        <div className="export-row">
          <span className="export-row__label">进行中</span>
          <span className="muted">
            {open.map((task) => taskStatusLabel(task.status)).join("、")}
          </span>
          <button type="button" className="link-btn" onClick={() => onCancel(open)}>
            取消
          </button>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <ul className="gen-tasks" data-testid="gen-failures">
          {pending.map((task) => {
            const reason = failureOf(task);
            return (
              <li className="gen-task" key={task.id}>
                <span className="gen-task__label">{taskStatusLabel(task.status)}</span>
                <span className="muted">
                  {reason
                    ? describeError({
                        code: reason.code,
                        message: task.error ?? "",
                        args: reason.args,
                      })
                    : ""}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}
