import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudio } from "@/lib/studio-context";
import { draftKey, emptyDraft } from "@/lib/draft";
import type { ImageSource } from "@/lib/types";
import { StudioProvider } from "./studio-provider";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ createApi: () => api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("./studio-dialogs", () => ({ StudioDialogs: () => null }));
const history: ImageSource = { id: "history", prompt: "過去の入力", status: "succeeded", createdAt: "2026-10-03" };
let jobs: ImageSource[];
beforeEach(() => {
  jobs = [history];
  localStorage.setItem(draftKey, JSON.stringify({ current: { ...emptyDraft, prompt: "新しい入力", count: 2 }, undo: null }));
  api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === "/api/jobs" && !options?.method) return { jobs };
    if (path === "/api/uploads") return { uploads: [] };
    if (path === "/api/templates?all=1") return { templates: [] };
    if (path === "/api/lineage") return { commits: [], branches: [], uploads: [] };
    if (path === "/api/health?refresh=1") return { ready: true, message: "sample" };
    if (path === "/api/batches" || path === "/api/jobs/history/retry-batch") {
      const accepted = [1, 2].map((index) => ({ ...history, id: `new-${index}`, status: "queued" }));
      jobs = [...accepted, history];
      return { jobs: accepted };
    }
    throw new Error(`Unexpected API: ${path}`);
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
function Probe() {
  const studio = useStudio();
  return <>
    <p data-testid="ids">{studio.recentGenerationIds.join(",")}</p>
    <p data-testid="selected">{studio.selectedId}</p>
    <p data-testid="draft">{studio.draft.prompt}</p>
    <button onClick={() => void studio.generate()}>生成</button>
    <button onClick={() => void studio.run(() => studio.retry(history))}>再生成</button>
    <button onClick={() => studio.openPreview(history)}>履歴選択</button>
    <button onClick={() => studio.replaceFromSource(history)}>入力読戻し</button>
  </>;
}
describe("今回の生成と履歴選択の独立した状態", () => {
  it.each(["生成", "再生成"])("%sで受付IDを記録し、履歴の選択や入力読戻しで上書きしない", async (action) => {
    const user = userEvent.setup();
    render(<StudioProvider><Probe /></StudioProvider>);
    expect(screen.getByTestId("ids")).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(screen.getByTestId("ids")).toHaveTextContent("new-1,new-2"));
    expect(screen.getByTestId("selected")).toHaveTextContent("new-1");
    await user.click(screen.getByRole("button", { name: "履歴選択" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("history");
    expect(screen.getByTestId("ids")).toHaveTextContent("new-1,new-2");
    await user.click(screen.getByRole("button", { name: "入力読戻し" }));
    expect(screen.getByTestId("draft")).toHaveTextContent("過去の入力");
    expect(screen.getByTestId("ids")).toHaveTextContent("new-1,new-2");
  });
  it("受付に失敗しても以前の生成IDと選択を保持する", async () => {
    const user = userEvent.setup();
    render(<StudioProvider><Probe /></StudioProvider>);
    await user.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(screen.getByTestId("ids")).toHaveTextContent("new-1,new-2"));
    const read = api.getMockImplementation()!;
    api.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/api/batches") throw new Error("受付失敗");
      return read(path, options);
    });
    await user.click(screen.getByRole("button", { name: "生成" }));
    expect(screen.getByTestId("ids")).toHaveTextContent("new-1,new-2");
    expect(screen.getByTestId("selected")).toHaveTextContent("new-1");
  });
});
