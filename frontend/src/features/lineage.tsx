import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ImageInspector } from "@/components/image-inspector";
import { dateLabel, statusLabels } from "@/lib/format";
import { useStudio } from "@/lib/studio-context";
import type { ImageSource } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  buildLineageGraph,
  filterLineageGraph,
  layoutLineageGraph,
  lineageBatchLabel,
  lineageTitle,
} from "@legacy/lineage-utils.js";

type LineageNode = {
  id: string;
  kind: "upload" | "generation";
  job: ImageSource;
  title: string;
  notes: string;
  branchId: string;
  branch?: { id: string; name: string };
  parentIds: string[];
  sourceJobId: string | null;
  batchId: string;
  componentId: string;
  dependencies: string[];
  operation: string;
  createdAt: string;
};
type LineageEdge = {
  from: string;
  to: string;
  kind: "reference" | "source";
  label: string;
};
type LineageGraph = {
  nodes: LineageNode[];
  nodeMap: Map<string, LineageNode>;
  edges: LineageEdge[];
  branches: { id: string; name: string }[];
  components: { id: string; title: string; nodeIds: string[] }[];
  batches: {
    id: string;
    count: number;
    nodeIds: string[];
    deletedCount: number;
  }[];
  missingEdges: LineageEdge[];
  cyclicEdges: LineageEdge[];
};
type VisibleGraph = {
  nodes: LineageNode[];
  edges: LineageEdge[];
  matchIds: Set<string>;
  visibleIds: Set<string>;
  filtered: boolean;
};
type GraphLayout = {
  positions: Map<string, { x: number; y: number }>;
  batchGroups: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    count: number;
    visibleCount: number;
    deletedCount: number;
  }[];
  cardHeight: number;
};
type ImageNodeData = {
  value: LineageNode;
  ancestor: boolean;
  selected: boolean;
};
type BatchNodeData = {
  count: number;
  visibleCount: number;
  deletedCount: number;
  batchId: string;
};
type FlowImageNode = Node<ImageNodeData, "image">;
type FlowBatchNode = Node<BatchNodeData, "batch">;
type FlowNode = FlowImageNode | FlowBatchNode;

const cardHeight = 200;

function ImageNode({ data }: NodeProps<FlowImageNode>) {
  const { value, ancestor, selected } = data;
  const title = lineageTitle(value);
  const status =
    value.kind === "upload"
      ? "アップロード"
      : statusLabels[value.job.status] || value.job.status;
  const pending =
    value.job.status === "running" || value.job.status === "queued";
  return (
    <div
      className={cn(
        "relative h-[200px] w-[184px] rounded-xl border bg-white p-2 shadow-sm transition-colors",
        selected
          ? "border-zinc-900 ring-2 ring-zinc-900/10"
          : "border-zinc-200 hover:border-zinc-400",
        ancestor && "bg-zinc-50",
      )}
      title={`${title}\n${status} · ${dateLabel(value.createdAt)}${ancestor ? "\n絞り込み対象の元画像" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-1 !border-0 !bg-zinc-500 !opacity-0"
      />
      <div className="relative flex h-32 items-center justify-center overflow-hidden rounded-lg bg-zinc-100">
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
      <p className="mt-2 truncate text-sm font-semibold leading-5 text-zinc-900">
        {title}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-sm leading-5 text-zinc-500">
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
        {value.job.batch && (
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
  );
}

function BatchNode({ data }: NodeProps<FlowBatchNode>) {
  return (
    <div
      className="h-full w-full rounded-xl border border-dashed border-indigo-200 bg-indigo-50/45 px-3 py-2"
      title={`${lineageBatchLabel(data.batchId)} · 表示 ${data.visibleCount} / 全 ${data.count}${data.deletedCount ? ` · 削除 ${data.deletedCount}` : ""}。同時作成は参照・親子関係とは別のグループです。`}
    >
      <p className="flex items-center gap-2 whitespace-nowrap text-sm font-medium text-zinc-600">
        <span className="size-4 rounded border border-indigo-200 bg-white/80" />
        同時作成 · {data.count}枚
      </p>
    </div>
  );
}

const nodeTypes = { image: ImageNode, batch: BatchNode };
const allValue = "__all__";

function useWideScreen() {
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

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
  const wide = useWideScreen();
  const [query, setQuery] = useState("");
  const [branchId, setBranchId] = useState("");
  const [componentId, setComponentId] = useState("");
  const [zoom, setZoom] = useState(100);
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode, Edge> | null>(
    null,
  );
  const graph = useMemo(
    () =>
      buildLineageGraph(
        studio.metadata as any,
        studio.jobs,
      ) as unknown as LineageGraph,
    [studio.metadata, studio.jobs],
  );
  const visible = useMemo(
    () =>
      filterLineageGraph(graph, {
        query,
        branchId,
        componentId,
        batchId: studio.graphBatchId,
      }) as VisibleGraph,
    [graph, query, branchId, componentId, studio.graphBatchId],
  );
  const layout = useMemo(
    () => layoutLineageGraph(graph, visible) as GraphLayout,
    [graph, visible],
  );
  const selectedSource = graph.nodeMap.get(studio.selectedId || "")?.job;
  const filters = [branchId, componentId, studio.graphBatchId].filter(
    Boolean,
  ).length;
  const uploads = graph.nodes.filter((value) => value.kind === "upload").length;
  const branches = graph.branches.filter((branch) =>
    graph.nodes.some((value) => value.branchId === branch.id),
  );
  const viewportInitialized = useRef(false);
  const previousView = useRef(studio.view);
  const lastFilters = useRef("");
  const filterSignature = JSON.stringify([
    query,
    branchId,
    componentId,
    studio.graphBatchId,
  ]);

  const flowNodes = useMemo<FlowNode[]>(() => {
    const scale = cardHeight / layout.cardHeight;
    return [
      ...layout.batchGroups.map((group, index): FlowBatchNode => ({
        id: `batch:${group.id}:${index}`,
        type: "batch",
        position: { x: group.x, y: group.y * scale },
        data: {
          count: group.count,
          visibleCount: group.visibleCount,
          deletedCount: group.deletedCount,
          batchId: group.id,
        },
        style: {
          width: group.width,
          height: group.height * scale,
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
          position: { x: point.x, y: point.y * scale },
          data: {
            value,
            ancestor: visible.filtered && !visible.matchIds.has(value.id),
            selected: value.id === studio.selectedId,
          },
          selected: value.id === studio.selectedId,
          style: { width: 184, height: cardHeight },
          draggable: false,
          zIndex: 2,
          ariaLabel: `${lineageTitle(value)}、${value.kind === "upload" ? "アップロードした参照の起点" : statusLabels[value.job.status] || value.job.status}${value.job.batch ? `、同時作成 ${value.job.batch.index}件目` : ""}`,
        };
      }),
    ];
  }, [layout, visible, studio.selectedId]);
  const flowEdges = useMemo<Edge[]>(
    () =>
      visible.edges.map((edge, index) => ({
        id: `${edge.kind}:${edge.from}:${edge.to}:${index}`,
        source: edge.from,
        target: edge.to,
        type: "default",
        zIndex: 1,
        selectable: false,
        focusable: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: edge.to === studio.selectedId ? "#18181b" : "#71717a",
        },
        style: {
          stroke: edge.to === studio.selectedId ? "#18181b" : "#71717a",
          strokeWidth: edge.to === studio.selectedId ? 2 : 1.5,
          ...(edge.kind === "source" ? { strokeDasharray: "6 5" } : {}),
        },
        ariaLabel: `${lineageTitle(graph.nodeMap.get(edge.from))}から${lineageTitle(graph.nodeMap.get(edge.to))}への${edge.label}`,
      })),
    [visible.edges, graph, studio.selectedId],
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
    // The view stays mounted while hidden. Fit once it has dimensions, and never
    // reset a user's pan/zoom just because polling refreshed image metadata.
    const frame = requestAnimationFrame(() => {
      void flow.fitView({
        padding: 0.15,
        minZoom: 0.25,
        maxZoom: 1,
        duration: 250,
      });
      if (visible.nodes.length) viewportInitialized.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, studio.view, filterSignature, visible.nodes.length]);

  function resetFilters() {
    setQuery("");
    setBranchId("");
    setComponentId("");
    studio.setGraphBatchId("");
  }
  function focusSelected() {
    if (
      !studio.selectedId ||
      !visible.visibleIds.has(studio.selectedId) ||
      !flow
    )
      return;
    void flow.fitView({
      nodes: [{ id: studio.selectedId }],
      maxZoom: 1.2,
      padding: 0.35,
      duration: 300,
    });
  }
  function panWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    const node = (event.target as HTMLElement).closest<HTMLElement>(
      ".react-flow__node-image",
    );
    if (node && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      studio.select(node.dataset.id || null);
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
    <section className="flex min-h-full flex-col lg:h-full lg:min-h-0" aria-label="画像の系統図">
      <div className="shrink-0 border-b bg-white px-5 py-5 lg:px-7">
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
          <Button
            variant="outline"
            size="sm"
            disabled={!graph.nodes.length}
            onClick={() => {
              const newest =
                graph.nodes.filter((value) => value.kind !== "upload").at(-1) ||
                graph.nodes.at(-1);
              if (!newest) return;
              resetFilters();
              studio.select(newest.id);
              requestAnimationFrame(
                () =>
                  void flow?.fitView({
                    nodes: [{ id: newest.id }],
                    maxZoom: 1.2,
                    padding: 0.35,
                    duration: 300,
                  }),
              );
            }}
          >
            最新の画像へ
          </Button>
        </div>
      </div>
      <div className="flex shrink-0 flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
        <div className="flex min-w-0 shrink-0 flex-col lg:min-h-0 lg:flex-1">
          <div className="shrink-0 space-y-4 border-b bg-white px-5 py-4 lg:px-7">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
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
              <div className="w-44 shrink-0">
                <Select
                  value={componentId || allValue}
                  onValueChange={(value) =>
                    setComponentId(value === allValue ? "" : value)
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label="画像の系統で絞り込む"
                  >
                    <SelectValue placeholder="すべての系統" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={allValue}>すべての系統</SelectItem>
                    {graph.components.map((component) => (
                      <SelectItem key={component.id} value={component.id}>
                        {component.title.slice(0, 24)} ·{" "}
                        {component.nodeIds.length}枚
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
                    onChange={setBranchId}
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
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-zinc-600">
              <span className="flex items-center gap-2">
                <span className="w-7 border-t border-zinc-600" />
                画像を参照
              </span>
              <span className="flex items-center gap-2">
                <span className="w-7 border-t border-dashed border-zinc-600" />
                入力を再利用
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
          <div
            className="relative h-[60dvh] min-h-[440px] shrink-0 overflow-hidden bg-zinc-50 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-400 lg:h-auto lg:min-h-0 lg:flex-1"
            role="region"
            aria-label="画像のつながり。背景をドラッグ、上下左右キーで移動できます"
            tabIndex={0}
            onKeyDown={panWithKeyboard}
          >
            <ReactFlow<FlowNode, Edge>
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              onInit={setFlow}
              onNodeClick={(_, node) => {
                if (node.type === "image") studio.select(node.id);
              }}
              onNodeDoubleClick={(_, node) => {
                if (node.type === "image" && node.data.value.job.image)
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
            <div className="absolute bottom-4 left-4 right-4 flex flex-wrap items-center gap-2">
              <div className="flex items-center rounded-lg border bg-white shadow-sm">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="系統図を縮小"
                  className="rounded-r-none"
                  onClick={() => void flow?.zoomOut({ duration: 150 })}
                >
                  <Minus className="size-4" />
                </Button>
                <span
                  className="min-w-14 border-x px-2 text-center text-sm tabular-nums"
                  aria-live="off"
                >
                  {zoom}%
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="系統図を拡大"
                  className="rounded-l-none"
                  onClick={() => void flow?.zoomIn({ duration: 150 })}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
              <Button
                variant="outline"
                className="bg-white shadow-sm"
                disabled={!visible.nodes.length}
                onClick={() =>
                  void flow?.fitView({
                    padding: 0.15,
                    minZoom: 0.25,
                    maxZoom: 1,
                    duration: 300,
                  })
                }
              >
                全体を表示
              </Button>
              <Button
                variant="outline"
                className="bg-white shadow-sm"
                disabled={
                  !studio.selectedId ||
                  !visible.visibleIds.has(studio.selectedId)
                }
                onClick={focusSelected}
              >
                <LocateFixed className="size-4" />
                選択へ
              </Button>
              <span className="ml-auto hidden text-sm text-zinc-500 md:inline">
                背景をドラッグして移動
              </span>
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
        {wide && (
          <aside
            className="min-h-0 w-[336px] shrink-0 overflow-hidden border-l bg-white"
            aria-label="選択した画像の詳細"
          >
            {selectedSource ? (
              <ImageInspector
                source={selectedSource}
                mode="lineage"
                onClose={() => studio.select(null)}
              />
            ) : (
              <div className="p-5">
                <h2 className="font-semibold">選択した画像</h2>
                <p className="mt-3 text-sm leading-relaxed text-zinc-500">
                  画像を選択すると、生成時の入力や参照のつながりを確認できます。
                </p>
              </div>
            )}
          </aside>
        )}
      </div>
      {!wide && (
        <Sheet
          open={Boolean(selectedSource) && studio.view === "lineage"}
          onOpenChange={(open) => {
            if (!open) studio.select(null);
          }}
        >
          <SheetContent
            side="right"
            className="w-full gap-0 p-0 sm:max-w-md"
            showCloseButton={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>選択した画像の詳細</SheetTitle>
              <SheetDescription>
                選択した画像のプレビュー、操作、生成時の設定と参照のつながり
              </SheetDescription>
            </SheetHeader>
            {selectedSource && (
              <ImageInspector
                source={selectedSource}
                mode="lineage"
                onClose={() => studio.select(null)}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </section>
  );
}
