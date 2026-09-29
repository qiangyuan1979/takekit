/**
 * 渲染异常兜底：任一环节抛错都不能把整个应用变成白屏。
 *
 * 只包住右栏内容区，顶栏与步骤条仍可用，用户能切到别的环节继续。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 出错时的提示语，默认通用文案。 */
  title?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[TakeKit] 渲染异常", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <p className="crash__title">{this.props.title ?? "这个环节出了点问题"}</p>
        <p className="crash__detail">{error.message}</p>
        <button type="button" className="btn" onClick={this.reset}>
          重试
        </button>
      </div>
    );
  }
}
