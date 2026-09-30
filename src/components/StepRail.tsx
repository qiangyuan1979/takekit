/**
 * 左侧 8 步步骤条。
 *
 * 「已完成」不是用户手动勾的，而是由 `checkStep` 推导：只要该环节的守卫通过
 * 就显示为完成。这样状态永远和数据一致，不会出现"勾了但没填"的假进度。
 */

import { STEPS, checkStep, type StepId } from "../state/steps";
import { pendingKeyframeIssues } from "../lib/frameOps";
import type { Project } from "../lib/types";

export interface StepRailProps {
  current: StepId;
  project: Project | null;
  onSelect: (step: StepId) => void;
}

export function StepRail({ current, project, onSelect }: StepRailProps) {
  // 首帧未定稿的镜头会卡住第 5 步之后的所有环节，所以在步骤条上一次性标出来。
  // 只标 5 及以后：前面几步已经在做各自的事，挂个"关键帧没做完"的警告只会添乱。
  const keyframeBlocked = project ? pendingKeyframeIssues(project).length > 0 : false;
  return (
    <nav className="rail" aria-label="制作流程">
      <ol className="rail__list">
        {STEPS.map((step) => {
          const isCurrent = step.id === current;
          const passed = step.ready && checkStep(step.id, project).ok;
          const warn = keyframeBlocked && step.no >= 5 && !step.disabled;
          const state = step.disabled
            ? "disabled"
            : isCurrent
              ? "active"
              : passed
                ? "done"
                : "idle";
          return (
            <li key={step.id} className={`rail__item rail__item--${state}`}>
              <button
                type="button"
                className="rail__button"
                aria-current={isCurrent ? "step" : undefined}
                disabled={step.disabled}
                onClick={() => onSelect(step.id)}
              >
                <span className="rail__no">{passed && !isCurrent ? "✓" : step.no}</span>
                <span className="rail__label">{step.label}</span>
                {!step.ready ? <span className="rail__badge">待开发</span> : null}
                {warn ? (
                  <span className="rail__warn" title="有镜头的首帧还没定稿，会阻塞后面的出题与生成">
                    !
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
