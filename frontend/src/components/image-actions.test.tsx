import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { ImageActions } from "./image-actions";
import { ImageInspector } from "./image-inspector";

afterEach(cleanup);
const image: ImageSource = {
  id: "image-1",
  status: "succeeded",
  createdAt: "2026-10-02T06:25:00Z",
  prompt: "森の家",
  size: "landscape",
  image: { url: "/images/1.png", downloadUrl: "/images/1.png?download=1" },
  lineage: { title: "朝霧の森の家", notes: "やわらかい光" },
};
function context(
  overrides: Partial<StudioContextValue> = {},
): StudioContextValue {
  return {
    api: vi.fn().mockResolvedValue({}),
    jobs: [image],
    uploads: [],
    templates: [],
    metadata: { commits: [], branches: [], uploads: [] },
    health: { ready: true, message: "" },
    loading: false,
    loadingError: "",
    refresh: vi.fn().mockResolvedValue(undefined),
    refreshHealth: vi.fn().mockResolvedValue(undefined),
    draft: {
      prompt: "制作中の文章",
      count: 4,
      layers: [],
      references: [],
      size: "auto",
      style: "auto",
      transparent: false,
      lineageContext: null,
    },
    updateDraft: vi.fn(),
    canUndo: false,
    undoDraft: vi.fn(),
    draftSaved: true,
    view: "history",
    navigate: vi.fn(),
    selectedId: image.id,
    select: vi.fn(),
    graphBatchId: "",
    setGraphBatchId: vi.fn(),
    addReference: vi.fn().mockReturnValue(true),
    addTemplate: vi.fn().mockReturnValue(true),
    replaceFromSource: vi.fn(),
    applyExample: vi.fn(),
    generate: vi.fn().mockResolvedValue(undefined),
    submitting: false,
    retry: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    openPreview: vi.fn(),
    requestDelete: vi.fn(),
    openTrash: vi.fn(),
    run: vi.fn(async (action) => {
      await action();
    }),
    ...overrides,
  };
}

describe("共有画像操作", () => {
  it("参照追加、画像を起点とする編集、元入力の復元を別々の操作として扱う", async () => {
    const studio = context();
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={studio}>
        <ImageActions source={image} />
      </StudioContext.Provider>,
    );
    await user.click(screen.getByRole("button", { name: "参照に追加" }));
    expect(studio.addReference).toHaveBeenCalledWith(image);
    expect(studio.replaceFromSource).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "この画像を参照して編集" }),
    );
    expect(studio.replaceFromSource).toHaveBeenLastCalledWith(image, true);
    await user.click(
      screen.getByRole("button", { name: "元の入力に置き換えて編集" }),
    );
    expect(studio.replaceFromSource).toHaveBeenLastCalledWith(image);
    expect(
      screen.getByRole("link", { name: "画像をダウンロード" }),
    ).toHaveAttribute("href", image.image!.downloadUrl);
  });

  it("即時再生成のラベルに現在の制作枚数を明示し、その操作だけでAPI処理を行う", async () => {
    const studio = context();
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={studio}>
        <ImageActions source={image} compact />
      </StudioContext.Provider>,
    );
    await user.click(
      screen.getByRole("button", { name: "画像のその他の操作" }),
    );
    const regenerate = await screen.findByRole("menuitem", {
      name: "元の設定で4枚を今すぐ生成",
    });
    expect(studio.retry).not.toHaveBeenCalled();
    await user.click(regenerate);
    expect(studio.retry).toHaveBeenCalledWith(image);
    expect(studio.replaceFromSource).not.toHaveBeenCalled();
  });

  it("接続の準備ができていない間は即時再生成を受け付けない", async () => {
    const studio = context({ health: { ready: false, message: "未接続" } });
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={studio}>
        <ImageActions source={image} compact />
      </StudioContext.Provider>,
    );
    await user.click(
      screen.getByRole("button", { name: "画像のその他の操作" }),
    );
    expect(
      await screen.findByRole("menuitem", {
        name: "元の設定で4枚を今すぐ生成",
      }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("アップロード画像には元入力復元と再生成を提示しない", async () => {
    const upload: ImageSource = {
      ...image,
      kind: "upload",
      status: "uploaded",
      name: "参照写真",
    };
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={context({ jobs: [], uploads: [upload] })}>
        <ImageActions source={upload} compact />
      </StudioContext.Provider>,
    );
    await user.click(
      screen.getByRole("button", { name: "画像のその他の操作" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "元の入力に置き換えて編集" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /今すぐ生成/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "この画像を参照して編集" }),
    ).toBeInTheDocument();
  });
});

describe("画像詳細", () => {
  it("履歴では参照追加と元入力復元を常設し、起点編集をその他の操作にまとめる", async () => {
    const studio = context();
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={studio}>
        <ImageInspector source={image} mode="history" />
      </StudioContext.Provider>,
    );
    expect(
      screen.getByRole("button", { name: "参照に追加" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "元の入力に置き換えて編集" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "この画像を参照して編集" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "画像のその他の操作" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "元の入力に置き換えて編集" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: "この画像を参照して編集" }),
    );
    expect(studio.replaceFromSource).toHaveBeenCalledWith(image, true);
    expect(studio.addReference).not.toHaveBeenCalled();
  });

  it("系統図では起点編集と参照追加を常設し、元入力復元をその他の操作にまとめる", async () => {
    const studio = context();
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={studio}>
        <ImageInspector source={image} mode="lineage" />
      </StudioContext.Provider>,
    );
    expect(
      screen.getByRole("button", { name: "参照に追加" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "この画像を参照して編集" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "元の入力に置き換えて編集" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "画像のその他の操作" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "この画像を参照して編集" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: "元の入力に置き換えて編集" }),
    );
    expect(studio.replaceFromSource).toHaveBeenCalledWith(image);
    expect(studio.addReference).not.toHaveBeenCalled();
  });

  it("失敗の内容と保存された詳細を表示し、編集操作では再生成しない", async () => {
    const failed: ImageSource = {
      ...image,
      image: undefined,
      status: "failed",
      error: {
        message: "内容を確認してください",
        advice: "文章を見直してから再試行できます。",
      },
      errorDetails: "保存された診断情報",
    };
    const studio = context({ jobs: [failed] });
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={studio}>
        <ImageInspector source={failed} />
      </StudioContext.Provider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "内容を確認してください",
    );
    await user.click(screen.getByText("エラーの詳細"));
    expect(screen.getByText("保存された診断情報")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "内容を編集して再試行" }),
    );
    expect(studio.replaceFromSource).toHaveBeenCalledWith(failed);
    expect(studio.retry).not.toHaveBeenCalled();
  });

  it("タイトルとメモは画像の管理欄から同じ画像に保存する", async () => {
    const studio = context();
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={studio}>
        <ImageInspector source={image} />
      </StudioContext.Provider>,
    );
    await user.click(screen.getByRole("button", { name: "タイトル・メモ" }));
    const title = screen.getByLabelText("タイトル");
    const notes = screen.getByLabelText("メモ");
    await user.clear(title);
    await user.type(title, "夕暮れの森");
    await user.clear(notes);
    await user.type(notes, "暖色で検討");
    await user.click(
      screen.getByRole("button", { name: "タイトルとメモを保存" }),
    );
    expect(studio.api).toHaveBeenCalledWith("/api/lineage/jobs/image-1", {
      method: "PATCH",
      body: JSON.stringify({ title: "夕暮れの森", notes: "暖色で検討" }),
    });
    expect(studio.refresh).toHaveBeenCalled();
  });
});
