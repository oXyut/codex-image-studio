import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageActions, ImageContextMenu, ImageFavoriteButton } from "./image-actions";
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
    recentGenerationIds: [],
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
    setFavorite: vi.fn().mockResolvedValue(undefined),
    favoritePendingIds: [],
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
  it("お気に入りを追加・解除し、保存中は同じ画像の操作を無効にする", async () => {
    const studio = context({ health: { ready: false, message: "未接続" } });
    const user = userEvent.setup();
    const { rerender } = render(
      <StudioContext.Provider value={studio}>
        <ImageActions source={image} />
      </StudioContext.Provider>,
    );
    const add = screen.getByRole("button", {
      name: "朝霧の森の家をお気に入りに追加",
    });
    expect(add).toHaveAttribute("aria-pressed", "false");
    await user.click(add);
    expect(studio.setFavorite).toHaveBeenCalledWith(image, true);
    expect(studio.addReference).not.toHaveBeenCalled();
    expect(studio.replaceFromSource).not.toHaveBeenCalled();
    const favorite = { ...image, favorite: true };
    rerender(
      <StudioContext.Provider value={studio}>
        <ImageActions source={favorite} />
      </StudioContext.Provider>,
    );
    const remove = screen.getByRole("button", {
      name: "朝霧の森の家をお気に入りから外す",
    });
    expect(remove).toHaveAttribute("aria-pressed", "true");
    await user.click(remove);
    expect(studio.setFavorite).toHaveBeenLastCalledWith(favorite, false);
    rerender(
      <StudioContext.Provider
        value={{ ...studio, favoritePendingIds: [image.id] }}
      >
        <ImageActions source={favorite} />
      </StudioContext.Provider>,
    );
    expect(remove).toBeDisabled();
  });

  it.each(["queued", "running", "failed", "cancelled", "uploaded"])(
    "%sの画像にはお気に入り操作を表示しない",
    (status) => {
      render(
        <StudioContext.Provider value={context()}>
          <ImageFavoriteButton
            source={{
              ...image,
              status,
              ...(status === "uploaded" ? { kind: "upload" as const } : {}),
            }}
          />
        </StudioContext.Provider>,
      );
      expect(
        screen.queryByRole("button", { name: /お気に入り/ }),
      ).not.toBeInTheDocument();
    },
  );

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
        code: "CONTENT_REVIEW",
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
    expect(
      screen.getAllByRole("button", { name: "画像のその他の操作" }),
    ).toHaveLength(1);
    await user.click(screen.getByText("エラーの詳細"));
    expect(screen.getByText(/CONTENT_REVIEW\s+保存された診断情報/)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "内容を編集して再試行" }),
    );
    expect(studio.replaceFromSource).toHaveBeenCalledWith(failed);
    expect(studio.retry).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "画像のその他の操作" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "画像と下流をゴミ箱へ" }),
    );
    expect(studio.requestDelete).toHaveBeenCalledExactlyOnceWith(failed);
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

describe("画像の右クリック操作", () => {
  function renderMenu(studio: StudioContextValue, source = image) {
    return render(
      <StudioContext.Provider value={studio}>
        <ImageContextMenu source={source}>
          <button onClick={() => studio.select(source.id)}>対象画像</button>
        </ImageContextMenu>
      </StudioContext.Provider>,
    );
  }

  it.each([
    ["拡大プレビュー", "openPreview", [image]],
    ["参照に追加", "addReference", [image]],
    ["お気に入りに追加", "setFavorite", [image, true]],
    ["この画像を参照して編集", "replaceFromSource", [image, true]],
    ["元の入力に置き換えて編集", "replaceFromSource", [image]],
    ["元の設定で4枚を今すぐ生成", "retry", [image]],
    ["画像と下流をゴミ箱へ", "requestDelete", [image]],
    ["系統図で見る", "navigate", ["lineage", image.id, ""]],
  ] as const)(
    "%sは選択中の画像ではなく右クリックした対象へ実行する",
    async (label, action, args) => {
      const studio = context({ selectedId: "別の画像" });
      const user = userEvent.setup();
      renderMenu(studio);
      fireEvent.contextMenu(screen.getByRole("button", { name: "対象画像" }), {
        clientX: 200,
        clientY: 150,
      });
      const menu = await screen.findByRole("menu", {
        name: "朝霧の森の家の操作",
      });
      expect(menu).toBeVisible();
      expect(studio.select).not.toHaveBeenCalled();
      expect(studio.retry).not.toHaveBeenCalled();
      expect(studio.requestDelete).not.toHaveBeenCalled();
      expect(
        screen.getByRole("menuitem", { name: "画像をダウンロード" }),
      ).toHaveAttribute("href", image.image!.downloadUrl);
      await user.click(screen.getByRole("menuitem", { name: label }));
      expect(studio[action]).toHaveBeenCalledWith(...args);
      expect(studio.select).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );

  it.each(["running", "queued"])(
    "%sでは停止でき、未完成の画像を参照・再生成できない",
    async (status) => {
      const source = { ...image, image: undefined, status };
      const studio = context();
      const user = userEvent.setup();
      renderMenu(studio, source);
      fireEvent.contextMenu(screen.getByRole("button", { name: "対象画像" }));
      expect(
        screen.queryByRole("menuitem", { name: "参照に追加" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("menuitem", { name: /お気に入り/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: /今すぐ生成/ }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByRole("menuitem", { name: "この画像を参照して編集" }),
      ).toHaveAttribute("aria-disabled", "true");
      await user.click(screen.getByRole("menuitem", { name: "生成を停止" }));
      expect(studio.cancel).toHaveBeenCalledWith(source);
      expect(studio.retry).not.toHaveBeenCalled();
    },
  );

  it("未接続・送信中・お気に入り保存中の操作制限を引き継ぐ", () => {
    const studio = context({
      health: { ready: false, message: "" },
      favoritePendingIds: [image.id],
    });
    const { rerender } = renderMenu(studio);
    fireEvent.contextMenu(screen.getByRole("button", { name: "対象画像" }));
    expect(
      screen.getByRole("menuitem", { name: /今すぐ生成/ }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: "お気に入りに追加" }),
    ).toHaveAttribute("aria-disabled", "true");
    rerender(
      <StudioContext.Provider
        value={{
          ...studio,
          health: { ready: true, message: "" },
          submitting: true,
        }}
      >
        <ImageContextMenu source={image}>
          <button>対象画像</button>
        </ImageContextMenu>
      </StudioContext.Provider>,
    );
    expect(
      screen.getByRole("menuitem", { name: /今すぐ生成/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("アップロード起点では参照・ダウンロード・削除を使え、生成専用の操作を出さない", () => {
    const upload = { ...image, kind: "upload" as const, status: "uploaded" };
    renderMenu(context(), upload);
    fireEvent.contextMenu(screen.getByRole("button", { name: "対象画像" }));
    expect(
      screen.getByRole("menuitem", { name: "参照に追加" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "画像と下流をゴミ箱へ" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", {
        name: /今すぐ生成|お気に入り|元の入力に/,
      }),
    ).not.toBeInTheDocument();
  });

  it("通常クリックを保ち、Shift+F10とメニューキーで開いてキーボードで閉じられる", async () => {
    const studio = context();
    const user = userEvent.setup();
    renderMenu(studio);
    const target = screen.getByRole("button", { name: "対象画像" });
    await user.click(target);
    expect(studio.select).toHaveBeenCalledExactlyOnceWith(image.id);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(target).toHaveFocus());
    fireEvent.keyDown(target, { key: "ContextMenu" });
    await user.keyboard("{ArrowDown}{Home}{Enter}");
    expect(studio.openPreview).toHaveBeenCalledWith(image);
  });
});
