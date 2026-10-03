import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(studio.openPreview).not.toHaveBeenCalled();
  });

  it.each([
    ["生成画像", child.id, /Target Cabin、完成/],
    ["アップロード画像", uploaded.id, /森林の参照、アップロード/],
  ])(
    "%sの右クリックから削除を選んでも拡大プレビューを開かない",
    async (_, id, name) => {
      const studio = context({ selectedId: source.id, requestDelete: vi.fn() });
      const user = userEvent.setup();
      render(view(studio));
      const node = screen.getByRole("button", { name });
      fireEvent.contextMenu(
        node.querySelector("[data-slot=context-menu-trigger]")!,
      );
      expect(studio.openPreview).not.toHaveBeenCalled();

      await user.click(
        screen.getByRole("menuitem", { name: "画像と下流をゴミ箱へ" }),
      );

      expect(studio.requestDelete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id }),
      );
      expect(studio.openPreview).not.toHaveBeenCalled();
      expect(studio.select).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );

  it("右クリックメニューの拡大プレビューは対象画像を一度だけ開く", async () => {
    const image = {
      ...child,
      image: { url: "/image.png", downloadUrl: "/download.png" },
    };
    const studio = context({ jobs: [image] });
    const user = userEvent.setup();
    render(view(studio));
    const node = screen.getByRole("button", { name: /Target Cabin、完成/ });
    fireEvent.contextMenu(
      node.querySelector("[data-slot=context-menu-trigger]")!,
    );
    await user.click(
      screen.getByRole("menuitem", { name: "拡大プレビュー" }),
    );

    expect(studio.openPreview).toHaveBeenCalledExactlyOnceWith(image);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
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
    const batchNode = flowMocks.nodes.find((node) => node.type === "batch")!;
    expect(
      flowMocks.edges.filter((edge) => edge.target === batchNode.id),
    ).toHaveLength(3);
    expect(
      flowMocks.edges.find(
        (edge) => edge.source === source.id && edge.target === batchNode.id,
      )?.style?.strokeDasharray,
    ).toBe("6 5");
    expect(
      flowMocks.edges.find(
        (edge) => edge.source === uploaded.id && edge.target === batchNode.id,
      )?.style?.strokeDasharray,
    ).toBeUndefined();
    expect(
      flowMocks.nodes.filter((node) => node.type === "batch"),
    ).toHaveLength(1);
    expect(
      screen.getByText("1枚に一致 · 元画像を含め 4枚"),
    ).toBeInTheDocument();
  });

  it("画面へ移った時に読める倍率で系統を表示し、定期更新ではパン・ズームをリセットしない", async () => {
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

  it("共通の参照元・入力元からは枠へ1本ずつ接続し、展開すると各画像への矢印を復元する", async () => {
    const batch = { id: "shared-variants", count: 4 };
    const variants = [1, 2, 3, 4].map((index) => ({
      ...child, id: `shared-${index}`, prompt: `共通の別案 ${index}`, batch: { ...batch, index },
    }));
    const leaf: ImageSource = {
      ...parent, id: "leaf", prompt: "派生画像", references: [{ jobId: variants[1].id, role: "reference" }],
    };
    const studio = context({ jobs: [parent, source, ...variants, leaf], selectedId: variants[3].id });
    const user = userEvent.setup();
    render(view(studio));
    const batchNode = flowMocks.nodes.find((node) => node.type === "batch")!;
    const common = flowMocks.edges.filter((edge) => edge.target === batchNode.id);
    expect(common).toHaveLength(3);
    expect(common.map((edge) => edge.source)).toEqual([parent.id, uploaded.id, source.id]);
    expect(common.every((edge) => edge.style?.strokeWidth === 2)).toBe(true);
    expect(common.find((edge) => edge.source === source.id)?.style?.strokeDasharray).toBe("6 5");
    expect(common.find((edge) => edge.source === parent.id)?.style?.strokeDasharray).toBeUndefined();
    expect(common.every((edge) => edge.ariaLabel?.includes("同時作成 #shared（表示4枚）"))).toBe(true);
    expect(common.every((edge) => (edge.data?.path as string).endsWith(
      `${batchNode.position.x} ${batchNode.position.y + Number(batchNode.style?.height) / 2}`,
    ))).toBe(true);
    expect(flowMocks.edges.filter((edge) => edge.source === variants[1].id && edge.target === leaf.id)).toHaveLength(1);
    expect(flowMocks.edges).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: /同時作成 #sharedを展開/ }));
    expect(flowMocks.edges).toHaveLength(14);
    expect(flowMocks.edges.some((edge) => edge.target === batchNode.id)).toBe(false);
    for (const image of variants) expect(flowMocks.edges.filter((edge) => edge.target === image.id)).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: /同時作成 #sharedをまとめて表示/ }));
    expect(flowMocks.edges).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "個別表示" }));
    expect(flowMocks.edges).toHaveLength(14);
    await user.click(screen.getByRole("button", { name: "まとめて表示" }));
    expect(flowMocks.edges).toHaveLength(5);
  });
  it("12件・6系統の初期表示は最新の系統で、概要から他の系統を選べる", async () => {
    const jobs: ImageSource[] = Array.from({ length: 6 }, (_, index) => [
      { ...parent, id: `root-${index}`, prompt: `系統 ${index}`, references: [], createdAt: `2026-10-02T00:${index}0:00Z` },
      { ...parent, id: `child-${index}`, prompt: `分岐 ${index}`, references: [{ jobId: `root-${index}`, role: "reference" }], createdAt: `2026-10-02T00:${index}1:00Z` },
    ]).flat();
    const studio = context({ jobs, metadata: { commits: [], branches: [], uploads: [] } });
    const user = userEvent.setup();
    const { rerender } = render(view(studio));
    const ids = () => flowMocks.nodes.filter(node => node.type === "image").map(node => node.id);
    expect(ids()).toEqual(["root-5", "child-5"]);
    expect(flowMocks.fitView).toHaveBeenLastCalledWith(expect.objectContaining({ minZoom: 0.75 }));
    const calls = flowMocks.fitView.mock.calls.length;
    rerender(view({ ...studio, jobs: studio.jobs.map(job => ({ ...job })), selectedId: "root-0" }));
    expect(ids()).toEqual(["root-5", "child-5"]);
    expect(flowMocks.fitView).toHaveBeenCalledTimes(calls);
    await user.click(screen.getByRole("button", { name: "選択へ" }));
    expect(ids()).toEqual(["root-0", "child-0"]);
    expect(flowMocks.fitView).toHaveBeenLastCalledWith(expect.objectContaining({ nodes: [{ id: "root-0" }] }));
    await user.click(screen.getByRole("button", { name: "全系統の概要" }));
    expect(ids()).toHaveLength(12);
    expect(screen.getByRole("complementary", { name: "系統の一覧" })).toBeInTheDocument();
    expect(flowMocks.fitView).toHaveBeenLastCalledWith(expect.objectContaining({ minZoom: 0.15 }));
    await user.click(screen.getByRole("button", { name: /系統 0.*2枚/ }));
    expect(ids()).toEqual(["root-0", "child-0"]);
    expect(flowMocks.fitView).toHaveBeenLastCalledWith(expect.objectContaining({ minZoom: 0.75 }));
    fireEvent.change(screen.getByRole("textbox", { name: "系統図を検索" }), { target: { value: "分岐 3" } });
    expect(ids()).toEqual(["root-3", "child-3"]);
  });

  it("選択画像があればその系統を初期表示し、外部から渡された同時作成へも切り替える", () => {
    const other: ImageSource = { ...parent, id: "other", prompt: "別系統", references: [], createdAt: "2026-10-03T00:00:00Z", batch: { id: "other-batch", index: 1, count: 2 } };
    const studio = context({ jobs: [...context().jobs, other], selectedId: child.id });
    const { rerender } = render(view(studio));
    expect(flowMocks.nodes.some(node => node.id === child.id)).toBe(true);
    expect(flowMocks.nodes.some(node => node.id === other.id)).toBe(false);
    rerender(view({ ...studio, graphBatchId: "other-batch" }));
    expect(flowMocks.nodes.filter(node => node.type === "image").map(node => node.id)).toEqual([other.id]);
  });

  it("スマホではリストを初期表示し、失敗状態・参照元・キーボードでの選択を保つ", async () => {
    vi.mocked(window.matchMedia).mockReturnValueOnce({ matches: true } as MediaQueryList);
    const failed = { ...child, status: "failed" } as ImageSource;
    const studio = context({ jobs: [parent, source, failed, peer] });
    const user = userEvent.setup();
    render(view(studio));
    expect(screen.getByRole("button", { name: "リスト" })).toHaveAttribute("aria-pressed", "true");
    const list = screen.getByLabelText("系統ごとの画像リスト");
    expect(list).toHaveTextContent("エラー · 同時作成 1/2");
    expect(list).toHaveTextContent("参照元: 朝の森");
    expect(list).toHaveTextContent("入力元: 入力の起点");
    const target = screen.getByRole("button", { name: "Target Cabinの詳細を開く" });
    target.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "Target Cabinの操作" })).toBeInTheDocument();
    expect(studio.openPreview).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    target.focus();
    await user.keyboard("{Enter}");
    expect(studio.openPreview).toHaveBeenCalledExactlyOnceWith(failed);
    await user.click(screen.getByRole("button", { name: "系統図" }));
    expect(screen.getByRole("button", { name: "系統図" })).toHaveAttribute("aria-pressed", "true");
    expect(flowMocks.fitView).toHaveBeenLastCalledWith(expect.objectContaining({ minZoom: 0.75 }));
  });

  it("検索に一致しない状態と空履歴をリストにも表示する", async () => {
    const studio = context();
    const user = userEvent.setup();
    const { rerender } = render(view(studio));
    await user.click(screen.getByRole("button", { name: "リスト" }));
    fireEvent.change(screen.getByRole("textbox", { name: "系統図を検索" }), { target: { value: "見つからない" } });
    expect(screen.getByLabelText("系統ごとの画像リスト")).toHaveTextContent("条件に合う画像がありません");
    rerender(view(context({ jobs: [], metadata: { commits: [], branches: [], uploads: [] } })));
    expect(screen.getByLabelText("系統ごとの画像リスト")).toHaveTextContent("画像を生成すると、つながりをたどれます。");
    expect(screen.getByRole("button", { name: "全系統の概要" })).toBeDisabled();
  });

  it("系統一覧や画面サイズで描画幅が変わった後に概要図を合わせ直す", async () => {
    let resized: ResizeObserverCallback = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    const user = userEvent.setup();
    render(view(context()));
    await user.click(screen.getByRole("button", { name: "全系統の概要" }));
    const calls = flowMocks.fitView.mock.calls.length;
    act(() => resized([{ contentRect: { width: 1024, height: 650 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(flowMocks.fitView).toHaveBeenCalledTimes(calls + 1);
    expect(flowMocks.fitView).toHaveBeenLastCalledWith(expect.objectContaining({ minZoom: 0.15 }));
    act(() => resized([{ contentRect: { width: 1024, height: 650 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(flowMocks.fitView).toHaveBeenCalledTimes(calls + 1);
  });

});
