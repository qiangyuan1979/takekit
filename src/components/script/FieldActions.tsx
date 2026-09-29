/**
 * 字段旁的三个 AI 动作按钮（生成 / 续写 / 重写）+ 可选的字段锁。
 *
 * 只在有 API Key 且不忙碌时可点：宁可让按钮灰着并说明原因，
 * 也不要让新手点了没反应。
 */

import type { AiAction, ScriptScope } from "../../lib/llmPrompts";
import { useAiChat } from "../../state/aiChat";
import { useAppStore } from "../../state/store";

const ACTIONS: readonly { action: AiAction; label: string; hint: string }[] = [
  { action: "generate", label: "生成", hint: "按现在的设定从零写一版" },
  { action: "continue", label: "续写", hint: "保留已经写好的部分，只补没写完的地方" },
  { action: "rewrite", label: "重写", hint: "按结构模板调整节奏，不新增设定" },
];

export interface FieldActionsProps {
  scope: ScriptScope;
  /** 传了就显示锁按钮；锁定后三个动作都不可点。 */
  lock?: { field: string; locked: boolean };
}

export function FieldActions({ scope, lock }: FieldActionsProps) {
  const busy = useAiChat((state) => state.busy);
  const run = useAiChat((state) => state.run);
  const toggleFieldLock = useAppStore((state) => state.toggleFieldLock);
  const hasKey = useAppStore((state) => state.settings.llm.apiKey.trim().length > 0);

  const locked = lock?.locked === true;
  const disabled = busy || !hasKey || locked;
  const reason = !hasKey ? "先在顶栏「设置」里填 LLM 的 API Key" : locked ? "该字段已锁定" : "";

  return (
    <div className="field__actions">
      {lock ? (
        <button
          type="button"
          className={`icon-btn${locked ? " icon-btn--on" : ""}`}
          aria-pressed={locked}
          title={locked ? "已锁定：AI 不会覆盖这个字段" : "锁定后 AI 不会覆盖这个字段"}
          onClick={() => toggleFieldLock(lock.field)}
        >
          {locked ? "已锁定" : "锁定"}
        </button>
      ) : null}
      {ACTIONS.map((item) => (
        <button
          key={item.action}
          type="button"
          className="icon-btn"
          title={disabled ? reason : item.hint}
          disabled={disabled}
          onClick={() => void run(item.action, scope)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
