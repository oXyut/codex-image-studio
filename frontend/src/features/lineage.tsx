import { ImageContextMenu } from "@/components/image-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { openContextMenuWithKeyboard } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dateLabel, statusLabels } from "@/lib/format";
import { useStudio } from "@/lib/studio-context";
import { cn } from "@/lib/utils";
import { initialLineageFamily, lineageFamilies, packLineageOverview } from "@/lib/lineage-navigation";
import {
  buildLineageDisplayEdges,
  buildLineageGraph,
  compactBatchGeometry,
  filterLineageGraph,
  layoutLineageGraph,
  lineageBatchEdgePath,
  lineageBatchLabel,
  lineageBatchNodeId,
  lineageTitle,
} from "@shared/lineage-utils.js";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Check,
  GitBranch,
  ImageIcon,
  LoaderCircle,
  LocateFixed,
  Minus,
  Plus,
  Search,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { LineageImageList } from "./lineage-list";

import type { LineageNode } from '@shared/lineage-utils.js';
type ImageNodeData = {
  value: LineageNode;
  ancestor: boolean;
  selected: boolean;
  compact: boolean;
};
type BatchNodeData = {
  count: number;
  visibleCount: number;
  deletedCount: number;
  batchId: string;
  title: string;
  nodeCount: number;
  compact: boolean;
  onToggle?: () => void;
};
type FlowImageNode = Node<ImageNodeData, "image">;
type FlowBatchNode = Node<BatchNodeData, "batch">;
type FlowNode = FlowImageNode | FlowBatchNode;

const cardHeight = 200;

function ImageNode({ data }: NodeProps<FlowImageNode>) {
  const { value, ancestor, selected, compact } = data;
  const title = lineageTitle(value);
  const status =
    value.kind === "upload"
      ? "アップロード"
      : statusLabels[value.job.status] || value.job.status;
  const pending =
    value.job.status === "running" || value.job.status === "queued";
  return (
    <ImageContextMenu source={value.job}>
      <div
        className={cn(
          "relative rounded-xl border bg-white shadow-sm transition-colors",
          compact ? "p-1.5" : "p-2",
          selected
            ? "border-zinc-900 ring-2 ring-zinc-900/10"
            : "border-zinc-200 hover:border-zinc-400",
          ancestor && "bg-zinc-50",
        )}
        style={{
          width: compact ? compactBatchGeometry.cardWidth : 184,
          height: compact ? compactBatchGeometry.cardHeight : cardHeight,
        }}
        title={`${title}\n${status} · ${dateLabel(value.createdAt)}${ancestor ? "\n絞り込み対象の元画像" : ""}`}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!size-1 !border-0 !bg-zinc-500 !opacity-0"
        />
        <div className={cn("relative flex items-center justify-center overflow-hidden rounded-lg bg-zinc-100", compact ? "h-[84px]" : "h-32")}>
          {value.job.image?.url ? (
            <img
              src={value.job.image.url}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              draggable={false}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-zinc-500">
              {pending ? (
                <LoaderCircle className="size-7 animate-spin" />
              ) : (
                <ImageIcon className="size-7" />
              )}
              <span className="text-sm">{status}</span>
            </div>
          )}
          {compact && value.job.batch && (
            <span className="absolute left-1.5 top-1.5 min-w-5 rounded bg-white/95 px-1 text-center text-xs font-semibold leading-5 text-zinc-900">
              {value.job.batch.index}
            </span>
          )}
          {selected && (
            <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-zinc-900 text-white ring-2 ring-white">
              <Check className="size-4" />
            </span>
          )}
          {value.kind === "upload" && (
            <span
              className="absolute bottom-2 left-2 rounded-md bg-white/95 p-1 text-zinc-700"
              aria-hidden="true"
            >
              <Upload className="size-4" />
            </span>
          )}
        </div>
        <p className={cn("truncate font-semibold text-zinc-900", compact ? "mt-1 text-xs leading-4" : "mt-2 text-sm leading-5")}>
          {title}
        </p>
        <p className={cn("flex items-center gap-1.5 text-zinc-500", compact ? "mt-0.5 text-xs leading-4" : "mt-1 text-sm leading-5")}>
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              value.job.status === "failed"
                ? "bg-red-500"
                : value.job.status === "succeeded" || value.kind === "upload"
                  ? "bg-emerald-500"
                  : "bg-zinc-400",
            )}
          />
          {status}
          {!compact && value.job.batch && (
            <span>
              · {value.job.batch.index}/{value.job.batch.count}
            </span>
          )}
        </p>
        <Handle
          type="source"
          position={Position.Right}
          className="!size-1 !border-0 !bg-zinc-500 !opacity-0"
        />
      </div>
    </ImageContextMenu>
  );
}

function BatchNode({ data }: NodeProps<FlowBatchNode>) {
  return (
    <div
      className="relative h-full w-full rounded-xl border border-dashed border-indigo-200 bg-indigo-50/45 px-3 py-2"
      title={`${lineageBatchLabel(data.batchId)} · 表示 ${data.visibleCount} / 全 ${data.count}${data.deletedCount ? ` · 削除 ${data.deletedCount}` : ""}。同時作成は参照・親子関係とは別のグループです。`}
    >
      {data.compact && (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-1 !border-0 !bg-zinc-500 !opacity-0"
        />
      )}
      <p className="flex items-center gap-2 whitespace-nowrap text-sm font-medium text-zinc-600">
        <span className="size-4 rounded border border-indigo-200 bg-white/80" />
        同時作成 · {data.count}枚
      </p>
      <p className="mt-1 truncate text-xs leading-4 text-zinc-500">
        {data.visibleCount < data.count
          ? `表示 ${data.visibleCount} / ${data.count}枚${data.deletedCount ? ` · 削除 ${data.deletedCount}枚` : ""}`
          : data.title}
      </p>
      {data.onToggle && (
        <Button
          variant="ghost"
          size="sm"
          className="nodrag nopan pointer-events-auto absolute bottom-2 left-3 right-3 h-7 text-indigo-700 hover:bg-indigo-100/60"
          aria-label={`${lineageBatchLabel(data.batchId)}を${data.compact ? "展開" : "まとめて表示"}`}
          aria-expanded={!data.compact}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggle?.();
          }}
        >
          {data.compact ? `${data.nodeCount}枚を展開` : "まとめる"}
        </Button>
      )}
    </div>
  );
}

const nodeTypes = { image: ImageNode, batch: BatchNode };
function BatchEdge({ id, data, style, markerEnd }: EdgeProps<Edge<{ path: string }>>) {
  return <BaseEdge id={id} path={data?.path ?? ""} style={style} markerEnd={markerEnd} interactionWidth={0} />;
}
const edgeTypes = { batch: BatchEdge };
const allValue = "__all__";

function FilterSelect({
  label,
  value,
  onChange,
  choices,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  choices: { id: string; label: string }[];
}) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-zinc-700">{label}</label>
      <Select
        value={value || allValue}
        onValueChange={(next) => onChange(next === allValue ? "" : next)}
      >
        <SelectTrigger className="w-full" aria-label={`${label}で絞り込む`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={allValue}>すべての{label}</SelectItem>
          {choices.map((choice) => (
            <SelectItem key={choice.id} value={choice.id}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function LineageView() {
  const studio = useStudio();
  const [query, setQuery] = useState("");
  const [branchId, setBranchId] = useState("");
  const [componentId, setComponentId] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<"graph" | "list">(() => window.matchMedia("(max-width: 767px)").matches ? "list" : "graph");
  const [compactBatches, setCompactBatches] = useState(true);
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(() => new Set());
  const [zoom, setZoom] = useState(100);
  const [focusTarget, setFocusTarget] = useState<{ id: string; request: number } | null>(null);
  const focusSequence = useRef(0);
  const graphViewportRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode, Edge> | null>(
    null,
  );
  const graph = useMemo(
    () =>
      buildLineageGraph(
        studio.metadata,
        studio.jobs,
      ),
    [studio.metadata, studio.jobs],
  );
  useEffect(() => {
    const element = graphViewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || !entry.contentRect.width || !entry.contentRect.height) return;
      const { width, height } = entry.contentRect;
      setCanvasSize(current => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const families = useMemo(() => lineageFamilies(graph), [graph]);
  const activeFamilyId = componentId === null
    ? (query || branchId || studio.graphBatchId ? "" : initialLineageFamily(graph, studio.selectedId))
    : families.some(family => family.id === componentId) ? componentId : "";
  const activeFamily = families.find(family => family.id === activeFamilyId);
  const visible = useMemo(() => {
    const filtered = filterLineageGraph(graph, { query, branchId, batchId: studio.graphBatchId });
    if (!activeFamily) return filtered;
    const ids = new Set(activeFamily.nodeIds);
    return {
      ...filtered,
      nodes: filtered.nodes.filter(node => ids.has(node.id)),
      edges: filtered.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)),
      matchIds: new Set([...filtered.matchIds].filter(id => ids.has(id))),
      visibleIds: new Set([...filtered.visibleIds].filter(id => ids.has(id))),
    };
  }, [graph, query, branchId, activeFamily, studio.graphBatchId]);
  const layout = useMemo(() => {
    const result = layoutLineageGraph(graph, visible, { compactBatches, expandedBatchIds, cardHeight });
    return activeFamily ? result : packLineageOverview(graph, result);
  }, [graph, visible, activeFamily, compactBatches, expandedBatchIds]);
  const filters = [branchId, studio.graphBatchId].filter(
    Boolean,
  ).length;
  const uploads = graph.nodes.filter((value) => value.kind === "upload").length;
  const branches = graph.branches.filter((branch) =>
    graph.nodes.some((value) => value.branchId === branch.id),
  );
  useEffect(() => {
    if (studio.view === "lineage" && componentId === null && graph.nodes.length) setComponentId(activeFamilyId);
  }, [studio.view, componentId, graph.nodes.length, activeFamilyId]);
  useEffect(() => {
    if (studio.graphBatchId) setComponentId("");
  }, [studio.graphBatchId]);
  const viewportInitialized = useRef(false);
  const previousView = useRef(studio.view);
  const lastFilters = useRef("");
  const filterSignature = JSON.stringify([
    query,
    branchId,
    activeFamilyId,
    presentation,
    focusTarget?.request,
    canvasSize.width,
    canvasSize.height,
    studio.graphBatchId,
    compactBatches,
    [...expandedBatchIds].sort(),
  ]);

  const flowNodes = useMemo<FlowNode[]>(() => {
    return [
      ...layout.batchGroups.map((group): FlowBatchNode => ({
        id: lineageBatchNodeId(group),
        type: "batch",
        position: { x: group.x, y: group.y },
        data: {
          count: group.count,
          visibleCount: group.visibleCount,
          deletedCount: group.deletedCount,
          batchId: group.id,
          title: lineageTitle(graph.nodeMap.get(group.nodeIds[0])),
          nodeCount: group.nodeIds.length,
          compact: group.compact,
          onToggle: compactBatches ? () => {
            setFocusTarget(null);
            setExpandedBatchIds((current) => {
              const next = new Set(current);
              if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
              return next;
            });
          } : undefined,
        },
        style: {
          width: group.width,
          height: group.height,
          pointerEvents: "none",
        },
        selectable: false,
        focusable: false,
        draggable: false,
        zIndex: 0,
      })),
      ...visible.nodes.map((value): FlowImageNode => {
        const point = layout.positions.get(value.id)!;
        return {
          id: value.id,
          type: "image",
          position: { x: point.x, y: point.y },
          data: {
            value,
            ancestor: visible.filtered && !visible.matchIds.has(value.id),
            selected: value.id === studio.selectedId,
            compact: Boolean(point.compact),
          },
          selected: value.id === studio.selectedId,
          style: { width: point.width, height: point.height },
          draggable: false,
          zIndex: 2,
          ariaLabel: `${lineageTitle(value)}、${value.kind === "upload" ? "アップロードした参照の起点" : statusLabels[value.job.status] || value.job.status}${value.job.batch ? `、同時作成 ${value.job.batch.index}件目` : ""}`,
        };
      }),
    ];
  }, [layout, visible, graph, studio.selectedId, compactBatches]);
  const flowEdges = useMemo<Edge[]>(
    () => {
      const batchByNode = new Map(layout.batchGroups.flatMap((group) => group.nodeIds.map((id) => [id, group] as const)));
      return buildLineageDisplayEdges(
        visible.edges.filter((edge) => edge.kind === "reference"),
        layout.batchGroups,
      ).map((edge, index) => {
        const selected = edge.targetIds.some((id) => id === studio.selectedId);
        const targetTitle = edge.targetGroup
          ? `${lineageBatchLabel(edge.targetGroup.id)}（表示${edge.targetIds.length}枚）`
          : lineageTitle(graph.nodeMap.get(edge.to));
        return {
          id: `${edge.kind}:${edge.from}:${edge.to}:${index}`,
          source: edge.from,
          target: edge.to,
          type: "batch",
          data: { path: lineageBatchEdgePath(layout.positions.get(edge.from)!, edge.targetGroup ?? layout.positions.get(edge.to)!, batchByNode.get(edge.from), edge.targetGroup ? undefined : batchByNode.get(edge.to)) },
          zIndex: 1,
          selectable: false,
          focusable: false,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color: selected ? "#18181b" : "#71717a",
          },
          style: {
            stroke: selected ? "#18181b" : "#71717a",
            strokeWidth: selected ? 2 : 1.5,
          },
          ariaLabel: `${lineageTitle(graph.nodeMap.get(edge.from))}から${targetTitle}への${edge.label}`,
        };
      });
    },
    [visible.edges, graph, layout, studio.selectedId],
  );

  useEffect(() => {
    if (studio.view !== "lineage" || !flow) {
      previousView.current = studio.view;
      return;
    }
    const entering = previousView.current !== "lineage";
    const changedFilter = lastFilters.current !== filterSignature;
    const firstVisibleGraph =
      !viewportInitialized.current && visible.nodes.length > 0;
    previousView.current = studio.view;
    lastFilters.current = filterSignature;
    if (!entering && !changedFilter && !firstVisibleGraph) return;
    const target = focusTarget;
    // The view stays mounted while hidden. Fit once it has dimensions, and never
    // reset a user's pan/zoom just because polling refreshed image metadata.
    const frame = requestAnimationFrame(() => {
      if (target && presentation === "list") {
        listRef.current?.querySelector<HTMLElement>(`[data-lineage-id="${target.id}"]`)?.scrollIntoView({ block: "nearest" });
      }
      void flow.fitView({
        ...(target && visible.visibleIds.has(target.id) ? { nodes: [{ id: target.id }] } : {}),
        padding: target ? 0.35 : 0.15,
        minZoom: activeFamily ? 0.75 : 0.15,
        maxZoom: target ? 1.2 : 1,
        duration: 250,
      });
      if (visible.nodes.length) viewportInitialized.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, studio.view, filterSignature, visible.nodes.length]);

  function resetFilters() {
    setQuery("");
    setFocusTarget(null);
    setBranchId("");
    setComponentId(null);
    studio.setGraphBatchId("");
  }
  function chooseFamily(id: string) {
    resetFilters();
    setComponentId(id);
  }
  function showOverview() {
    resetFilters();
    setComponentId("");
  }
  function focusSelected() {
    if (
      !studio.selectedId ||
      !flow
    )
      return;
    const id = studio.selectedId;
    chooseFamily(families.find(family => family.nodeIds.includes(id))?.id || "");
    setFocusTarget({ id, request: ++focusSequence.current });
  }
  function panWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    const node = (event.target as HTMLElement).closest<HTMLElement>(
      ".react-flow__node-image",
    );
    const menuTrigger = node?.querySelector<HTMLElement>(
      "[data-slot=context-menu-trigger]",
    );
    if (menuTrigger && openContextMenuWithKeyboard(event, menuTrigger)) return;
    if (node && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const source = graph.nodeMap.get(node.dataset.id || "")?.job;
      if (source) studio.openPreview(source);
      return;
    }
    if (node && event.key === "Escape") {
      studio.select(null);
      return;
    }
    if (event.target !== event.currentTarget || !flow) return;
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [100, 0],
      ArrowRight: [-100, 0],
      ArrowUp: [0, 100],
      ArrowDown: [0, -100],
    };
    if (movement[event.key]) {
      event.preventDefault();
      const viewport = flow.getViewport();
      void flow.setViewport(
        {
          ...viewport,
          x: viewport.x + movement[event.key][0],
          y: viewport.y + movement[event.key][1],
        },
        { duration: 150 },
      );
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      void flow.zoomIn({ duration: 150 });
    } else if (event.key === "-") {
      event.preventDefault();
      void flow.zoomOut({ duration: 150 });
    }
  }

  return (
    <section
      className="flex min-h-full flex-col lg:h-full lg:min-h-0"
      aria-label="画像の系統図"
    >
      <div className="shrink-0 border-b bg-white px-4 py-3 sm:px-5 lg:px-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">
              画像の系統図
            </h1>
            <p className="text-sm text-zinc-500">
              生成 {graph.nodes.length - uploads}枚
              {uploads > 0 && ` · アップロード ${uploads}枚`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="同時作成の表示方法" className="flex rounded-lg border bg-zinc-50 p-0.5">
              {[{ label: "個別表示", compact: false }, { label: "まとめて表示", compact: true }].map((mode) => (
                <Button
                  key={mode.label}
                  variant="ghost"
                  size="sm"
                  aria-pressed={compactBatches === mode.compact}
                  className={cn("h-8 px-3", compactBatches === mode.compact && "bg-indigo-50 text-indigo-800 hover:bg-indigo-100")}
                  onClick={() => {
                    setFocusTarget(null);
                    setCompactBatches(mode.compact);
                    setExpandedBatchIds(new Set());
                  }}
                >
                  {mode.label}
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!graph.nodes.length}
              onClick={() => {
                const newest =
                  graph.nodes.filter((value) => value.kind !== "upload").at(-1) ||
                  graph.nodes.at(-1);
                if (!newest) return;
                chooseFamily(families.find(family => family.nodeIds.includes(newest.id))?.id || "");
                studio.select(newest.id);
                setFocusTarget({ id: newest.id, request: ++focusSequence.current });
              }}
            >
              最新の画像へ
            </Button>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
        <div className="flex min-w-0 shrink-0 flex-col lg:min-h-0 lg:flex-1">
          <div className="shrink-0 space-y-3 border-b bg-white px-4 py-3 sm:px-5 lg:px-7">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                <Input
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setFocusTarget(null); setComponentId(""); }}
                  placeholder="タイトル・プロンプトを検索"
                  aria-label="系統図を検索"
                  className="pl-9 pr-9"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="系統図の検索を消去"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:bg-zinc-100"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div className="min-w-48 flex-1 sm:max-w-72">
                <Select value={activeFamilyId || allValue} onValueChange={(value) => value === allValue ? showOverview() : chooseFamily(value)}>
                  <SelectTrigger className="w-full" aria-label="画像の系統を切り替える">
                    <SelectValue placeholder="全系統の概要" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={allValue}>全系統の概要 · {families.length}系統</SelectItem>
                    {families.map((family) => (
                      <SelectItem key={family.id} value={family.id}>
                        {family.title.slice(0, 24)} · {family.nodeIds.length}枚
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">
                    <SlidersHorizontal className="size-4" />
                    絞り込み
                    {filters > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {filters}
                      </Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 space-y-4">
                  <p className="font-semibold">系統図の絞り込み</p>
                  <FilterSelect
                    label="ブランチ"
                    value={branchId}
                    onChange={(id) => { setBranchId(id); setFocusTarget(null); setComponentId(""); }}
                    choices={branches.map((branch) => ({
                      id: branch.id,
                      label: branch.name,
                    }))}
                  />
                  <FilterSelect
                    label="同時作成"
                    value={studio.graphBatchId}
                    onChange={studio.setGraphBatchId}
                    choices={graph.batches.map((batch) => ({
                      id: batch.id,
                      label: `${lineageBatchLabel(batch.id)} · ${batch.count}枚`,
                    }))}
                  />
                  <p className="text-sm leading-relaxed text-zinc-500">
                    絞り込み中も、つながりをたどれるよう元画像を表示します。
                  </p>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={resetFilters}
                  >
                    絞り込みを解除
                  </Button>
                </PopoverContent>
              </Popover>
            </div>
            <div className="hidden flex-wrap items-center gap-x-5 gap-y-2 text-sm text-zinc-600 sm:flex">
              <span className="flex items-center gap-2">
                <span className="w-7 border-t border-zinc-600" />
                画像を参照
              </span>
              <span className="flex items-center gap-2">
                <span className="size-4 rounded border border-indigo-200 bg-indigo-50" />
                同時作成
              </span>
              <span className="flex items-center gap-2">
                <Upload className="size-3.5" />
                参照の起点
              </span>
              <span className="ml-auto text-zinc-500" aria-live="polite">
                {visible.filtered
                  ? `${visible.matchIds.size}枚に一致 · 元画像を含め ${visible.nodes.length}枚`
                  : `${branches.length}ブランチ · ${graph.components.length}系統`}
              </span>
              {visible.filtered && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={resetFilters}
                >
                  解除
                </Button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-white px-4 py-2 sm:px-5 lg:px-7">
            <div role="group" aria-label="系統の表示形式" className="flex rounded-lg border p-0.5">
              <Button variant="ghost" size="sm" aria-pressed={presentation === "graph"} className={cn(presentation === "graph" && "bg-zinc-100")} onClick={() => setPresentation("graph")}>系統図</Button>
              <Button variant="ghost" size="sm" aria-pressed={presentation === "list"} className={cn(presentation === "list" && "bg-zinc-100")} onClick={() => setPresentation("list")}>リスト</Button>
            </div>
            <Button variant="outline" size="sm" disabled={!graph.nodes.length} aria-pressed={!activeFamilyId} onClick={showOverview}>全系統の概要</Button>
            {activeFamily && presentation === "graph" && <Button variant="outline" size="sm" onClick={() => { setFocusTarget(null); void flow?.fitView({ minZoom: 0.75, maxZoom: 1, padding: 0.15, duration: 250 }); }}>この系統を表示</Button>}
            <Button variant="outline" size="sm" disabled={!studio.selectedId || !graph.nodeMap.has(studio.selectedId)} onClick={focusSelected}><LocateFixed className="size-4" />選択へ</Button>
            {presentation === "graph" && <div className="flex items-center rounded-lg border">
              <Button variant="ghost" size="icon-sm" aria-label="系統図を縮小" onClick={() => void flow?.zoomOut({ duration: 150 })}><Minus className="size-4" /></Button>
              <span className="min-w-12 text-center text-sm tabular-nums">{zoom}%</span>
              <Button variant="ghost" size="icon-sm" aria-label="系統図を拡大" onClick={() => void flow?.zoomIn({ duration: 150 })}><Plus className="size-4" /></Button>
            </div>}
          </div>
          <p role="status" className="shrink-0 border-b bg-zinc-50 px-4 py-2 text-sm text-zinc-600 sm:px-5 lg:px-7">
            {activeFamily ? `${activeFamily.title} · ${visible.nodes.length}枚` : `全${families.length}系統の概要。系統を選ぶと画像と分岐を読める表示に戻ります。`}
          </p>
          <div className="flex min-h-0 flex-col lg:flex-1 lg:flex-row">
            {!activeFamily && families.length > 0 && (
              <aside aria-label="系統の一覧" className="max-h-48 shrink-0 overflow-y-auto border-b bg-white p-3 lg:max-h-none lg:w-52 lg:border-b-0 lg:border-r">
                <p className="mb-2 text-sm font-semibold">系統を選ぶ</p>
                <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
                  {families.map(family => <Button key={family.id} variant="ghost" className="h-auto justify-start whitespace-normal px-2 py-2 text-left" onClick={() => chooseFamily(family.id)}>
                    <span><span className="block text-sm">{family.title}</span><span className="block text-xs font-normal text-zinc-500">{family.nodeIds.length}枚</span></span>
                  </Button>)}
                </div>
              </aside>
            )}
            {presentation === "list" && (
              <LineageImageList
                graph={graph}
                visible={visible}
                families={activeFamily ? [activeFamily] : families}
                selectedId={studio.selectedId}
                onOpen={studio.openPreview}
                listRef={listRef}
              />
            )}
          <div
            ref={graphViewportRef}
            className={cn("relative h-[48dvh] min-h-[300px] min-w-0 shrink-0 lg:flex-1 overflow-hidden bg-zinc-50 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-400 lg:h-auto lg:min-h-0", presentation !== "graph" && "hidden")}
            role="region"
            aria-label="画像のつながり。背景をドラッグ、上下左右キーで移動できます"
            tabIndex={presentation === "graph" ? 0 : -1}
            onKeyDown={panWithKeyboard}
          >
            <ReactFlow<FlowNode, Edge>
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={setFlow}
              onNodeClick={(_, node) => {
                if (node.type === "image")
                  studio.openPreview(node.data.value.job);
              }}
              onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              elementsSelectable
              minZoom={0.15}
              maxZoom={2}
              zoomOnDoubleClick={false}
              proOptions={{ hideAttribution: true }}
              ariaLabelConfig={{
                "node.a11yDescription.default":
                  "画像を選択して詳細を表示します。",
                "node.a11yDescription.keyboardDisabled":
                  "画像を選択して詳細を表示します。",
                "controls.zoomIn.ariaLabel": "系統図を拡大",
                "controls.zoomOut.ariaLabel": "系統図を縮小",
                "controls.fitView.ariaLabel": "系統図全体を表示",
              }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                color="#d4d4d8"
                gap={22}
                size={1}
              />
            </ReactFlow>
            {!visible.nodes.length && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
                <div className="max-w-sm text-center">
                  <GitBranch className="mx-auto mb-4 size-9 text-zinc-400" />
                  <h2 className="text-lg font-semibold text-zinc-800">
                    {graph.nodes.length
                      ? "条件に合う画像がありません"
                      : "画像のつながりを、ここに"}
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                    {graph.nodes.length
                      ? "検索や絞り込みの条件を変更してください。"
                      : "画像を生成すると、参照の起点や別案のつながりをたどれます。"}
                  </p>
                  {graph.nodes.length > 0 && (
                    <Button
                      variant="outline"
                      className="pointer-events-auto mt-4"
                      onClick={resetFilters}
                    >
                      絞り込みを解除
                    </Button>
                  )}
                </div>
              </div>
            )}
            <span className="pointer-events-none absolute bottom-3 right-4 hidden text-xs text-zinc-500 sm:block">背景をドラッグ、矢印キーで移動</span>
          </div>
          </div>
          {(graph.missingEdges.length > 0 || graph.cyclicEdges.length > 0) && (
            <div
              role="status"
              className="shrink-0 border-t border-amber-200 bg-amber-50 px-5 py-3 text-sm leading-relaxed text-amber-900"
            >
              {graph.missingEdges.length > 0 && (
                <p>
                  {graph.missingEdges.length}
                  件の元画像が見つかりません。履歴の詳細には元画像のIDを残しています。
                </p>
              )}
              {graph.cyclicEdges.length > 0 && (
                <p>循環する履歴があるため、その線の表示を省略しました。</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
