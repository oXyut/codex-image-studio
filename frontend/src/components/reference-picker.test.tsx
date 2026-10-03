import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, Reference, StudioContextValue } from "@/lib/types";
import { referenceInfo } from "@/lib/reference-info";
import { ReferencePicker } from "./reference-picker";

afterEach(cleanup);

const batch = { id: "10000000-0000-4000-8000-000000000100", count: 3 };
const jobs: ImageSource[] = [3, 2, 1].map((index) => ({
  id: `job-${index}`,
  prompt: "同じ長いプロンプトで生成した草原の画像",
  createdAt: "2026-10-03T08:00:00Z",
  status: "succeeded",
  image: { url: `/sample-${index}.jpg`, downloadUrl: `/sample-${index}.jpg` },
  batch: { ...batch, index },
}));
const upload: ImageSource = {
  id: "upload-one", kind: "upload", name: "草原.jpg", status: "uploaded",
  createdAt: "2026-10-02T08:00:00Z",
  image: { url: "/upload.jpg", downloadUrl: "/upload.jpg" },
};
function renderPicker({
  sources = jobs,
  uploads = [] as ImageSource[],
  references = [] as Reference[],
} = {}) {
  const updateDraft = vi.fn();
  const onOpenChange = vi.fn();
  function Picker() {
    const [open, setOpen] = useState(true);
    const studio = {
      jobs: sources, uploads, draft: { references }, updateDraft,
    } as unknown as StudioContextValue;
    return <StudioContext.Provider value={studio}>
      <ReferencePicker open={open} onBusy={vi.fn()} onOpenChange={(value) => {
        onOpenChange(value); setOpen(value);
      }} />
    </StudioContext.Provider>;
  }
  render(<Picker />);
  return { updateDraft, onOpenChange };
}
const selectionName = (source: ImageSource, selected = false) =>
  `${referenceInfo(source).label}を${selected ? "参照から外す" : "参照に選択"}`;
const previewName = (source: ImageSource) => `${referenceInfo(source).label}を大きく確認`;

describe("参照画像候補の識別と確認", () => {
  it("同名・同時刻でも3枚の番号と生成単位・日時を画面と操作名に表示する", () => {
    renderPicker();
    for (const source of jobs) {
      const select = screen.getByRole("button", { name: selectionName(source) });
      expect(select).toHaveTextContent(`${source.batch!.index} / 3枚目`);
      expect(select).toHaveTextContent("同時作成 #100000…0100");
      expect(select).toHaveTextContent("2026/10/03");
      expect(screen.getByRole("button", { name: previewName(source) })).toBeVisible();
    }
  });

  it("選択と役割を保持して拡大し、Escapeで候補と元のフォーカスへ戻る", async () => {
    const user = userEvent.setup();
    const { updateDraft, onOpenChange } = renderPicker({
      references: [{ jobId: jobs[0].id, role: "composition" }],
    });
    await user.click(screen.getByRole("button", { name: selectionName(jobs[1]) }));
    const trigger = screen.getByRole("button", { name: previewName(jobs[2]) });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "候補に戻る" })).toHaveFocus();
    expect(screen.getByRole("img", { name: referenceInfo(jobs[2]).label })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("2 / 4枚選択");
    expect(updateDraft).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "参照画像を選ぶ" })).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: selectionName(jobs[0], true) })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "選択を反映" }));
    expect(updateDraft).toHaveBeenCalledExactlyOnceWith({ references: [
      { jobId: jobs[0].id, role: "composition" },
      { jobId: jobs[1].id, role: "overall" },
    ] });
  });

  it("拡大中にも選択・解除でき、候補へ戻っても検索条件を保持する", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(screen.getByRole("textbox", { name: "参照画像を検索" }), "同時作成 #100000…0100");
    await user.click(screen.getByRole("button", { name: previewName(jobs[0]) }));
    const preview = screen.getByRole("dialog");
    await user.click(within(preview).getByRole("button", { name: selectionName(jobs[0]) }));
    expect(within(preview).getByRole("button", { name: selectionName(jobs[0], true) })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "候補に戻る" }));
    expect(screen.getByRole("textbox", { name: "参照画像を検索" })).toHaveValue("同時作成 #100000…0100");
    expect(screen.getByRole("button", { name: selectionName(jobs[0], true) })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: previewName(jobs[0]) }));
    await user.click(screen.getByRole("button", { name: selectionName(jobs[0], true) }));
    await user.click(screen.getByRole("button", { name: "候補に戻る" }));
    expect(screen.getByRole("button", { name: selectionName(jobs[0]) })).toHaveAttribute("aria-pressed", "false");
  });

  it("読込失敗を伝え、拡大前の選択を維持して候補に戻れる", async () => {
    const user = userEvent.setup();
    renderPicker({ references: [{ jobId: jobs[0].id, role: "overall" }] });
    await user.click(screen.getByRole("button", { name: previewName(jobs[1]) }));
    fireEvent.error(screen.getByRole("img", { name: referenceInfo(jobs[1]).label }));
    expect(screen.getByRole("alert")).toHaveTextContent("選択は保持されています");
    await user.click(screen.getByRole("button", { name: "候補に戻る" }));
    expect(screen.getByRole("button", { name: selectionName(jobs[0], true) })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: previewName(jobs[2]) }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("アップロード・単独生成を区別し、削除済み候補の元の番号を維持する", () => {
    const single = { ...jobs[0], id: "single", batch: undefined };
    renderPicker({ sources: [jobs[0], single], uploads: [upload] });
    expect(screen.getByRole("button", { name: selectionName(jobs[0]) })).toHaveTextContent("3 / 3枚目");
    expect(screen.getByRole("button", { name: selectionName(single) })).toHaveTextContent("1枚生成");
    expect(screen.getByRole("button", { name: selectionName(upload) })).toHaveTextContent("アップロード");
  });

  it("4枚の上限を拡大中も保ち、キャンセル時に下書きを変更しない", async () => {
    const user = userEvent.setup();
    const { updateDraft } = renderPicker({ uploads: [upload], references: [
      ...jobs.map((source) => ({ jobId: source.id, role: "overall" })),
      { uploadId: "another", role: "overall" },
    ] });
    await user.click(screen.getByRole("button", { name: previewName(upload) }));
    await user.click(screen.getByRole("button", { name: selectionName(upload) }));
    expect(screen.getByRole("button", { name: selectionName(upload) })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "候補に戻る" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(updateDraft).not.toHaveBeenCalled();
  });

  it("画像のない失敗・生成中履歴を候補に出さず、空状態を示す", () => {
    renderPicker({ sources: jobs.map((source) => ({ ...source, status: "failed", image: null })) });
    expect(screen.getByText("選択できる画像がありません")).toBeVisible();
    expect(screen.queryByRole("button", { name: /を大きく確認$/ })).not.toBeInTheDocument();
  });
});
