import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { HistoryView } from "./history";

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
    metadata: { commits: [], branches: [], uploads: [] },
    view: "history",
    selectedId: null,
    select: vi.fn(),
    openPreview: vi.fn(),
    navigate: vi.fn(),
    addReference: vi.fn().mockReturnValue(true),
    openTrash: vi.fn(),
    setFavorite: vi.fn().mockResolvedValue(undefined),
    favoritePendingIds: [],
    run: vi.fn(async (action) => { await action(); }),
  } as unknown as StudioContextValue;
}

describe("生成履歴", () => {
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
