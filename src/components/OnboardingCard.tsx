/**
 * 新手引导卡：进入每一步时在内容区顶部给一屏"这步干什么 / 常见错误 / 示例"。
 *
 * 纯展示组件——跳过与否由外壳（AppShell）决定并持有状态，这里只负责把
 * 当前步骤的三段文案摆出来。要改文案请改 `state/steps.ts` 的 STEPS。
 */

import type { StepDef } from "../state/steps";

export interface OnboardingCardProps {
  step: StepDef;
  /** 跳过本步引导（仅隐藏当前这一步，不影响设置里的全局开关）。 */
  onSkip: () => void;
}

const ROWS: readonly { key: "goal" | "tip" | "example"; label: string }[] = [
  { key: "goal", label: "这步干什么" },
  { key: "tip", label: "常见错误" },
  { key: "example", label: "示例" },
];

export function OnboardingCard({ step, onSkip }: OnboardingCardProps) {
  return (
    <section className="onboard" aria-label={`第 ${step.no} 步新手引导`}>
      <div className="onboard__head">
        <span className="onboard__badge">新手引导</span>
        <span className="onboard__step">
          第 {step.no} 步 · {step.label}
        </span>
        <button type="button" className="onboard__skip" onClick={onSkip}>
          跳过
        </button>
      </div>
      <dl className="onboard__rows">
        {ROWS.map((row) => (
          <div className="onboard__row" key={row.key}>
            <dt className="onboard__label">{row.label}</dt>
            <dd className="onboard__text">{step[row.key]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
