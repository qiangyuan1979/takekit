/**
 * 关键帧 · 一镜一张卡：首帧（必需）在下，尾帧（可选）在上。
 *
 * 顺序刻意让首帧在前——它是门禁唯一在意的产物；尾帧缺了不阻塞下游，
 * 所以排在后面，避免新手以为两面帧都必须出满。
 */

import { shotKeyframeIssue, type RefShotOption } from "../../lib/frameOps";
import { shotSizeLabel } from "../../lib/shotOps";
import type { Scene, Shot } from "../../lib/types";
import { FrameStrip } from "./FrameStrip";

export interface ShotKeyframeCardProps {
  episodeId: string;
  scene: Scene;
  shot: Shot;
  /** 除本镜外、已有定稿帧的镜头。 */
  refOptions: RefShotOption[];
}

export function ShotKeyframeCard({ episodeId, scene, shot, refOptions }: ShotKeyframeCardProps) {
  const issue = shotKeyframeIssue(shot);

  return (
    <article className="kf-card" data-testid="kf-card">
      <header className="kf-card__head">
        <span className="kf-card__no">第 {shot.no} 镜</span>
        <span className="kf-card__meta">
          {shotSizeLabel(shot.shotSize)} · {Math.round(shot.durationMs / 1000)} 秒
        </span>
        {issue ? <span className="kf-card__issue">{issue}</span> : null}
      </header>

      {shot.visualDesc.trim() ? (
        <p className="kf-card__desc">{shot.visualDesc.trim()}</p>
      ) : (
        <p className="muted kf-card__desc">
          这一镜还没写画面描述，先回第 4 步补一句，出图会准很多。
        </p>
      )}

      <div className="kf-card__frames">
        <FrameStrip
          episodeId={episodeId}
          sceneId={scene.id}
          shot={shot}
          role="first"
          refOptions={refOptions}
        />
        <FrameStrip
          episodeId={episodeId}
          sceneId={scene.id}
          shot={shot}
          role="last"
          refOptions={refOptions}
        />
      </div>
    </article>
  );
}
