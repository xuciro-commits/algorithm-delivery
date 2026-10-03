import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * 单个算法模块出错不应让整个实验室白屏：
 * 边界内显示错误与堆栈要点，顶部仍可切换到其他模块。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[lab] 模块渲染失败', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="panel error-panel">
          <h3>该模块渲染失败</h3>
          <pre>{this.state.error.message}</pre>
          <button type="button" onClick={() => this.setState({ error: null })}>
            重试渲染
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
