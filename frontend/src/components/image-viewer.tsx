import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelRight, X } from "lucide-react";
import { useStudio } from "@/lib/studio-context";
import { dateLabel, imageTitle } from "@/lib/format";
import type { ImageSource } from "@/lib/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { ImageActions } from "./image-actions";
import { ImageInspector } from "./image-inspector";
import { ImageViewport } from "./image-viewport";

const detailsPreferenceKey = "codex-image-studio.viewer-details";
const wideLayoutQuery = "(min-width: 1024px)";

function loadDetailsPreference(): boolean | null {
  try {
    const saved = localStorage.getItem(detailsPreferenceKey);
    return saved === "true" ? true : saved === "false" ? false : null;
  } catch {
    return null;
  }
}

export function ImageViewer({
  source,
  previous,
  next,
  onSource,
}: {
  source: ImageSource | null;
  previous: ImageSource | null;
  next: ImageSource | null;
  onSource: (source: ImageSource | null) => void;
}) {
  const studio = useStudio();
  const [detailsPreference, setDetailsPreference] = useState(loadDetailsPreference);
  const [wideLayout, setWideLayout] = useState(
    () => window.matchMedia(wideLayoutQuery).matches,
  );
  const detailsButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const detailsOpen = detailsPreference ?? wideLayout;
  const detailsId = useId();
  const hasImage = Boolean(source?.image);
  const showDetails = detailsOpen || !hasImage;
  const recoveryLayout = source?.status === "failed" && !hasImage;
  useEffect(() => {
    const query = window.matchMedia(wideLayoutQuery);
    const update = () => setWideLayout(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  function setDetailsOpen(open: boolean) {
    setDetailsPreference(open);
    try {
      localStorage.setItem(detailsPreferenceKey, String(open));
    } catch {
      // Keep the choice for this session even if browser storage is unavailable.
    }
  }

  return (
    <Dialog
      open={!!source}
      onOpenChange={(open) => {
        if (!open) {
          onSource(null);
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={
          recoveryLayout
            ? "flex max-h-[90dvh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
            : "flex h-[96dvh] max-h-[96dvh] w-[calc(100%-2rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:w-full max-sm:rounded-none"
        }
        onOpenAutoFocus={() => {
          opener.current = document.activeElement instanceof HTMLElement
            ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          const activeDialog = document.activeElement?.closest('[role="dialog"]');
          if (opener.current?.isConnected && opener.current !== document.body && !activeDialog?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight"].includes(event.key) ||
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            !(event.target instanceof HTMLElement) ||
            !event.currentTarget.contains(event.target) ||
            event.target.closest(
              'input, textarea, select, [role="slider"], [role="combobox"], [data-image-viewport="interactive"], [contenteditable]:not([contenteditable="false"])',
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const adjacent = event.key === "ArrowLeft" ? previous : next;
          if (adjacent) onSource(adjacent);
        }}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0 space-y-1">
            <DialogTitle className="truncate">
              {recoveryLayout ? "生成失敗の詳細" : source && imageTitle(source)}
            </DialogTitle>
            <DialogDescription className="truncate">
              {source && dateLabel(source.createdAt)} ·{" "}
              {recoveryLayout
                ? "原因と入力を確認して再試行できます"
                : "画像クリックで拡大・移動"}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasImage && (
              <Button
                ref={detailsButton}
                variant={detailsOpen ? "secondary" : "outline"}
                size="sm"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                onClick={() => setDetailsOpen(!detailsOpen)}
              >
                <PanelRight className="size-4" />
                詳細
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={recoveryLayout
                ? "生成失敗の詳細を閉じる"
                : "画像プレビューを閉じる"}
              onClick={() => {
                onSource(null);
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>
        {source && (
          <div className={recoveryLayout
            ? "min-h-0"
            : "flex min-h-0 flex-1 flex-col lg:flex-row"}>
            {hasImage && (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="relative flex min-h-0 flex-1">
                  <ImageViewport
                    key={`${source.id}:${source.image!.url}`}
                    source={source}
                    actions={
                      !showDetails ? (
                        <ImageActions source={source} compact />
                      ) : undefined
                    }
                  />
                  {previous && (
                    <Button
                      variant="secondary"
                      size="icon"
                      className="absolute left-3 top-1/2 -translate-y-1/2 shadow-sm"
                      aria-label="前の画像"
                      onClick={() => onSource(previous)}
                    >
                      <ChevronLeft />
                    </Button>
                  )}
                  {next && (
                    <Button
                      variant="secondary"
                      size="icon"
                      className="absolute right-3 top-1/2 -translate-y-1/2 shadow-sm"
                      aria-label="次の画像"
                      onClick={() => onSource(next)}
                    >
                      <ChevronRight />
                    </Button>
                  )}
                </div>
              </div>
            )}
            {showDetails && (
              <aside
                id={detailsId}
                aria-label={recoveryLayout ? "生成失敗の詳細" : "画像の詳細"}
                className={
                  recoveryLayout
                    ? "min-h-0 w-full"
                    : hasImage
                      ? "min-h-0 shrink-0 overflow-hidden border-t lg:w-[360px] lg:border-l lg:border-t-0 max-lg:basis-2/5"
                      : "min-h-0 w-full max-w-2xl flex-1 self-center"
                }
              >
                <ImageInspector
                  key={source.id}
                  source={source}
                  mode={studio.view === "lineage" ? "lineage" : "history"}
                  showPreview={false}
                  recoveryLayout={recoveryLayout}
                  onClose={hasImage ? () => {
                    setDetailsOpen(false);
                    detailsButton.current?.focus();
                  } : undefined}
                />
              </aside>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
