import { describe, expect, it } from "vitest";
import { composePrompt } from "@shared/prompt-utils.js";
import { emptyDraft } from "./draft";
import { draftMatchesSource } from "./create-preview";
import type { Draft, ImageSource } from "./types";

const draft: Draft = {
  ...emptyDraft,
  prompt: "  青い森  ",
  layers: [{ id: "layer", name: "光", body: "朝の光", category: "lighting", tags: [], favorite: false }],
  references: [{ jobId: "reference", role: "composition" }],
};
const source: ImageSource = {
  id: "image", createdAt: "2026-10-03", status: "succeeded",
  prompt: composePrompt(draft.prompt, draft.layers), basePrompt: "青い森",
  size: "auto", style: "auto", transparent: false, references: draft.references,
};
describe("プレビューと下書きの入力比較", () => {
  it("入力の記録がない古い履歴を空の下書きと同じ入力とは判断しない", () => {
    expect(draftMatchesSource(emptyDraft, { id: "legacy", status: "succeeded", createdAt: "2026-10-03" })).toBe(false);
    expect(draftMatchesSource(draft, { ...source, prompt: undefined, layers: draft.layers })).toBe(true);
  });
  it("合成した生成入力を比較し、枚数や枝の保存先は比較に含めない", () => {
    expect(draftMatchesSource({ ...draft, count: 5, lineageContext: { sourceJobId: "image", operation: "edit", newBranch: true } }, source)).toBe(true);
  });
  it.each([
    { prompt: "別の森" }, { layers: [] }, { size: "portrait" },
    { style: "photo" }, { transparent: true }, { references: [] },
    { references: [{ jobId: "reference", role: "color" }] },
    { references: [{ uploadId: "other", role: "composition" }] },
  ])("入力・テンプレート・設定・参照の変更を検出する: %j", (change) => {
    expect(draftMatchesSource({ ...draft, ...change }, source)).toBe(false);
  });
});
