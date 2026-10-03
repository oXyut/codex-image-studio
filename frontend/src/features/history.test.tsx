import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { HistoryView } from "./history";
import { ApiError } from "@/lib/api";

afterEach(cleanup);
function job(id: string, extra: Partial<ImageSource> = {}): ImageSource {
  return {
    id,
    status: "succeeded",
    createdAt: "2026-10-02T06:25:00Z",
    prompt: id,
    image: {
      url: `/images/${id}.png`,
      downloadUrl: `/images/${id}.png?download=1`,
    },
    ...extra,
  };
}
function studio(jobs: ImageSource[]): StudioContextValue {
  return {
    jobs,
    uploads: [],
    loading: false,
    draft: { count: 1 },
    metadata: { commits: [], branches: [], uploads: [] },
    view: "history",
    selectedId: null,
    select: vi.fn(),
    openPreview: vi.fn(),
    navigate: vi.fn(),
    addReference: vi.fn().mockReturnValue(true),
    openTrash: vi.fn(),
    api: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    setFavorite: vi.fn().mockResolvedValue(undefined),
    favoritePendingIds: [],
    run: vi.fn(async (action) => { await action(); }),
  } as unknown as StudioContextValue;
}

describe("生成履歴", () => {
  it("検索領域をキーボードで開き、閉じても検索とお気に入り条件を保持して解除できる", async () => {
    const context = studio([job("森の朝", { favorite: true }), job("森の夜"), job("海", { favorite: true })]);
    const user = userEvent.setup();
    render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    const toggle = screen.getByRole("button", { name: /検索・絞り込み/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    await user.keyboard("{Enter}");
    const search = screen.getByRole("searchbox", { name: "履歴を検索" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(search).toHaveFocus();
    await user.type(search, "森");
    await user.click(screen.getByRole("button", { name: "お気に入りのみ" }));
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("検索・絞り込み（2）");
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("1枚を表示 / 全3枚");
    expect(screen.getByRole("button", { name: "森の朝を選択" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "森の夜を選択" })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(search).toHaveValue("森");
    expect(screen.getByRole("button", { name: "お気に入りのみ" })).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "条件を解除" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: "森の夜を選択" })).toBeInTheDocument();
    expect(toggle).not.toHaveTextContent("（");
    expect(context.api).not.toHaveBeenCalled();
  });

  it("履歴の操作メニューをキーボードで開閉し、ゴミ箱と削除確認へ移れる", async () => {
    const context = studio([job("失敗", { status: "failed", image: undefined })]);
    vi.mocked(context.api).mockResolvedValue({ planToken: "confirmed", count: 1, nodes: [{ id: "失敗", title: "失敗" }] });
    const user = userEvent.setup();
    render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    const trigger = screen.getByRole("button", { name: "履歴の操作" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "エラー画像を一括削除（1件）" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "ゴミ箱" }));
    expect(context.openTrash).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "エラー画像を一括削除（1件）" }));
    expect(await screen.findByText("削除対象：エラー画像 1件")).toBeInTheDocument();
    expect(context.api).toHaveBeenCalledOnce();
    expect(context.api).toHaveBeenCalledWith("/api/jobs/failed/deletion-preview");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "エラー画像を一括削除（1件）" })).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("空の履歴でも検索を開閉でき、操作メニューの一括削除は無効になる", async () => {
    const context = studio([]);
    const user = userEvent.setup();
    render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    expect(screen.getByText("生成した画像がここに並びます")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /検索・絞り込み/ }));
    await user.type(screen.getByRole("searchbox", { name: "履歴を検索" }), "見つからない");
    await user.click(screen.getByRole("button", { name: /検索・絞り込み/ }));
    expect(screen.getByText("一致する履歴がありません")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "条件を解除" }));
    await user.click(screen.getByRole("button", { name: "履歴の操作" }));
    expect(screen.getByRole("menuitem", { name: "エラー画像を一括削除（0件）" })).toHaveAttribute("data-disabled");
  });

  it("別のカードを右クリックしても詳細を開かず、そのカードを参照に追加する", async () => {
    const first = job("最初の画像"),
      target = job("右クリックした画像");
    const context = studio([first, target]);
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={context}>
        <HistoryView />
      </StudioContext.Provider>,
    );
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "右クリックした画像を選択" }),
    );
    expect(context.select).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: "参照に追加" }));
    expect(context.addReference).toHaveBeenCalledWith(target);
    expect(context.select).not.toHaveBeenCalled();
  });


  it("エラーだけの件数を表示し、絞り込み中でも履歴全体の対象を確認して手動で削除する", async () => {
    const failed = job("失敗", { status: "failed", image: undefined });
    const otherFailed = job("別の失敗", { status: "failed", image: undefined });
    const complete = job("完成画像");
    const context = studio([failed, otherFailed, complete, job("停止", { status: "cancelled", image: undefined })]);
    context.selectedId = failed.id;
    const plan = { planToken: "confirmed", count: 2, nodes: [failed, otherFailed].map((source) => ({ ...source, title: source.prompt })) };
    vi.mocked(context.api).mockResolvedValueOnce(plan).mockResolvedValueOnce({ deletedIds: [failed.id, otherFailed.id], count: 2 });
    const user = userEvent.setup();
    const { rerender } = render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    expect(context.api).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "完成" }));
    await user.click(screen.getByRole("button", { name: "エラー画像を一括削除（2件）" }));
    const dialog = screen.getByRole("dialog", { name: "エラー画像を一括削除" });
    expect(await within(dialog).findByText("削除対象：エラー画像 2件")).toBeInTheDocument();
    expect(within(dialog).getByText("別の失敗")).toBeInTheDocument();
    expect(within(dialog).queryByText("完成画像")).not.toBeInTheDocument();
    expect(context.api).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: "2件をゴミ箱に移動" }));
    expect(context.api).toHaveBeenLastCalledWith("/api/jobs/failed", { method: "DELETE", body: JSON.stringify({ planToken: "confirmed" }) });
    expect(context.refresh).toHaveBeenCalledTimes(1);
    expect(context.select).toHaveBeenCalledWith(null);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    rerender(<StudioContext.Provider value={{ ...context, jobs: [complete], selectedId: null }}><HistoryView /></StudioContext.Provider>);
    expect(screen.getByRole("button", { name: "エラー画像を一括削除（0件）" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "完成画像を選択" })).toBeInTheDocument();
  });

  it("一括削除をキャンセルすると削除せず、対象のない履歴ではボタンを無効にする", async () => {
    const context = studio([job("失敗", { status: "failed", image: undefined })]);
    vi.mocked(context.api).mockResolvedValue({ planToken: "confirmed", count: 1, nodes: [{ id: "失敗", title: "失敗" }] });
    const user = userEvent.setup();
    const { rerender } = render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    await user.click(screen.getByRole("button", { name: "エラー画像を一括削除（1件）" }));
    await screen.findByText("削除対象：エラー画像 1件");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "キャンセル" }));
    expect(context.api).toHaveBeenCalledTimes(1); expect(context.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "失敗を選択" })).toBeInTheDocument();
    rerender(<StudioContext.Provider value={{ ...context, loading: true }}><HistoryView /></StudioContext.Provider>);
    expect(screen.getByRole("button", { name: "エラー画像を一括削除（1件）" })).toBeDisabled();
    rerender(<StudioContext.Provider value={{ ...context, jobs: [job("停止", { status: "cancelled", image: undefined })] }}><HistoryView /></StudioContext.Provider>);
    expect(screen.getByRole("button", { name: "エラー画像を一括削除（0件）" })).toBeDisabled();
  });

  it("対象が増えたら一覧を更新し、再確認後のクリックで新しいトークンを送る", async () => {
    const context = studio([job("失敗", { status: "failed", image: undefined })]);
    vi.mocked(context.api)
      .mockResolvedValueOnce({ planToken: "before", count: 1, nodes: [{ id: "one", title: "失敗" }] })
      .mockRejectedValueOnce(new ApiError("変更あり", "DELETE_PLAN_CHANGED", 409))
      .mockResolvedValueOnce({ planToken: "after", count: 2, nodes: [{ id: "one", title: "失敗" }, { id: "two", title: "新しい失敗" }] })
      .mockResolvedValueOnce({ deletedIds: ["one", "two"], count: 2 });
    const user = userEvent.setup();
    render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    await user.click(screen.getByRole("button", { name: "エラー画像を一括削除（1件）" }));
    await user.click(await screen.findByRole("button", { name: "1件をゴミ箱に移動" }));
    expect(await screen.findByText("削除対象：エラー画像 2件")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("もう一度削除してください");
    expect(context.api).toHaveBeenCalledTimes(3); expect(context.refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "2件をゴミ箱に移動" }));
    expect(context.api).toHaveBeenLastCalledWith("/api/jobs/failed", { method: "DELETE", body: JSON.stringify({ planToken: "after" }) });
    expect(context.select).not.toHaveBeenCalled();
  });

  it("対象の取得に失敗したら削除を無効にし、再読み込みで復帰できる", async () => {
    const context = studio([job("失敗", { status: "failed", image: undefined })]);
    vi.mocked(context.api).mockRejectedValueOnce(new Error("取得できませんでした"))
      .mockResolvedValueOnce({ planToken: "confirmed", count: 0, nodes: [] });
    const user = userEvent.setup();
    render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    await user.click(screen.getByRole("button", { name: "エラー画像を一括削除（1件）" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("取得できませんでした");
    expect(screen.getByRole("button", { name: "0件をゴミ箱に移動" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "再読み込み" }));
    expect(await screen.findByText("削除するエラー画像はありません。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "0件をゴミ箱に移動" })).toBeDisabled();
    expect(context.api).toHaveBeenCalledTimes(2);
  });

  it("カードの星からお気に入りを変更しても画像選択や参照追加を行わない", async () => {
    const source = job("森の家");
    const context = studio([source]);
    const user = userEvent.setup();
    render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    await user.click(screen.getByRole("button", { name: "森の家をお気に入りに追加" }));
    expect(context.setFavorite).toHaveBeenCalledWith(source, true);
    expect(context.select).not.toHaveBeenCalled();
    expect(context.openPreview).not.toHaveBeenCalled();
    expect(context.addReference).not.toHaveBeenCalled();
  });

  it("お気に入りと検索を併用し、解除後も同時作成の全件数を保つ", async () => {
    const first = job("森の朝", { favorite: true, batch: { id: "forest", index: 1, count: 2 } });
    const second = job("森の夕方", { favorite: false, batch: { id: "forest", index: 2, count: 2 } });
    const night = job("夜", { favorite: true });
    const context = studio([first, second, night]);
    const user = userEvent.setup();
    const { rerender } = render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    await user.click(screen.getByRole("button", { name: "お気に入りのみ" }));
    expect(screen.getByRole("button", { name: "お気に入りのみ" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "森の夕方を選択" })).not.toBeInTheDocument();
    expect(screen.getByText("表示 1枚 / 保存 2枚")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "履歴を検索" }), "森");
    expect(screen.queryByRole("button", { name: "夜を選択" })).not.toBeInTheDocument();
    rerender(<StudioContext.Provider value={{ ...context, jobs: [{ ...first, favorite: false }, second, night] }}><HistoryView /></StudioContext.Provider>);
    expect(screen.getByText("一致する履歴がありません")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "絞り込みを解除" }));
    expect(screen.getByRole("button", { name: "お気に入りのみ" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "森の夕方を選択" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "履歴を検索" })).toHaveValue("");
  });

  it("画像を1回クリックすると共通プレビューを開き、参照追加は独立して操作する", async () => {
    const source = job("森の家");
    const context = studio([source]);
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={context}>
        <HistoryView />
      </StudioContext.Provider>,
    );
    await user.click(screen.getByRole("button", { name: "森の家を選択" }));
    expect(context.openPreview).toHaveBeenCalledExactlyOnceWith(source);
    expect(context.select).not.toHaveBeenCalled();
    expect(context.addReference).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "森の家を参照に追加" }),
    );
    expect(context.addReference).toHaveBeenCalledWith(source);
  });

  it("画像のない生成中・失敗履歴も共通ビューアへ渡し、詳細を別UIに表示しない", async () => {
    const source = job("失敗した画像", { status: "failed", image: undefined });
    const context = studio([source]);
    const user = userEvent.setup();
    render(<StudioContext.Provider value={context}><HistoryView /></StudioContext.Provider>);
    await user.click(screen.getByRole("button", { name: "失敗した画像を選択" }));
    expect(context.openPreview).toHaveBeenCalledExactlyOnceWith(source);
    expect(screen.queryByRole("complementary", { name: "選択した画像の詳細" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("メモの検索と完成フィルターを組み合わせる", async () => {
    const context = studio([
      job("晴れ", { lineage: { notes: "柔らかい 光" } }),
      job("雨", {
        lineage: { notes: "柔らかい影" },
        status: "running",
        image: undefined,
      }),
      job("夜"),
    ]);
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={context}>
        <HistoryView />
      </StudioContext.Provider>,
    );
    await user.type(
      screen.getByRole("searchbox", { name: "履歴を検索" }),
      "柔らかい",
    );
    expect(
      screen.getByRole("button", { name: "晴れを選択" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "雨を選択" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "夜を選択" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(
      screen.getByRole("button", { name: "晴れを選択" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "雨を選択" }),
    ).not.toBeInTheDocument();
  });

  it("バッチは番号順に並べ、絞り込み後も保存数・全件数・削除・未受付を保持する", async () => {
    const context = studio([
      job("三枚目", {
        batch: { id: "first-batch", index: 3, count: 5, deletedCount: 1 },
      }),
      job("一枚目", {
        batch: { id: "first-batch", index: 1, count: 5, deletedCount: 1 },
        status: "running",
        image: undefined,
      }),
      job("別の同時作成", { batch: { id: "batch-two", index: 1, count: 2 } }),
    ]);
    const user = userEvent.setup();
    render(
      <StudioContext.Provider value={context}>
        <HistoryView />
      </StudioContext.Provider>,
    );
    const group = screen.getByRole("region", { name: "同時作成 #first-" });
    const choices = within(group).getAllByRole("button", { name: /を選択/ });
    expect(choices[0]).toHaveAccessibleName("一枚目を選択");
    expect(choices[1]).toHaveAccessibleName("三枚目を選択");
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(within(group).getByText("同時作成 · 5枚")).toBeInTheDocument();
    expect(within(group).getByText("表示 1枚 / 保存 2枚")).toBeInTheDocument();
    expect(within(group).getByText("削除 1枚")).toBeInTheDocument();
    expect(within(group).getByText("未受付 2枚")).toBeInTheDocument();
  });
});
