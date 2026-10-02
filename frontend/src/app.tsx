import { lazy, Suspense, useState } from "react";
import { Boxes, GitBranch, History, ImagePlus, RefreshCw } from "lucide-react";
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
  const [visited, setVisited] = useState<Set<View>>(new Set(["create"]));
  if (!visited.has(studio.view)) setVisited(new Set([...visited, studio.view]));
  const [createRequest, setCreateRequest] = useState<{
    key: number;
    body: string;
  }>();
  return (
    <div className="flex min-h-dvh flex-col md:h-dvh md:min-h-0 md:flex-row">
      <aside className="flex shrink-0 flex-col border-b bg-[#fafafa] md:w-[208px] md:border-b-0 md:border-r lg:w-[224px]">
        <div className="flex items-center gap-3 p-4 md:flex-col md:items-start md:px-5 md:py-6">
          <img
            src="/favicon.svg"
            alt=""
            className="size-9 rounded-lg md:size-10"
          />
          <div>
            <p className="text-base font-semibold tracking-tight">
              Codex Image Studio
            </p>
            <p className="text-xs text-muted-foreground">ローカル画像制作</p>
          </div>
        </div>
        <nav
          aria-label="メインナビゲーション"
          className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:gap-1.5 md:pb-0 md:pt-2"
        >
          {nav.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant="ghost"
              className={cn(
                "h-16 min-w-0 flex-1 flex-col justify-center gap-1 whitespace-normal px-2 py-1 text-xs leading-tight font-normal md:h-11 md:flex-none md:flex-row md:justify-start md:gap-2 md:whitespace-nowrap md:px-3 md:text-base md:w-full",
                studio.view === id &&
                  "bg-zinc-200/70 font-medium hover:bg-zinc-200",
              )}
              aria-current={studio.view === id ? "page" : undefined}
              onClick={() => studio.navigate(id)}
            >
              <Icon className="size-4" />
              {label}
            </Button>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-4 px-5 py-6 md:block">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "size-2 rounded-full",
                studio.health?.ready ? "bg-emerald-600" : "bg-amber-500",
              )}
            />
            <span>
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
