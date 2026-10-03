import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { CreateView } from "./create";
import { emptyDraft, sourceDraft } from "@/lib/draft";
import { useState } from "react";

vi.mock("./templates", () => ({ TemplatePicker: () => null }));
vi.mock("@/components/reference-picker", () => ({
  ReferencePicker: () => null,
}));
afterEach(cleanup);

const completed: ImageSource = {
  id: "completed",
  prompt: "森の家",
  status: "succeeded",
  createdAt: "2026-10-02T06:25:00Z",
  image: {
    url: "/images/completed.png",
    downloadUrl: "/images/completed.png?download=1",
  },
  batch: { id: "forest-batch", index: 1, count: 3 },
};
function context(
  overrides: Partial<StudioContextValue> = {},
): StudioContextValue {
  return {
    jobs: [completed],
    uploads: [],
    draft: {
      prompt: "制作中の文章",
      layers: [],
      references: [],
      count: 3,
      size: "auto",
      style: "auto",
      transparent: false,
      lineageContext: null,
    },
    selectedId: completed.id,
    recentGenerationIds: [],
    health: { ready: true, message: "" },
    submitting: false,
    draftSaved: true,
    canUndo: false,
    select: vi.fn(),
    updateDraft: vi.fn(),
    navigate: vi.fn(),
    openPreview: vi.fn(),
    replaceFromSource: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
    favoritePendingIds: [],
    run: vi.fn(async (action) => {
      await action();
    }),
    ...overrides,
  } as unknown as StudioContextValue;
}
function renderView(studio: StudioContextValue) {
  return render(
    <StudioContext.Provider value={studio}>
      <CreateView onSaveTemplate={vi.fn()} />
    </StudioContext.Provider>,
  );
}

describe("制作画面の生成結果", () => {
  it("空の下書きでも最新の履歴の出所とタイトルを表示する", () => {
    renderView(context({ selectedId: null, draft: emptyDraft }));
    expect(screen.getByRole("heading", { name: "最新の履歴" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "森の家" })).toBeVisible();
    expect(screen.getByText(/現在の下書きと生成時の入力は異なります/)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "今回の生成結果" })).not.toBeInTheDocument();
  });

  it("失敗の入力を読戻して別の成功履歴を選んでも、出所と元入力を確認できる", async () => {
    const failed: ImageSource = { ...completed, id: "failed-recipe", prompt: "失敗時の別の入力", status: "failed", image: null, batch: undefined };
    const studio = context({ draft: sourceDraft(emptyDraft, failed), jobs: [completed, failed] });
    const user = userEvent.setup();
    renderView(studio);
    expect(screen.getByRole("heading", { name: "選択中の履歴" })).toBeVisible();
    expect(screen.getByText(/現在の下書きと生成時の入力は異なります/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "プロンプト" })).toHaveValue(failed.prompt);
    const summary = screen.getByText("この履歴の元の入力を確認");
    await user.click(summary);
    const details = summary.closest("details")!;
    expect(details).toHaveAttribute("open");
    expect(within(details).getByText("森の家")).toBeVisible();
    expect(studio.updateDraft).not.toHaveBeenCalled();
    expect(studio.replaceFromSource).not.toHaveBeenCalled();
  });

  it("同じ入力の履歴も新しい生成結果とは呼ばず、編集後は入力の違いを示す", () => {
    const studio = context({ draft: sourceDraft(emptyDraft, completed) });
    const rendered = renderView(studio);
    expect(screen.getByRole("heading", { name: "選択中の履歴" })).toBeVisible();
    expect(screen.getByText(/現在の下書きと生成時の入力は同じです/)).toBeVisible();
    rendered.rerender(<StudioContext.Provider value={{ ...studio, draft: { ...studio.draft, transparent: true } }}><CreateView onSaveTemplate={vi.fn()} /></StudioContext.Provider>);
    expect(screen.getByText(/現在の下書きと生成時の入力は異なります/)).toBeVisible();
  });

  it("今回の生成は進行中と完成を区別し、入力の編集後も元入力を維持する", () => {
    const running: ImageSource = { ...completed, status: "running", image: undefined };
    const studio = context({ jobs: [running], recentGenerationIds: [running.id] });
    const rendered = renderView(studio);
    expect(screen.getByRole("heading", { name: "今回の生成" })).toBeVisible();
    expect(screen.getAllByText("生成中")[0]).toBeVisible();
    rendered.rerender(<StudioContext.Provider value={{ ...studio, jobs: [completed] }}><CreateView onSaveTemplate={vi.fn()} /></StudioContext.Provider>);
    expect(screen.getByRole("heading", { name: "今回の生成結果" })).toBeVisible();
    expect(screen.getByText(/現在の下書きと生成時の入力は異なります/)).toBeVisible();
  });

  it("過去画像を選択中でも今回の進行状況を別に表示し、今回の生成へ戻れる", async () => {
    const running: ImageSource = { ...completed, id: "new-image", status: "running", image: undefined, batch: undefined };
    const studio = context({ jobs: [running, completed], recentGenerationIds: [running.id] });
    const user = userEvent.setup();
    renderView(studio);
    expect(screen.getByRole("heading", { name: "選択中の履歴" })).toBeVisible();
    expect(screen.getByText(/今回の生成：完成 0\/1枚 · 進行中/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "今回の生成を見る" }));
    expect(studio.select).toHaveBeenCalledExactlyOnceWith(running.id);
    expect(studio.updateDraft).not.toHaveBeenCalled();
  });

  it("新しい生成の開始待ちと、表示中の過去画像を区別する", () => {
    renderView(context({ submitting: true }));
    expect(screen.getByText("新しい生成を開始しています。下の表示は開始前の履歴です。")).toHaveAttribute("role", "status");
    expect(screen.getByRole("heading", { name: "選択中の履歴" })).toBeVisible();
  });

  it("履歴がない場合は元入力の確認を表示せず空の案内を表示する", () => {
    renderView(context({ jobs: [], selectedId: null }));
    expect(screen.getByRole("heading", { name: "最初の一枚をつくりましょう" })).toBeVisible();
    expect(screen.queryByText("この履歴の元の入力を確認")).not.toBeInTheDocument();
  });
  it("入力の開閉をキーボードで操作でき、下書き・設定と生成への到達を維持する", async () => {
    const studio = context();
    studio.generate = vi.fn();
    const initialDraft: StudioContextValue["draft"] = {
      ...studio.draft,
      layers: [{
        id: "light",
        name: "やわらかい光",
        body: "自然な光",
        category: "lighting",
        version: 1,
        tags: [],
        favorite: false,
      }],
      references: [{ jobId: completed.id, role: "overall" }],
    };
    function DraftHarness() {
      const [draft, setDraft] = useState(initialDraft);
      return (
        <StudioContext.Provider value={{
          ...studio,
          draft,
          updateDraft: (changes) => setDraft((current) => ({ ...current, ...changes })),
        }}>
          <CreateView onSaveTemplate={vi.fn()} />
        </StudioContext.Provider>
      );
    }
    const user = userEvent.setup();
    render(<DraftHarness />);
    const prompt = screen.getByRole("textbox", { name: "プロンプト" });
    await user.clear(prompt);
    await user.type(prompt, "構図を確認するための入力");
    const disclosure = screen.getByRole("button", { name: "入力を閉じる" });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(
      document.getElementById(disclosure.getAttribute("aria-controls")!),
    ).toContainElement(prompt);
    disclosure.focus();
    await user.keyboard("{Enter}");
    expect(disclosure).toHaveFocus();
    expect(disclosure).toHaveAccessibleName("入力を編集");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("テンプレート 1件 · 参照画像 1件")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "生成枚数" })).toHaveTextContent("3枚");
    const generate = screen.getByRole("button", { name: "3枚の画像を生成" });
    expect(generate).toBeEnabled();
    expect(studio.generate).not.toHaveBeenCalled();
    await user.keyboard(" ");
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "プロンプト" })).toBe(prompt);
    expect(prompt).toHaveValue("構図を確認するための入力");
    expect(
      screen.getByRole("button", { name: /やわらかい光\s*v1/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "参照画像の役割" }),
    ).toHaveTextContent("全体");
    await user.click(generate);
    expect(studio.generate).toHaveBeenCalledOnce();
  });

  it("停止後のerror:nullを安全に描画し、入力が保持されていることを伝える", () => {
    const cancelled: ImageSource = {
      ...completed,
      id: "cancelled",
      status: "cancelled",
      image: undefined,
      batch: undefined,
      error: null,
    };
    renderView(context({ jobs: [cancelled], selectedId: cancelled.id }));
    expect(
      screen.getByText("生成をキャンセルしました。入力は保持されています。"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "元の入力に置き換えて編集" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "内容を編集して再試行" }),
    ).not.toBeInTheDocument();
  });

  it("入力を閉じていても、失敗画像の編集操作で復元した入力を開く", async () => {
    const failed: ImageSource = {
      ...completed,
      id: "failed",
      status: "failed",
      image: undefined,
      batch: undefined,
      error: null,
    };
    const studio = context({ jobs: [failed], selectedId: failed.id });
    function DraftHarness() {
      const [draft, setDraft] = useState(studio.draft);
      return (
        <StudioContext.Provider value={{
          ...studio,
          draft,
          replaceFromSource: (source) => {
            studio.replaceFromSource(source);
            setDraft((current) => sourceDraft(current, source));
          },
        }}>
          <CreateView onSaveTemplate={vi.fn()} />
        </StudioContext.Provider>
      );
    }
    const user = userEvent.setup();
    render(<DraftHarness />);
    await user.click(screen.getByRole("button", { name: "入力を閉じる" }));
    await user.click(screen.getByRole("button", { name: "内容を編集して再試行" }));
    expect(studio.replaceFromSource).toHaveBeenCalledExactlyOnceWith(failed);
    expect(
      screen.getByRole("button", { name: "入力を閉じる" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("textbox", { name: "プロンプト" }),
    ).toHaveValue(failed.prompt);
  });

  it("完成画像を選択中でも、同時作成の残り1枚を停止できる", async () => {
    const running: ImageSource = {
      ...completed,
      id: "running",
      image: undefined,
      status: "running",
      batch: { id: "forest-batch", index: 3, count: 3, deletedCount: 1 },
    };
    const studio = context({ jobs: [completed, running] });
    const user = userEvent.setup();
    renderView(studio);
    const stop = screen.getByRole("button", { name: "この1枚を停止" });
    expect(stop).toBeEnabled();
    await user.click(stop);
    await waitFor(() =>
      expect(studio.cancel).toHaveBeenCalledExactlyOnceWith(running),
    );
    expect(studio.cancel).not.toHaveBeenCalledWith(completed);
    expect(studio.select).not.toHaveBeenCalled();
  });

  it("同時作成の2枚目が削除済みでも、残った3枚目の番号を維持する", () => {
    const third: ImageSource = {
      ...completed,
      id: "third",
      batch: { id: "forest-batch", index: 3, count: 3, deletedCount: 1 },
    };
    renderView(context({ jobs: [third, completed] }));
    expect(
      screen.getByRole("button", { name: "1枚目の生成結果 完成" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "3枚目の生成結果 完成" }),
    ).toHaveTextContent("3");
    expect(
      screen.queryByRole("button", { name: "2枚目の生成結果 完成" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("削除 1枚")).toBeInTheDocument();
  });

  it("再試行上限と対処案・詳細を表示し、編集操作で元入力を読み込む", async () => {
    const failed: ImageSource = {
      ...completed,
      id: "failed",
      image: undefined,
      status: "failed",
      batch: undefined,
      error: {
        category: "content",
        code: "CONTENT_REVIEW",
        message: "3回のリトライ上限に到達しました。",
        advice: "表現を見直してから再試行してください。",
        details: "保存された内容審査の診断情報",
      },
    };
    const studio = context({ jobs: [failed], selectedId: failed.id });
    const user = userEvent.setup();
    renderView(studio);
    expect(screen.getByText("3回のリトライ上限に到達しました。")).toBeVisible();
    expect(
      screen.getByText("表現を見直してから再試行してください。"),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "3回のリトライ上限に到達しました。",
    );
    expect(
      screen.queryByRole("button", { name: "元の入力に置き換えて編集" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "画像のその他の操作" }),
    ).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "プロンプト" })).toHaveValue(
      "制作中の文章",
    );
    await user.click(screen.getByText("エラーの詳細"));
    expect(screen.getByText(/保存された内容審査の診断情報/)).toBeVisible();
    expect(screen.getByText(/CONTENT_REVIEW/)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "内容を編集して再試行" }),
    );
    expect(studio.replaceFromSource).toHaveBeenCalledExactlyOnceWith(failed);
  });

  it.each([null, "以前に保存されたエラー文"])(
    "古いエラー形式（%s）でも編集でき、診断がない場合はその旨を示す",
    async (error) => {
      const failed: ImageSource = {
        ...completed,
        id: "legacy-failed",
        status: "failed",
        image: undefined,
        batch: undefined,
        error,
      };
      const studio = context({
        jobs: [failed],
        selectedId: failed.id,
        health: { ready: false, message: "接続を確認してください。" },
        generate: vi.fn(),
        retry: vi.fn(),
      });
      const user = userEvent.setup();
      renderView(studio);
      expect(screen.getByRole("alert")).toHaveTextContent(
        error || "生成に失敗しました。",
      );
      await user.click(screen.getByText("エラーの詳細"));
      expect(
        screen.getByText(
          "この履歴には詳しい理由が保存されていません。生成時の入力は保持されています。",
        ),
      ).toBeVisible();
      await user.click(
        screen.getByRole("button", { name: "内容を編集して再試行" }),
      );
      expect(studio.replaceFromSource).toHaveBeenCalledExactlyOnceWith(failed);
      expect(studio.generate).not.toHaveBeenCalled();
      expect(studio.retry).not.toHaveBeenCalled();
    },
  );
});
