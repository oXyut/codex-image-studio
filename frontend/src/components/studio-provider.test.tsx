import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useStudio } from "@/lib/studio-context";
import { draftKey, emptyDraft } from "@/lib/draft";
import type { ImageSource } from "@/lib/types";
import { ImageActions, ImageFavoriteButton } from "./image-actions";
import { StudioProvider } from "./studio-provider";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  createApi: () => api,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const image: ImageSource = {
  id: "saved-image",
  prompt: "森の家",
  status: "succeeded",
  favorite: false,
  createdAt: "2026-10-02T06:25:00Z",
  image: { url: "/image.png", downloadUrl: "/image.png?download=1" },
};
let saved: ImageSource;
beforeEach(() => {
  saved = structuredClone(image);
  localStorage.setItem(draftKey, JSON.stringify({ current: { ...emptyDraft, prompt: "制作中の入力" }, undo: null }));
  api.mockImplementation(async (path: string) => {
    if (path === "/api/jobs") return { jobs: [structuredClone(saved)] };
    if (path === "/api/uploads") return { uploads: [] };
    if (path === "/api/templates?all=1") return { templates: [] };
    if (path === "/api/lineage") return { commits: [], branches: [], uploads: [] };
    if (path === "/api/health?refresh=1") return { ready: false, message: "未接続" };
    throw new Error(`Unexpected API call: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

function Probe() {
  const studio = useStudio();
  const source = studio.jobs[0];
  if (!source) return <p>読み込み中</p>;
  return (
    <>
      <p>{studio.draft.prompt}</p>
      <section aria-label="生成結果"><ImageActions source={source} compact /></section>
      <section aria-label="履歴カード"><ImageFavoriteButton source={source} /></section>
      <button onClick={() => studio.openPreview(source)}>プレビューを開く</button>
    </>
  );
}

describe("お気に入りの共有状態", () => {
  it("詳細から系統図へ移動するとビューアを閉じ、再度開くと画像を大きく表示する", async () => {
    const user = userEvent.setup();
    render(<StudioProvider><Probe /></StudioProvider>);
    await screen.findByText("制作中の入力");
    await user.click(screen.getByRole("button", { name: "プレビューを開く" }));
    await user.click(screen.getByRole("button", { name: "詳細" }));
    await user.click(screen.getByRole("button", { name: "系統図で見る" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "プレビューを開く" }));
    expect(screen.getByRole("button", { name: "詳細" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(api.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("保存中の連打を防ぎ、結果・一覧・開いているプレビューに保存後の状態を反映する", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const read = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === "/api/jobs/saved-image/favorite") {
        await pending;
        saved = { ...saved, ...JSON.parse(options!.body as string) };
        return structuredClone(saved);
      }
      return read(path, options);
    });
    const user = userEvent.setup();
    render(<StudioProvider><Probe /></StudioProvider>);
    await screen.findByText("制作中の入力");
    const result = within(screen.getByRole("region", { name: "生成結果" }));
    const card = within(screen.getByRole("region", { name: "履歴カード" }));
    const add = result.getByRole("button", { name: "森の家をお気に入りに追加" });
    await user.click(add);
    expect(add).toBeDisabled();
    expect(card.getByRole("button", { name: "森の家をお気に入りに追加" })).toBeDisabled();
    await user.click(add);
    expect(api.mock.calls.filter(([path]) => path.endsWith("/favorite"))).toHaveLength(1);
    await act(async () => { finish(); });
    await waitFor(() => expect(result.getByRole("button", { name: "森の家をお気に入りから外す" })).toBeEnabled());
    expect(card.getByRole("button", { name: "森の家をお気に入りから外す" })).toHaveAttribute("aria-pressed", "true");
    expect(api).toHaveBeenCalledWith("/api/jobs/saved-image/favorite", { method: "PATCH", body: JSON.stringify({ favorite: true }) });
    await user.click(screen.getByRole("button", { name: "プレビューを開く" }));
    const preview = within(screen.getByRole("dialog"));
    await user.click(preview.getByRole("button", { name: "森の家をお気に入りから外す" }));
    await waitFor(() => expect(preview.getByRole("button", { name: "森の家をお気に入りに追加" })).toBeEnabled());
    await user.keyboard("{Escape}");
    expect(result.getByRole("button", { name: "森の家をお気に入りに追加" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("制作中の入力")).toBeInTheDocument();
  });

  it("保存失敗を通知し、表示と下書きを保持したまま再操作できる", async () => {
    const read = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/favorite")) throw new Error("保存できませんでした。");
      return read(path, options);
    });
    const user = userEvent.setup();
    render(<StudioProvider><Probe /></StudioProvider>);
    await screen.findByText("制作中の入力");
    const result = within(screen.getByRole("region", { name: "生成結果" }));
    const add = result.getByRole("button", { name: "森の家をお気に入りに追加" });
    await user.click(add);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("保存できませんでした。"));
    expect(add).toBeEnabled();
    expect(add).toHaveAttribute("aria-pressed", "false");
    expect(saved.favorite).toBe(false);
    expect(screen.getByText("制作中の入力")).toBeInTheDocument();
    await user.click(add);
    expect(api.mock.calls.filter(([path]) => path.endsWith("/favorite"))).toHaveLength(2);
  });
});
