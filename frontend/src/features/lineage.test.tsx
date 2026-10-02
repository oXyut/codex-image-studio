import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
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
    ReactFlow: ({
      nodes,
      edges,
      onInit,
      onNodeClick,
    }: {
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
          {nodes
            .filter((node) => node.type === "image")
            .map((node) => (
              <button
                className="react-flow__node-image"
                data-id={node.id}
                key={node.id}
                aria-label={node.ariaLabel}
                onClick={(event) => onNodeClick(event, node)}
              >
                {node.id}
              </button>
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
});
