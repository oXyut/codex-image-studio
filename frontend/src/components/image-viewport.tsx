import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import type { ImageSource } from "@/lib/types";
import { imageTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

type Size = { width: number; height: number };
type Transform = { zoom: number; x: number; y: number };
const initialTransform: Transform = { zoom: 1, x: 0, y: 0 };
const maxZoom = 8;

export function ImageViewport({
  source,
  actions,
}: {
  source: ImageSource;
  actions?: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    start: Transform;
    moved: boolean;
  } | null>(null);
  const moved = useRef(false);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [nativeSize, setNativeSize] = useState<Size>({
    width: source.image?.width || 0,
    height: source.image?.height || 0,
  });
  const [transform, setTransform] = useState(initialTransform);
  const [interactive, setInteractive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const instructionsId = useId();
  const fitScale =
    nativeSize.width && nativeSize.height
      ? Math.min(
          Math.max(1, viewport.width - 32) / nativeSize.width,
          Math.max(1, viewport.height - 32) / nativeSize.height,
        )
      : 0;
  const fit = {
    width: nativeSize.width * fitScale,
    height: nativeSize.height * fitScale,
  };
  const ready =
    viewport.width > 0 && viewport.height > 0 && fitScale > 0 && !loadError;

  function constrain(value: Transform): Transform {
    const maxX = Math.max(0, (fit.width * value.zoom - viewport.width) / 2);
    const maxY = Math.max(0, (fit.height * value.zoom - viewport.height) / 2);
    return {
      ...value,
      x: Math.max(-maxX, Math.min(maxX, value.x)),
      y: Math.max(-maxY, Math.min(maxY, value.y)),
    };
  }
  function zoomAt(value: Transform, zoom: number, x = 0, y = 0) {
    const bounded = Math.max(1, Math.min(maxZoom, zoom));
    const ratio = bounded / value.zoom;
    return constrain({
      zoom: bounded,
      x: x - (x - value.x) * ratio,
      y: y - (y - value.y) * ratio,
    });
  }
  function changeZoom(zoom: number) {
    setInteractive(true);
    setTransform((value) => zoomAt(value, zoom));
  }
  function reset() {
    setTransform(initialTransform);
    setInteractive(false);
  }

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () =>
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setTransform((value) => constrain(value));
  }, [viewport.width, viewport.height, nativeSize.width, nativeSize.height]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !interactive || !ready) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewport.height
            : 1);
      setTransform((value) =>
        zoomAt(
          value,
          value.zoom * Math.exp(-delta * 0.002),
          event.clientX - bounds.left - bounds.width / 2,
          event.clientY - bounds.top - bounds.height / 2,
        ),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [
    interactive,
    ready,
    viewport.width,
    viewport.height,
    fit.width,
    fit.height,
  ]);

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    moved.current = drag.current.moved;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={viewportRef}
        data-image-viewport={interactive ? "interactive" : "fit"}
        role="button"
        tabIndex={0}
        aria-label={
          interactive ? "画像の表示位置を操作" : "画像をクリックして拡大・移動"
        }
        aria-describedby={instructionsId}
        title={
          interactive
            ? "ドラッグで移動 · スクロールで拡大・縮小"
            : "画像をクリックして拡大・移動"
        }
        aria-pressed={interactive}
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden bg-muted/50 select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          (source.transparent || source.kind === "upload") && "checkerboard",
          interactive
            ? dragging
              ? "!cursor-grabbing"
              : "!cursor-grab"
            : "!cursor-zoom-in",
        )}
        onClick={(event) => {
          if (moved.current) {
            moved.current = false;
            return;
          }
          if (interactive || !ready) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          setInteractive(true);
          setTransform((value) =>
            zoomAt(
              value,
              2,
              event.clientX - bounds.left - bounds.width / 2,
              event.clientY - bounds.top - bounds.height / 2,
            ),
          );
        }}
        onPointerDown={(event) => {
          moved.current = false;
          if (!interactive || !ready || event.button !== 0 || drag.current)
            return;
          event.currentTarget.focus();
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            start: transform,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          const dx = event.clientX - current.x,
            dy = event.clientY - current.y;
          if (Math.hypot(dx, dy) > 4) current.moved = true;
          if (!current.moved) return;
          setDragging(true);
          setTransform(
            constrain({
              ...current.start,
              x: current.start.x + dx,
              y: current.start.y + dy,
            }),
          );
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
            return;
          if (["Enter", " ", "+", "=", "-", "0"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (!ready) return;
            if (event.key === "0") reset();
            else
              changeZoom(
                event.key === "-"
                  ? transform.zoom / 1.25
                  : transform.zoom * (interactive ? 1.25 : 2),
              );
          } else if (
            interactive &&
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            const movement: Record<string, [number, number]> = {
              ArrowLeft: [60, 0],
              ArrowRight: [-60, 0],
              ArrowUp: [0, 60],
              ArrowDown: [0, -60],
            };
            const [dx, dy] = movement[event.key];
            setTransform((value) =>
              constrain({ ...value, x: value.x + dx, y: value.y + dy }),
            );
          }
        }}
      >
        <img
          src={source.image?.url}
          alt={imageTitle(source)}
          draggable={false}
          onLoad={(event) => {
            setNativeSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
            setLoadError(false);
          }}
          onError={() => setLoadError(true)}
          className={
            ready
              ? "pointer-events-none absolute left-1/2 top-1/2 max-w-none object-contain"
              : "pointer-events-none absolute inset-0 size-full object-contain p-4"
          }
          style={
            ready
              ? {
                  width: fit.width,
                  height: fit.height,
                  transform: `translate(-50%, -50%) translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
                }
              : undefined
          }
        />
        {loadError && (
          <p
            role="alert"
            className="absolute inset-0 flex items-center justify-center bg-background/90 p-5"
          >
            画像を読み込めませんでした。
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-background px-3 py-2">
        <div>
          {actions}
          <p
            id={instructionsId}
            className={cn(
              "text-xs text-muted-foreground",
              actions && "sr-only",
            )}
          >
            {interactive
              ? "ドラッグで移動 · スクロールで拡大・縮小"
              : "画像をクリックして拡大・移動"}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="画像を縮小"
            disabled={!ready || transform.zoom <= 1}
            onClick={() => changeZoom(transform.zoom / 1.25)}
          >
            <Minus className="size-4" />
          </Button>
          <input
            type="range"
            aria-label="画像の表示倍率"
            title="全体表示を100%とした倍率"
            min={100}
            max={maxZoom * 100}
            step={1}
            value={Math.round(transform.zoom * 100)}
            disabled={!ready}
            className="w-20 accent-foreground sm:w-28"
            onChange={(event) => changeZoom(Number(event.target.value) / 100)}
          />
          <output
            className="w-12 text-center text-sm tabular-nums"
            aria-label="現在の表示倍率"
          >
            {Math.round(transform.zoom * 100)}%
          </output>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="画像を拡大"
            disabled={!ready || transform.zoom >= maxZoom}
            onClick={() => changeZoom(transform.zoom * 1.25)}
          >
            <Plus className="size-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={reset}>
            <Maximize className="size-4" />
            全体表示
          </Button>
        </div>
      </div>
    </div>
  );
}
