import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloneDraft,
  draftKey,
  emptyDraft,
  loadDraft,
  normalizeDraft,
  reconcileDraft,
  sourceDraft,
} from "./draft";
import type { Draft, ImageSource, Template } from "./types";

const ids = Array.from(
  { length: 7 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const template: Template = {
  id: "lighting",
  name: "窓の光",
  body: "柔らかい自然光",
  category: "lighting",
  tags: ["朝"],
  favorite: true,
  version: 3,
  updatedAt: "2026-10-02T00:00:00Z",
};
const existing: Draft = {
  prompt: "編集中の文章",
  layers: [template],
  references: [{ uploadId: ids[0], role: "overall" }],
  count: 3,
  size: "portrait",
  style: "illustration",
  transparent: true,
  lineageContext: {
    sourceJobId: ids[0],
    operation: "derive",
    newBranch: false,
  },
};
const generated: ImageSource = {
  id: ids[1],
  status: "succeeded",
  createdAt: "2026-10-02T00:01:00Z",
  basePrompt: "元の文章",
  prompt: "元の文章にテンプレートを合成した送信内容",
  layers: [{ ...template, version: 1 }],
  references: [
    { uploadId: ids[2], role: "composition" },
    { jobId: ids[3], role: "style" },
  ],
  size: "landscape",
  style: "photo",
  transparent: false,
};
const uploaded: ImageSource = {
  id: ids[4],
  kind: "upload",
  name: "reference.png",
  status: "uploaded",
  createdAt: "2026-10-02T00:00:00Z",
};

beforeEach(() => localStorage.clear());

describe("下書きの永続化と復元", () => {
  it("ブラウザがlocalStorageの取得自体を拒否しても空の下書きで起動できる", () => {
    const blocked = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("Storage disabled", "SecurityError");
      });
    try {
      expect(loadDraft()).toEqual({ current: emptyDraft, undo: null });
    } finally {
      blocked.mockRestore();
    }
  });

  it("現行と元に戻す前の下書きを設定・参照・バージョンごと読み戻す", () => {
    const undo = { ...cloneDraft(existing), prompt: "置き換え前の文章" };
    localStorage.setItem(draftKey, JSON.stringify({ current: existing, undo }));

    const saved = loadDraft(localStorage);
    expect(saved).toEqual({ current: existing, undo });
    expect(saved.current).not.toBe(existing);
    expect(saved.undo?.layers[0].version).toBe(3);
    saved.current.layers[0].tags.push("変更");
    expect(saved.undo?.layers[0].tags).toEqual(["朝"]);
  });

  it("旧v2の下書きを新しい形へ移行し、保存済みv3があれば優先する", () => {
    localStorage.setItem(
      "codex-image-studio-draft-v2",
      JSON.stringify(existing),
    );
    expect(loadDraft(localStorage)).toEqual({ current: existing, undo: null });
    const current = { ...cloneDraft(existing), prompt: "v3の最新文章" };
    localStorage.setItem(draftKey, JSON.stringify({ current, undo: existing }));
    expect(loadDraft(localStorage)).toEqual({ current, undo: existing });
  });

  it("保存内容の破損やストレージ利用不可でも空の下書きで開始する", () => {
    localStorage.setItem(draftKey, "{invalid json");
    expect(loadDraft(localStorage)).toEqual({
      current: emptyDraft,
      undo: null,
    });
    const unavailable = {
      getItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;
    expect(loadDraft(unavailable)).toEqual({ current: emptyDraft, undo: null });
  });

  it("有効な参照のみを重複なく4枚まで残す", () => {
    const raw = {
      references: [
        { jobId: "not-a-uuid", role: "overall" },
        { jobId: ids[0], uploadId: ids[1], role: "overall" },
        { jobId: ids[0], role: "unknown-role" },
        { jobId: ids[0], role: "overall" },
        { uploadId: ids[0], role: "style" },
        { uploadId: ids[1], role: "composition" },
        { jobId: ids[2], role: "style" },
        { uploadId: ids[3], role: "overall" },
        { jobId: ids[4], role: "overall" },
      ],
    };
    expect(normalizeDraft(raw).references).toEqual([
      { jobId: ids[0], role: "overall" },
      { uploadId: ids[1], role: "composition" },
      { jobId: ids[2], role: "style" },
      { uploadId: ids[3], role: "overall" },
    ]);
  });
});

describe("履歴からの入力復元", () => {
  it("参照して編集では元入力と設定を復元し、選んだ画像だけを参照にする", () => {
    const restored = sourceDraft(existing, generated, true);
    expect(restored).toMatchObject({
      prompt: generated.basePrompt,
      layers: generated.layers,
      size: "landscape",
      style: "photo",
      transparent: false,
      count: 3,
      references: [{ jobId: generated.id, role: "overall" }],
      lineageContext: {
        sourceJobId: generated.id,
        operation: "derive",
        newBranch: false,
      },
    });
    restored.layers[0].tags.push("追加");
    expect(generated.layers?.[0].tags).toEqual(["朝"]);
    expect(existing.prompt).toBe("編集中の文章");
    expect(existing.references).toEqual([
      { uploadId: ids[0], role: "overall" },
    ]);
  });

  it("入力を復元では当時の参照を復元し、編集由来の新しい枝を記録する", () => {
    const restored = sourceDraft(existing, generated);
    expect(restored.prompt).toBe("元の文章");
    expect(restored.references).toEqual(generated.references);
    expect(restored.lineageContext).toEqual({
      sourceJobId: generated.id,
      operation: "edit",
      newBranch: true,
    });
    expect(restored.layers[0].version).toBe(1);
    expect(restored.count).toBe(3);
  });

  it("アップロード画像を起点にする時は編集中の入力と設定を保持する", () => {
    const restored = sourceDraft(existing, uploaded);
    expect(restored).toEqual({
      ...existing,
      references: [{ uploadId: uploaded.id, role: "overall" }],
      lineageContext: {
        sourceJobId: uploaded.id,
        operation: "derive",
        newBranch: false,
      },
    });
    restored.layers[0].body = "変更";
    expect(existing.layers[0].body).toBe("柔らかい自然光");
  });
});

describe("削除済み画像との整合", () => {
  it("現行と元に戻す前の下書きから削除した画像・起点を取り除く", () => {
    const current = sourceDraft(existing, generated, true);
    const undo = cloneDraft(existing);
    const jobs: ImageSource[] = [];
    const uploads: ImageSource[] = [uploaded];
    const saved = {
      current: reconcileDraft(current, jobs, uploads),
      undo: reconcileDraft(undo, jobs, uploads),
    };
    localStorage.setItem(draftKey, JSON.stringify(saved));

    const restored = loadDraft(localStorage);
    expect(restored.current.references).toEqual([]);
    expect(restored.current.lineageContext).toBeNull();
    expect(restored.undo?.references).toEqual([]);
    expect(restored.undo?.lineageContext).toBeNull();
    expect(restored.undo?.prompt).toBe("編集中の文章");
    expect(restored.undo?.layers).toEqual(existing.layers);
  });

  it("派生元の参照を外した時に系統の起点を解除し、入力編集の起点は保持する", () => {
    const derive = {
      ...sourceDraft(existing, generated, true),
      references: [],
    };
    expect(reconcileDraft(derive, [generated], []).lineageContext).toBeNull();
    const edit = { ...sourceDraft(existing, generated), references: [] };
    expect(reconcileDraft(edit, [generated], [])).toBe(edit);
    expect(edit.lineageContext?.operation).toBe("edit");
  });

  it("参照と起点が現在の一覧に存在する場合は下書きを更新しない", () => {
    const unchanged = sourceDraft(existing, uploaded);
    expect(reconcileDraft(unchanged, [generated], [uploaded])).toBe(unchanged);
  });
});
