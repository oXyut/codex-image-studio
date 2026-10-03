import { useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { ImageViewer } from "./image-viewer";

const preferenceKey = "codex-image-studio.viewer-details";
const image: ImageSource = {
  id: "viewer-sample",
  prompt: "サンプル画像",
  status: "succeeded",
  createdAt: "2026-10-03T09:00:00Z",
  image: { url: "/sample.png", downloadUrl: "/sample.png?download=1" },
};
const studio = {
  jobs: [image],
  uploads: [],
  metadata: { commits: [], branches: [], uploads: [] },
  favoritePendingIds: [],
  view: "history",
} as unknown as StudioContextValue;

function Preview({ initial = image }: { initial?: ImageSource }) {
  const [source, setSource] = useState<ImageSource | null>(initial);
  return (
    <StudioContext.Provider value={studio}>
      <button onClick={() => setSource(image)}>画像を開く</button>
      <ImageViewer source={source} previous={null} next={null} onSource={setSource} />
    </StudioContext.Provider>
  );
}

function viewport(width: number) {
  const listeners = new Set<() => void>();
  const query = {
    matches: width >= 1024,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.spyOn(window, "matchMedia").mockReturnValue(query as unknown as MediaQueryList);
  return (nextWidth: number) => act(() => {
    query.matches = nextWidth >= 1024;
    listeners.forEach((listener) => listener());
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("画像ビューアの詳細表示", () => {
  it.each([775, 390])("%ipx幅では成功画像の詳細を初期表示で閉じる", (width) => {
    viewport(width);
    render(<Preview />);
    expect(screen.getByRole("img", { name: "サンプル画像" })).toBeVisible();
    expect(screen.getByRole("button", { name: "詳細" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "参照に追加" })).toBeVisible();
  });

  it("広い画面の初期表示は従来どおり詳細を開く", () => {
    viewport(1440);
    render(<Preview />);
    expect(screen.getByRole("button", { name: "詳細" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "画像の詳細" })).toBeVisible();
  });

  it.each([true, false])("詳細の選択 %s をビューア再作成後も保存する", async (open) => {
    const user = userEvent.setup();
    viewport(open ? 775 : 1440);
    const first = render(<Preview />);
    await user.click(screen.getByRole("button", { name: "詳細" }));
    expect(localStorage.getItem(preferenceKey)).toBe(String(open));
    first.unmount();
    render(<Preview />);
    expect(screen.getByRole("button", { name: "詳細" })).toHaveAttribute("aria-expanded", String(open));
  });

  it("未選択なら画面幅に追随し、選択後は画面幅が変わっても開閉を保持する", async () => {
    const user = userEvent.setup();
    const resize = viewport(1440);
    render(<Preview />);
    resize(775);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "詳細" }));
    resize(1440);
    resize(390);
    expect(screen.getByRole("complementary", { name: "画像の詳細" })).toBeVisible();
  });

  it("詳細を閉じた選択でも失敗履歴の診断を表示し、成功画像では選択を保持する", async () => {
    const user = userEvent.setup();
    viewport(775);
    localStorage.setItem(preferenceKey, "false");
    render(<Preview initial={{ ...image, image: undefined, status: "failed", error: "サンプルエラー" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("サンプルエラー");
    expect(screen.getByRole("button", { name: "内容を編集して再試行" })).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "画像を開く" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(localStorage.getItem(preferenceKey)).toBe("false");
  });

  it("設定・ファイル情報は必要時に展開し、詳細を閉じるとトグルへフォーカスを戻す", async () => {
    const user = userEvent.setup();
    viewport(775);
    render(<Preview />);
    await user.click(screen.getByRole("button", { name: "詳細" }));
    expect(screen.getByRole("complementary")).toHaveAttribute("id", screen.getByRole("button", { name: "詳細" }).getAttribute("aria-controls"));
    expect(screen.queryByText(`ID: ${image.id}`)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成設定・ファイル情報" }));
    expect(screen.getByText(`ID: ${image.id}`)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "画像の詳細を閉じる" }));
    expect(screen.getByRole("button", { name: "詳細" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("complementary")).toBeVisible();
  });

  it("保存データが不正でも狭い画面の初期表示を使う", () => {
    viewport(775);
    localStorage.setItem(preferenceKey, "invalid");
    render(<Preview />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("ブラウザがストレージへのアクセスを拒否しても開閉と再表示ができる", async () => {
    const user = userEvent.setup();
    viewport(775);
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("storage denied"); });
    render(<Preview />);
    await user.click(screen.getByRole("button", { name: "詳細" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "画像を開く" }));
    expect(screen.getByRole("complementary")).toBeVisible();
  });
});
