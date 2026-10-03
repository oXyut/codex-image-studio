import { lazy, Suspense, useState } from "react";
import { Boxes, GitBranch, History, ImagePlus, RefreshCw, Smartphone } from "lucide-react";
import { useStudio } from "@/lib/studio-context";
import { cn } from "@/lib/utils";
import type { View } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { CreateView } from "@/features/create";
import { HistoryView } from "@/features/history";
const LineageView = lazy(() =>
  import("@/features/lineage").then((module) => ({
    default: module.LineageView,
  })),
);

import { TemplatesView } from "@/features/templates";
const nav = [
  { id: "create", label: "制作", icon: ImagePlus },
  { id: "history", label: "履歴", icon: History },
  { id: "lineage", label: "系統図", icon: GitBranch },
  { id: "templates", label: "テンプレート", icon: Boxes },
] as const;
export function App() {
  const studio = useStudio();
  const localConnection = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const [visited, setVisited] = useState<Set<View>>(new Set(["create"]));
  if (!visited.has(studio.view)) setVisited(new Set([...visited, studio.view]));
  const [createRequest, setCreateRequest] = useState<{
    key: number;
    body: string;
  }>();
  return (
    <div className="flex min-h-dvh flex-col md:h-dvh md:min-h-0 md:flex-row">
      <aside className="flex shrink-0 flex-col border-b bg-[#fafafa] md:w-[184px] md:border-b-0 md:border-r lg:w-[208px]">
        <div className="flex min-h-13 items-center gap-2 px-4 py-1 md:flex-col md:items-start md:gap-3 md:px-5 md:py-6">
          <img
            src="/favicon.svg"
            alt=""
            className="size-6 rounded-md md:size-10 md:rounded-lg"
          />
          <div>
            <p className="text-sm font-semibold tracking-tight md:text-base">
              Codex Image Studio
            </p>
            <p className="hidden text-xs text-muted-foreground md:block">ローカル画像制作</p>
          </div>
          {localConnection && (
            <a href="/lan" target="_blank" rel="noopener noreferrer" aria-label="スマホで開く" title="スマホで開く" className="ml-auto flex size-11 items-center justify-center rounded-md hover:bg-accent md:hidden">
              <Smartphone className="size-4" />
            </a>
          )}
        </div>
        <nav
          aria-label="メインナビゲーション"
          className="flex gap-1 overflow-x-auto px-3 pb-1 md:flex-col md:gap-1.5 md:pb-0 md:pt-2"
        >
          {nav.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant="ghost"
              className={cn(
                "h-11 min-w-0 flex-1 justify-center whitespace-nowrap px-1 py-1 text-xs font-normal md:h-10 md:flex-none md:justify-start md:gap-2 md:px-3 md:text-base md:w-full",
                studio.view === id &&
                  "bg-zinc-200/70 font-medium hover:bg-zinc-200",
              )}
              aria-current={studio.view === id ? "page" : undefined}
              onClick={() => studio.navigate(id)}
            >
              <Icon className="hidden size-4 md:block" />
              {label}
            </Button>
          ))}
        </nav>
        {localConnection && (
          <a href="/lan" target="_blank" rel="noopener noreferrer" className="mx-4 mb-3 hidden text-sm underline md:mt-4 md:block">
            スマホで開く
          </a>
        )}
        <div className="mt-auto hidden space-y-4 px-4 py-6 md:block lg:px-5">
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={cn(
                "size-2 rounded-full",
                studio.health?.ready ? "bg-emerald-600" : "bg-amber-500",
              )}
            />
            <span className="whitespace-nowrap">
              ChatGPT {studio.health?.ready ? "接続済み" : "接続確認"}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="ChatGPT接続を再確認"
              onClick={() => void studio.refreshHealth()}
            >
              <RefreshCw />
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            画像と履歴はこのPCに保存されます。
          </p>
          <p className="text-[11px] text-muted-foreground">LOCAL WORKSPACE</p>
        </div>
      </aside>
      <main
        id="main-content"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {studio.loadingError && (
          <div
            role="alert"
            className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-red-50 px-5 py-2 text-sm text-red-900"
          >
            <p>{studio.loadingError} 保存済みの入力は保持しています。</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void studio.refresh()}
            >
              再読み込み
            </Button>
          </div>
        )}
        {([...visited] as View[]).map((view) => (
          <div
            key={view}
            hidden={studio.view !== view}
            className="studio-view min-w-0 flex-1 overflow-y-auto"
          >
            {view === "create" ? (
              <CreateView
                onSaveTemplate={(body) => {
                  setCreateRequest({ key: Date.now(), body });
                  studio.navigate("templates");
                }}
              />
            ) : view === "history" ? (
              <HistoryView />
            ) : view === "lineage" ? (
              <Suspense
                fallback={
                  <p role="status" className="p-8 text-muted-foreground">
                    系統図を読み込み中…
                  </p>
                }
              >
                <LineageView />
              </Suspense>
            ) : (
              <TemplatesView createRequest={createRequest} />
            )}
          </div>
        ))}
      </main>
    </div>
  );
}
