import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { StudioProvider } from "./components/studio-provider";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";
// Radix's trusted dynamic styles use this nonce; scripts retain the existing self-only CSP.
(
  globalThis as typeof globalThis & { __webpack_nonce__?: string }
).__webpack_nonce__ = document.querySelector<HTMLMetaElement>(
  'meta[name="style-nonce"]',
)?.content;
class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("画面の表示に失敗しました", error, info.componentStack);
  }
  render() {
    return this.state.failed ? (
      <main className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">画面を表示できませんでした</h1>
        <p className="my-4">保存済みの下書きと生成履歴は保持されています。</p>
        <button
          type="button"
          className="rounded-lg border px-4 py-2"
          onClick={() => location.reload()}
        >
          再読み込み
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <TooltipProvider>
      <StudioProvider>
        <App />
        <Toaster richColors closeButton position="bottom-right" />
      </StudioProvider>
    </TooltipProvider>
  </ErrorBoundary>,
);
