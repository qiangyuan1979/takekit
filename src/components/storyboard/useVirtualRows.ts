/**
 * 表格视图的虚拟滚动：给一个滚动容器 ref 和总行数，算出该渲染哪一段。
 *
 * 分镜动辄两三百行，全量渲染会让编辑时的每次按键都卡一下；
 * 这里只保留视口内（外加少量 overscan）的行，行高固定所以偏移可以直接算。
 * jsdom 里 `clientHeight` 是 0、也没有 `ResizeObserver`，所以有一个兜底视口高度，
 * 让这套逻辑在测试里也能跑。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type UIEvent,
} from "react";

/** 量不到容器高度时（首帧 / 测试环境）用的视口高度。 */
const FALLBACK_VIEWPORT = 480;

export interface VirtualRows {
  /** 挂到滚动容器上。 */
  ref: RefObject<HTMLDivElement | null>;
  /** 要渲染的区间 `[start, end)`。 */
  start: number;
  end: number;
  /** 撑开滚动条用的总高度。 */
  totalHeight: number;
  /** 已渲染那一段相对顶部的偏移。 */
  offsetY: number;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
}

export function useVirtualRows(count: number, rowHeight: number, overscan = 4): VirtualRows {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void => setViewport(element.clientHeight || FALLBACK_VIEWPORT);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const { start, end } = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visible = Math.ceil(viewport / rowHeight) + overscan * 2;
    return { start: first, end: Math.min(count, first + visible) };
  }, [count, overscan, rowHeight, scrollTop, viewport]);

  return {
    ref,
    start,
    end,
    totalHeight: count * rowHeight,
    offsetY: start * rowHeight,
    onScroll,
  };
}
