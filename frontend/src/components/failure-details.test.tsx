import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioContext, useStudio } from "@/lib/studio-context";
import { draftKey, emptyDraft } from "@/lib/draft";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { ImageViewer } from "./image-viewer";
import { StudioProvider } from "./studio-provider";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  createApi: () => api,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const failed: ImageSource = {
  id: "33333333-3333-4333-8333-333333333333",
  status: "failed",
  createdAt: "2026-10-03T06:25:00Z",
  basePrompt: "青い鳥のイラスト",
  prompt: "青い鳥のイラスト\n白い背景",
  size: "square",
  style: "illustration",
  transparent: true,
  references: [{ jobId: "33333333-3333-4333-8333-333333333334", role: "style" }],
  layers: [{ id: "background", name: "白い背景", body: "白い背景", category: "background", tags: [], favorite: false, version: 2 }],
  error: {
    code: "TRANSIENT_ERROR",
    message: "一時的な接続障害です。",
    advice: "少し待ってから再試行できます。",
    details: "responseStreamDisconnected HTTP: 503",
  },
};

beforeEach(() => {
  localStorage.clear();
  api.mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

function setup(source = failed) {
  const studio = {
    jobs: [source], uploads: [], metadata: { commits: [], branches: [], uploads: [] },
    health: { ready: true }, draft: { count: 1 }, view: "history", favoritePendingIds: [],
    replaceFromSource: vi.fn(), retry: vi.fn(), requestDelete: vi.fn(), navigate: vi.fn(),
    api: vi.fn(), refresh: vi.fn(),
  } as unknown as StudioContextValue;
  const onSource = vi.fn();
  function Preview() {
    const [current, setCurrent] = useState<ImageSource | null>(source);
    return <StudioContext.Provider value={studio}>
      <ImageViewer source={current} previous={null} next={null} onSource={(value) => { onSource(value); setCurrent(value); }} />
    </StudioContext.Provider>;
  }
  render(<Preview />);
  return { studio, onSource, user: userEvent.setup() };
}

describe("画像のない失敗の詳細", () => {
  it("失敗用の見出しと原因・編集操作を先に表示し、入力を開き、設定とログを折り畳む", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "生成失敗の詳細" });
    expect(dialog).toHaveClass("sm:max-w-2xl");
    expect(dialog).not.toHaveClass("h-[96dvh]");
    expect(screen.getByRole("complementary", { name: "生成失敗の詳細" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("一時的な接続障害です。少し待ってから再試行できます。");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "画像を拡大プレビュー" })).not.toBeInTheDocument();
    expect(screen.queryByText(/画像クリックで拡大/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成時のプロンプト" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("白い背景 · v2")).toBeVisible();
    expect(screen.getByRole("button", { name: "生成時の設定" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("エラーの詳細").closest("details")).not.toHaveAttribute("open");
    const edit = screen.getByRole("button", { name: "内容を編集して再試行" });
    expect(edit.compareDocumentPosition(screen.getByRole("button", { name: "生成時のプロンプト" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("キーボードで設定を展開し、ログを確認してEscapeで閉じる", async () => {
    const { user, onSource } = setup();
    screen.getByRole("button", { name: "生成時の設定" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("イラスト", { exact: true })).toBeVisible();
    expect(screen.getByText("リクエストあり")).toBeVisible();
    await user.click(screen.getByText("エラーの詳細"));
    expect(screen.getByText(/TRANSIENT_ERROR\s+responseStreamDisconnected HTTP: 503/)).toBeVisible();
    await user.keyboard("{Escape}");
    expect(onSource).toHaveBeenCalledExactlyOnceWith(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("編集で同じ履歴を読み戻し、削除メニューを保持し、自動では再生成しない", async () => {
    const { user, studio } = setup();
    await user.click(screen.getByRole("button", { name: "内容を編集して再試行" }));
    expect(studio.replaceFromSource).toHaveBeenCalledExactlyOnceWith(failed);
    expect(studio.retry).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "画像のその他の操作" }));
    await user.click(screen.getByRole("menuitem", { name: "画像と下流をゴミ箱へ" }));
    expect(studio.requestDelete).toHaveBeenCalledExactlyOnceWith(failed);
  });

  it("失敗詳細を閉じると開いたボタンにフォーカスを戻す", async () => {
    function Preview() {
      const [source, setSource] = useState<ImageSource | null>(null);
      return <StudioContext.Provider value={{ jobs: [failed], uploads: [], metadata: { commits: [], branches: [], uploads: [] }, health: { ready: true }, draft: { count: 1 }, view: "history", favoritePendingIds: [] } as unknown as StudioContextValue}>
        <button onClick={() => setSource(failed)}>失敗カード</button>
        <ImageViewer source={source} previous={null} next={null} onSource={setSource} />
      </StudioContext.Provider>;
    }
    const user = userEvent.setup();
    render(<Preview />);
    const opener = screen.getByRole("button", { name: "失敗カード" });
    await user.click(opener);
    expect(screen.getByRole("button", { name: "生成失敗の詳細を閉じる" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("古い失敗履歴の空入力と保存されていない診断にも説明を表示する", async () => {
    const { user } = setup({ ...failed, basePrompt: "", prompt: "", layers: [], references: [], error: null });
    expect(screen.getByRole("region", { name: "生成時のプロンプト" })).toHaveTextContent("テンプレートから生成");
    await user.click(screen.getByText("エラーの詳細"));
    expect(screen.getByText("この履歴には詳しい理由が保存されていません。生成時の入力は保持されています。")).toBeVisible();
  });

  it("画像がある履歴は通常の画像ビューアと詳細の表示を維持する", () => {
    setup({ ...failed, status: "succeeded", image: { url: "/sample.png", downloadUrl: "/sample.png?download=1" } });
    expect(screen.getByRole("dialog")).toHaveClass("h-[96dvh]");
    expect(screen.getByRole("img", { name: "青い鳥のイラスト" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "画像の詳細" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "生成時の設定" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成時のプロンプト" })).toHaveAttribute("aria-expanded", "false");
  });

  it("実際のProviderで入力・テンプレート・参照・設定を読み戻し、取り消しで元の下書きに戻る", async () => {
    const original = { ...emptyDraft, prompt: "制作中の入力", size: "landscape", count: 4 };
    localStorage.setItem(draftKey, JSON.stringify({ current: original, undo: null }));
    api.mockImplementation(async (path: string) => {
      if (path === "/api/jobs") return { jobs: [failed, { id: failed.references![0].jobId, status: "succeeded", createdAt: failed.createdAt, image: { url: "/reference.png", downloadUrl: "/reference.png?download=1" } }] };
      if (path === "/api/uploads") return { uploads: [] };
      if (path === "/api/templates?all=1") return { templates: [] };
      if (path === "/api/lineage") return { commits: [], branches: [], uploads: [] };
      if (path === "/api/health?refresh=1") return { ready: true, message: "sample" };
      throw new Error(`Unexpected API call: ${path}`);
    });
    function Probe() {
      const studio = useStudio();
      return <>
        <output aria-label="下書き">{JSON.stringify(studio.draft)}</output>
        {studio.jobs.length > 0 && <button onClick={() => studio.openPreview(failed)}>失敗を開く</button>}
        <button onClick={studio.undoDraft} disabled={!studio.canUndo}>元に戻す</button>
      </>;
    }
    const user = userEvent.setup();
    render(<StudioProvider><Probe /></StudioProvider>);
    await user.click(await screen.findByRole("button", { name: "失敗を開く" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "内容を編集して再試行" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const draft = JSON.parse(screen.getByLabelText("下書き").textContent!);
    expect(draft).toMatchObject({ prompt: failed.basePrompt, layers: failed.layers, references: failed.references, size: failed.size, style: failed.style, transparent: failed.transparent, count: 4 });
    await user.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(JSON.parse(screen.getByLabelText("下書き").textContent!)).toEqual(original);
    expect(api.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
});
