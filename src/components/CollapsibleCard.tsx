/**
 * 立项页的一张"卡"：标题 + 一句话说明 + 可折叠正文。
 *
 * 折叠状态由本组件自己持有（不落盘）：它是纯粹的阅读偏好，
 * 不属于项目数据，刷新后回到默认展开即可。
 */

import { useState, type ReactNode } from "react";

export interface CollapsibleCardProps {
  /** 卡号，如「卡1」，显示在标题左侧。 */
  step?: string;
  title: string;
  /** 一句话讲清"这卡填了有什么用"。 */
  hint: string;
  children: ReactNode;
  /** 默认是否展开。 */
  defaultOpen?: boolean;
}

export function CollapsibleCard({
  step,
  title,
  hint,
  children,
  defaultOpen = true,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`card${open ? "" : " card--collapsed"}`}>
      <button
        type="button"
        className="card__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="card__chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="card__title">
          {step ? <span className="card__step">{step}</span> : null}
          {title}
        </span>
        <span className="card__hint">{hint}</span>
      </button>
      {open ? <div className="card__body">{children}</div> : null}
    </section>
  );
}
