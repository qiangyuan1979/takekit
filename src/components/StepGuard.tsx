/**
 * 步骤守卫提示：把"还不能进下一步"翻译成一份可勾选的待办。
 *
 * 只在未通过时渲染，且不阻止用户查看当前环节——挡住前进的路，
 * 而不是挡住学习。
 */

import type { GuardResult } from "../state/steps";

export interface StepGuardProps {
  result: GuardResult;
}

export function StepGuard({ result }: StepGuardProps) {
  if (result.ok) return null;
  return (
    <div className="guard" role="status">
      <p className="guard__title">还差这些才能进入下一步：</p>
      <ul className="guard__list">
        {result.issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}
