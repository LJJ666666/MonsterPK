import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import PixelButton from "@/components/PixelButton";

type Props = { children: ReactNode };
type State = { failed: boolean; message: string };

/**
 * 把任意抛出值归一成可展示的短文案。
 * 界面只展示这一小段，绝不把完整堆栈 / 内部路径渲染到页面上；全量信息留给控制台。
 */
export function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 200);
  if (typeof error === "string" && error) return error.slice(0, 200);
  return "未知错误";
}

/**
 * 应用级错误边界（A4）。
 *
 * 包在 <App /> 外层：路由 / 页面组件任一处渲染期抛错时，用一张符合
 * .impeccable.md 的手记风兜底页替换整棵子树，避免 WebView 白屏。
 * 存档真值在服务端，兜底页不写任何本地状态，刷新即可重新拉取。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: "" };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, message: normalizeError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台保留完整堆栈与组件链，便于用 requestId 与服务端日志对齐。
    console.error("[兽域手记] 渲染异常", error, info?.componentStack);
  }

  /** 不刷新页面，直接重挂一次子树；适合偶发的一次性渲染异常。 */
  private retry = () => {
    this.setState({ failed: false, message: "" });
  };

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-[color:var(--bg)] p-4">
        <div className="max-h-[85vh] w-full max-w-sm overflow-auto border-2 border-[color:var(--stroke)] bg-[color:var(--panel)] p-5 text-center">
          <svg
            viewBox="0 0 48 48"
            className="mx-auto h-12 w-12 text-[color:var(--accent)]"
            fill="none"
            aria-hidden="true"
          >
            <path d="M8 6h26l6 6v30H8z" stroke="currentColor" strokeWidth="2" />
            <path d="M34 6v6h6" stroke="currentColor" strokeWidth="2" />
            <path
              d="M16 19l7 6-5 5 7-2 6 5-5-9 4-6-7 2z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
          <h1 className="mt-4 font-display text-base leading-relaxed text-[color:var(--accent)]">
            手记出了点问题
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-[color:var(--text)]">
            这一页渲染时出了意外。进度保存在服务端，不会丢失，重新加载即可继续冒险。
          </p>
          <p className="mt-3 break-words text-xs leading-relaxed text-[color:var(--muted)]">
            {this.state.message}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <PixelButton tone="primary" onClick={() => window.location.reload()}>
              重新加载
            </PixelButton>
            <PixelButton tone="muted" onClick={this.retry}>
              重试渲染
            </PixelButton>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-[color:var(--muted)]">
            如果反复出现，请把上面的信息发给开发者。
          </p>
        </div>
      </div>
    );
  }
}
