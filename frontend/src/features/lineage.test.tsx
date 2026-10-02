import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageView } from "./lineage";

const flowMocks = vi.hoisted(() => ({
  fitView: vi.fn().mockResolvedValue(true),
  nodes: [] as Node[],
  edges: [] as Edge[],
}));

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const { useEffect } = await import("react");
  const instance = {
    fitView: flowMocks.fitView,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setViewport: vi.fn(),
  } as unknown as ReactFlowInstance;
  return {
    ...actual,
    Background: () => null,
    Handle: () => null,
    ReactFlow: ({
      nodes,
      edges,
      onInit,
      onNodeClick,
      nodeTypes,
    }: {
      nodeTypes: Record<string, ComponentType<{ data: Record<string, unknown> }>>;
      nodes: Node[];
      edges: Edge[];
      onInit: (flow: ReactFlowInstance) => void;
      onNodeClick: (event: unknown, node: Node) => void;
    }) => {
      flowMocks.nodes = nodes;
      flowMocks.edges = edges;
      useEffect(() => onInit(instance), [onInit]);
      return (
        <div>
          {nodes.map((node) => (
              <div
                role={node.type === "image" ? "button" : undefined}
                tabIndex={node.type === "image" ? 0 : undefined}
                className={`react-flow__node-${node.type}`}
                data-id={node.id}
                key={node.id}
                aria-label={node.ariaLabel}
                onClick={(event) => onNodeClick(event, node)}
              >
                {(() => {
                  const Component = nodeTypes[node.type!];
                  return <Component data={node.data} />;
                })()}
              </div>
            ))}
        </div>
      );
    },
  };
});

const uploaded: ImageSource = {
  id: "upload",
  kind: "upload",
  name: "森林の参照",
  status: "uploaded",
  createdAt: "2026-10-02T00:00:00Z",
};
const parent: ImageSource = {
  id: "parent",
  prompt: "朝の森",
  status: "succeeded",
  createdAt: "2026-10-02T00:01:00Z",
  references: [{ uploadId: uploaded.id, role: "reference" }],
};
const source: ImageSource = {
  id: "source",
  prompt: "入力の起点",
  status: "succeeded",
  createdAt: "2026-10-02T00:02:00Z",
};
const child: ImageSource = {
  id: "child",
  prompt: "Target Cabin",
  status: "succeeded",
  createdAt: "2026-10-02T00:03:00Z",
  references: [
    { jobId: parent.id, role: "reference" },
    { uploadId: uploaded.id, role: "reference" },
  ],
  lineage: { sourceJobId: source.id, operation: "edit" },
  batch: { id: "batch-123", index: 1, count: 2 },
};
const peer: ImageSource = {
  id: "peer",
  prompt: "Other Cabin",
  status: "succeeded",
  createdAt: "2026-10-02T00:03:01Z",
  batch: { id: "batch-123", index: 2, count: 2 },
};

function context(overrides: Partial<StudioContextValue> = {}) {
  return {
    jobs: [parent, source, child, peer],
    uploads: [uploaded],
    metadata: { commits: [], branches: [], uploads: [uploaded] },
    view: "lineage",
    selectedId: null,
    graphBatchId: "",
    select: vi.fn(),
    setGraphBatchId: vi.fn(),
    openPreview: vi.fn(),
    favoritePendingIds: [],
    draft: { count: 1 },
    replaceFromSource: vi.fn(),
    ...overrides,
  } as unknown as StudioContextValue;
}

function view(value: StudioContextValue) {
  return (
    <StudioContext.Provider value={value}>
      <LineageView />
    </StudioContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LineageView", () => {
  it("ノードにフォーカスしてShift+F10で開き、選択を変えずにそのノードの入力を編集する", async () => {
    const studio = context({ selectedId: source.id });
    const user = userEvent.setup();
    render(view(studio));
    const node = screen.getByRole("button", { name: /Target Cabin、完成/ });
    node.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(
      screen.getByRole("menu", { name: "Target Cabinの操作" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(studio.select).not.toHaveBeenCalled();
    fireEvent.contextMenu(
      node.querySelector("[data-slot=context-menu-trigger]")!,
    );
    await user.click(
      screen.getByRole("menuitem", { name: "元の入力に置き換えて編集" }),
    );
    expect(studio.replaceFromSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: child.id }),
    );
    expect(studio.select).not.toHaveBeenCalled();
  });

  it("検索中も全ての参照元・入力元とアップロード起点を残す", () => {
    render(view(context()));
    fireEvent.change(screen.getByRole("textbox", { name: "系統図を検索" }), {
      target: { value: "Target Cabin" },
    });

    expect(
      flowMocks.nodes
        .filter((node) => node.type === "image")
        .map((node) => node.id),
    ).toEqual(["upload", "parent", "source", "child"]);
    expect(
      flowMocks.edges.filter((edge) => edge.target === child.id),
    ).toHaveLength(3);
    expect(
      flowMocks.edges.find(
        (edge) => edge.source === source.id && edge.target === child.id,
      )?.style?.strokeDasharray,
    ).toBe("6 5");
    expect(
      flowMocks.edges.find(
        (edge) => edge.source === uploaded.id && edge.target === child.id,
      )?.style?.strokeDasharray,
    ).toBeUndefined();
    expect(
      flowMocks.nodes.filter((node) => node.type === "batch"),
    ).toHaveLength(1);
    expect(
      screen.getByText("1枚に一致 · 元画像を含め 4枚"),
    ).toBeInTheDocument();
  });

  it("画面へ移った時に全体を表示し、定期更新ではパン・ズームをリセットしない", async () => {
    const studio = context({ view: "history" });
    const { rerender } = render(view(studio));
    expect(flowMocks.fitView).not.toHaveBeenCalled();

    rerender(view({ ...studio, view: "lineage" }));
    await waitFor(() => expect(flowMocks.fitView).toHaveBeenCalledTimes(1));
    rerender(
      view({
        ...studio,
        view: "lineage",
        jobs: studio.jobs.map((job) => ({
          ...job,
          image: { url: "/image.png", downloadUrl: "/download.png" },
        })),
      }),
    );
    expect(flowMocks.fitView).toHaveBeenCalledTimes(1);

    rerender(view({ ...studio, view: "history" }));
    rerender(view({ ...studio, view: "lineage" }));
    await waitFor(() => expect(flowMocks.fitView).toHaveBeenCalledTimes(2));
  });

  it("画像選択を共通の詳細へ渡し、欠落や循環を警告する", () => {
    const cyclic = { ...parent, lineage: { parentIds: [child.id, "missing"] } };
    const studio = context({
      jobs: [cyclic, source, child],
      selectedId: uploaded.id,
    });
    render(view(studio));
    expect(screen.getByText(/元画像が見つかりません/)).toBeInTheDocument();
    expect(screen.getByText(/循環する履歴/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Target Cabin、完成/ }));
    expect(studio.openPreview).toHaveBeenCalledExactlyOnceWith(child);
  });

  it("選択状態だけでは詳細UIを開かず、画像クリックで共通ビューアを開く", () => {
    const studio = context({ selectedId: child.id });
    render(view(studio));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "選択した画像の詳細" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Target Cabin、完成/ }));
    expect(studio.openPreview).toHaveBeenCalledExactlyOnceWith(child);
    expect(studio.select).not.toHaveBeenCalled();
  });

  it("EnterとSpaceで画像のない履歴も共通ビューアへ渡す", () => {
    const studio = context();
    render(view(studio));
    const node = screen.getByRole("button", { name: /Target Cabin、完成/ });
    fireEvent.keyDown(node, { key: "Enter" });
    fireEvent.keyDown(node, { key: " " });
    expect(studio.openPreview).toHaveBeenCalledTimes(2);
    expect(studio.openPreview).toHaveBeenLastCalledWith(child);
  });

  it("初期表示で同時作成を2列にまとめ、まとまりごとに展開・再収納できる", async () => {
    const batch = { id: "four-variants", count: 4 };
    const variants = [1, 2, 3, 4].map((index) => ({
      ...parent, id: `variant-${index}`, prompt: `別案 ${index}`,
      batch: { ...batch, index }, references: [],
    }));
    const derived = { ...child, batch: undefined, references: [{ jobId: variants[1].id, role: "reference" }] };
    const studio = context({ jobs: [...variants, derived], metadata: { commits: [], branches: [], uploads: [] } });
    const user = userEvent.setup();
    render(view(studio));
    expect(screen.getByRole("button", { name: "まとめて表示" })).toHaveAttribute("aria-pressed", "true");
    const positions = () => variants.map((image) => flowMocks.nodes.find((node) => node.id === image.id)!.position);
    const compact = positions();
    expect(compact[0].y).toBe(compact[1].y);
    expect(compact[0].x).toBe(compact[2].x);
    expect(compact[2].y).toBe(compact[3].y);
    const edgeIds = flowMocks.edges.map((edge) => edge.id);
    expect(flowMocks.edges.some((edge) => edge.source === variants[1].id && edge.target === derived.id)).toBe(true);

    await user.click(screen.getByRole("button", { name: /同時作成 #four-vを展開/ }));
    const expanded = positions();
    expect(new Set(expanded.map((point) => point.x)).size).toBe(1);
    expect(expanded[3].y - expanded[0].y).toBeGreaterThan(compact[3].y - compact[0].y);
    expect(flowMocks.edges.map((edge) => edge.id)).toEqual(edgeIds);
    expect(studio.openPreview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /同時作成 #four-vをまとめて表示/ }));
    expect(positions()).toEqual(compact);

    await user.click(screen.getByRole("button", { name: "個別表示" }));
    expect(positions()).toEqual(expanded);
    await user.click(screen.getByRole("button", { name: "まとめて表示" }));
    expect(positions()).toEqual(compact);
    await user.click(screen.getByRole("button", { name: /別案 2、完成/ }));
    expect(studio.openPreview).toHaveBeenCalledExactlyOnceWith(variants[1]);
  });

  it("まとまりでも生成状態と表示・削除件数を残し、更新だけでは表示範囲を変えない", async () => {
    const batch = { id: "states", count: 4, deletedCount: 1 };
    const variants = ["running", "failed", "succeeded"].map((status, index) => ({
      ...parent, id: `state-${index}`, prompt: `状態 ${index}`, status,
      batch: { ...batch, index: index + 1 }, references: [],
    })) as ImageSource[];
    const studio = context({ jobs: variants, metadata: { commits: [], branches: [], uploads: [] } });
    const { rerender } = render(view(studio));
    expect(screen.getByText("表示 3 / 4枚 · 削除 1枚")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /状態 0、生成中/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /状態 1、エラー/ })).toBeInTheDocument();
    await waitFor(() => expect(flowMocks.fitView).toHaveBeenCalledTimes(1));
    rerender(view({ ...studio, jobs: variants.map((image) => ({ ...image, status: "succeeded" })) }));
    expect(flowMocks.fitView).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "系統図を検索" }), { target: { value: "状態 0" } });
    expect(screen.getByText("表示 1 / 4枚 · 削除 1枚")).toBeInTheDocument();
    expect(flowMocks.nodes.filter((node) => node.type === "image").map((node) => node.id)).toEqual(["state-0"]);
  });
});
