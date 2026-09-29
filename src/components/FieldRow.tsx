/**
 * 表单行：标签 + 「为什么这么设」+ 控件。
 *
 * 新手向的关键是那句 why——没有它，字段就成了需要先读文档才能填的必答题。
 * 控件由调用方以渲染函数传入，保持本组件对输入类型无感。
 */

import type { ReactNode } from "react";

export interface FieldRowProps {
  label: string;
  /** 一句话说明这个字段影响下游什么。 */
  why: string;
  /** 值的来源（如"继承自卡1"），显示为右侧小字。 */
  source?: string;
  children: ReactNode;
}

export function FieldRow({ label, why, source, children }: FieldRowProps) {
  return (
    <div className="field">
      <div className="field__meta">
        <label className="field__label">{label}</label>
        {source ? <span className="field__source">{source}</span> : null}
        <p className="field__why">{why}</p>
      </div>
      <div className="field__control">{children}</div>
    </div>
  );
}
