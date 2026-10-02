import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { CreateView } from "./create";

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

  it("内容審査の失敗は対処案と詳細を確認でき、編集操作で元入力を読み込む", async () => {
    const failed: ImageSource = {
      ...completed,
      id: "failed",
      image: undefined,
      status: "failed",
      batch: undefined,
      error: {
        category: "content",
        code: "CONTENT_REVIEW",
        message: "生成内容を確認してください。",
        advice: "表現を見直してから再試行してください。",
        details: "保存された内容審査の診断情報",
      },
    };
    const studio = context({ jobs: [failed], selectedId: failed.id });
    const user = userEvent.setup();
    renderView(studio);
    expect(
      screen.getByText("表現を見直してから再試行してください。"),
    ).toBeVisible();
    await user.click(screen.getByText("エラーの詳細"));
    expect(screen.getByText(/保存された内容審査の診断情報/)).toBeVisible();
    expect(screen.getByText(/CONTENT_REVIEW/)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "内容を編集して再試行" }),
    );
    expect(studio.replaceFromSource).toHaveBeenCalledExactlyOnceWith(failed);
  });
});
