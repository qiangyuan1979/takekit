/**
 * 左侧 8 步步骤条。
 *
 * 「已完成」不是用户手动勾的，而是由 `checkStep` 推导：只要该环节的守卫通过
 * 就显示为完成。这样状态永远和数据一致，不会出现"勾了但没填"的假进度。
 */

import { STEPS, checkStep, type StepId } from "../state/steps";
import type { Project } from "../lib/types";

export interface StepRailProps {
  current: StepId;
  project: Project | null;
  onSelect: (step: StepId) => void;
}

export function StepRail({ current, project, onSelect }: StepRailProps) {
  return (
    <nav className="rail" aria-label="制作流程">
      <ol className="rail__list">
        {STEPS.map((step) => {
          const isCurrent = step.id === current;
          const passed = step.ready && checkStep(step.id, project).ok;
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
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
