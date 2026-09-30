/**
 * 第 5 步「关键帧」的工作区：集选择 + 逐场逐镜出首/尾帧。
 *
 * 这一步没有左栏聊天，也不调 LLM：关键帧是"把前面几步拍板过的信息落成一张张
 * 可直接喂给图生视频的定稿图"，属于确定性工序。所以整个界面只有三件事可做——
 * 生成候选、挑一张定稿、指定跨镜参考。
 */

import { useState } from "react";
import { refShotOptions, shotKeyframeIssue } from "../../lib/frameOps";
import { useAppStore } from "../../state/store";
import { Select } from "../controls";
import { ShotKeyframeCard } from "./ShotKeyframeCard";

export function KeyframesWorkspace() {
  const project = useAppStore((state) => state.project);
  const [episodeId, setEpisodeId] = useState<string | null>(null);

  if (!project) return <p className="muted">请先新建或打开一个项目。</p>;
  if (project.episodes.length === 0) {
    return <p className="muted">还没有剧集。先回第 2 步写一集、第 4 步拆好镜，再回来出关键帧。</p>;
  }

  const episode = project.episodes.find((item) => item.id === episodeId) ?? project.episodes[0];
  const shotTotal = episode.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);
  const pending = episode.scenes.reduce(
    (sum, scene) => sum + scene.shots.filter((shot) => shotKeyframeIssue(shot)).length,
    0,
  );

  const episodeOptions = project.episodes.map((item) => ({
    value: item.id,
    label: `第 ${item.no} 集${item.title ? ` · ${item.title}` : ""}`,
  }));

  return (
    <div className="workspace">
      <div className="sdbar">
        <Select value={episode.id} options={episodeOptions} onChange={setEpisodeId} />
        <span className="kf-summary">
          本集 {shotTotal} 镜，其中 {pending} 镜首帧还没定稿
        </span>
      </div>

      {shotTotal === 0 ? <p className="muted">本集还没有镜头，先回第 4 步拆镜。</p> : null}

      <div className="kf-cards">
        {episode.scenes.map((scene) => (
          <section className="kf-group" key={scene.id}>
            <div className="scenebar">
              <span className="scenebar__title">
                第 {scene.no} 场{scene.location ? ` · ${scene.location}` : ""}
              </span>
              <span className="scenebar__count">{scene.shots.length} 镜</span>
            </div>

            {scene.shots.map((shot) => (
              <ShotKeyframeCard
                key={shot.id}
                episodeId={episode.id}
                scene={scene}
                shot={shot}
                refOptions={refShotOptions(project, shot.id)}
              />
            ))}
          </section>
        ))}
      </div>

      <p className="sdnote sdnote--hint">
        首帧定稿后，这一镜才算"能生成"。第 6、7 步会把没定稿的镜头标成阻塞。
      </p>
    </div>
  );
}
