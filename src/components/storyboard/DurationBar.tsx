/**
 * 单集时长条：把"这一集所有镜头加起来多久 / 单集预算多久"一眼说清。
 *
 * 分镜这一步最容易犯的错就是把时长排超，所以超标时不只是变红，
 * 还要直接给出下一步动作（删镜或压时长），不让新手自己换算。
 */

import { compareDuration, episodeDurationMs, formatDuration } from "../../lib/shotOps";
import type { Episode } from "../../lib/types";

export function DurationBar({ episode, limitMs }: { episode: Episode; limitMs: number }) {
  const totalMs = episodeDurationMs(episode);

  if (totalMs === 0) {
    return (
      <div className="dbar">
        <p className="dbar__empty">本集还没拆镜，先按场拆出镜头。</p>
      </div>
    );
  }

  const comparison = compareDuration(totalMs, limitMs);
  // 留 4% 最小可见宽度，否则一个很短的镜头在条上完全看不见。
  const width = Math.min(100, Math.max(4, comparison.ratio * 100));

  return (
    <div className="dbar" data-over={comparison.over ? "true" : undefined}>
      <div className="dbar__track">
        <div className="dbar__fill" style={{ width: `${width}%` }} />
      </div>
      <p className="dbar__text">
        本集分镜 {formatDuration(comparison.totalMs)} / 单集 {formatDuration(comparison.limitMs)}
        {comparison.over
          ? ` · 超出 ${formatDuration(comparison.deltaMs)}，删镜或压时长`
          : " · 时长在预算内"}
      </p>
    </div>
  );
}
