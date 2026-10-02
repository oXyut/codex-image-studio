import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

vi.mock("@/components/image-inspector", () => ({
  ImageInspector: ({
    source,
    onClose,
  }: {
    source: ImageSource;
    onClose?: () => void;
  }) => (
    <div>
      <p>選択中: {source.id}</p>
      <button onClick={onClose}>画像の詳細を閉じる</button>
    </div>
  ),
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

let wideScreen = false;
let changeScreen: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  wideScreen = false;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    get matches() {
      return wideScreen;
    },
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_, listener) => {
      changeScreen = listener as () => void;
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
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
    wideScreen = true;
    const cyclic = { ...parent, lineage: { parentIds: [child.id, "missing"] } };
    const studio = context({
      jobs: [cyclic, source, child],
      selectedId: uploaded.id,
    });
    render(view(studio));
    expect(screen.getByText(`選択中: ${uploaded.id}`)).toBeInTheDocument();
    expect(screen.getByText(/元画像が見つかりません/)).toBeInTheDocument();
    expect(screen.getByText(/循環する履歴/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Target Cabin、完成/ }));
    expect(studio.select).toHaveBeenCalledWith(child.id);
  });

  it("狭い画面では画像を選ぶと詳細をダイアログに表示し、閉じると選択を解除する", () => {
    const studio = context();
    const { rerender } = render(view(studio));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "選択した画像の詳細" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Target Cabin、完成/ }));
    expect(studio.select).toHaveBeenCalledWith(child.id);
    rerender(view({ ...studio, selectedId: child.id }));
    const details = screen.getByRole("dialog", { name: "選択した画像の詳細" });
    expect(within(details).getByText(`選択中: ${child.id}`)).toBeInTheDocument();

    rerender(view({ ...studio, selectedId: peer.id }));
    expect(within(details).getByText(`選択中: ${peer.id}`)).toBeInTheDocument();
    fireEvent.click(
      within(details).getByRole("button", { name: "画像の詳細を閉じる" }),
    );
    expect(studio.select).toHaveBeenLastCalledWith(null);
    rerender(view(studio));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("広い画面では右側に詳細を表示し、画面幅を変えても選択を保って表示を切り替える", () => {
    wideScreen = true;
    const studio = context({ selectedId: child.id });
    render(view(studio));
    const details = screen.getByRole("complementary", {
      name: "選択した画像の詳細",
    });
    expect(within(details).getByText(`選択中: ${child.id}`)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      wideScreen = false;
      changeScreen();
    });
    expect(
      screen.queryByRole("complementary", { name: "選択した画像の詳細" }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByText(`選択中: ${child.id}`),
    ).toBeInTheDocument();

    act(() => {
      wideScreen = true;
      changeScreen();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("complementary", { name: "選択した画像の詳細" }),
      ).getByText(`選択中: ${child.id}`),
    ).toBeInTheDocument();
    expect(studio.select).not.toHaveBeenCalled();
  });

  it("狭い画面の詳細はEscapeで閉じられる", () => {
    const studio = context({ selectedId: uploaded.id });
    render(view(studio));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(studio.select).toHaveBeenCalledWith(null);
  });

  it("別画面では詳細を開かず、系統図へ戻ると選択済みの画像を表示する", () => {
    const studio = context({ selectedId: child.id, view: "history" });
    const { rerender } = render(view(studio));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(view({ ...studio, view: "lineage" }));
    expect(
      within(screen.getByRole("dialog")).getByText(`選択中: ${child.id}`),
    ).toBeInTheDocument();
    rerender(view(studio));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(studio.select).not.toHaveBeenCalled();
  });
});
