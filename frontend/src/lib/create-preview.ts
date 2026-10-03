import { normalizeCanvasSize } from "@shared/canvas-options.js";
import { composePrompt } from "@shared/prompt-utils.js";
import type { Draft, ImageSource } from "./types";

// Compare the recipe used for this image, not UI-only fields such as count or
// the lineage destination. A matching recipe does not mean a new image exists.
export function draftMatchesSource(draft: Draft, source: ImageSource) {
  const sourcePrompt = source.prompt ?? (
    source.basePrompt !== undefined || source.layers?.length
      ? composePrompt(source.basePrompt || "", source.layers)
      : null
  );
  const references = (items: Draft["references"] = []) =>
    items.map((ref) => [ref.jobId || ref.uploadId, ref.role]);
  return (
    sourcePrompt !== null &&
    composePrompt(draft.prompt, draft.layers) === sourcePrompt.trim() &&
    normalizeCanvasSize(draft.size) === normalizeCanvasSize(source.size || "") &&
    draft.style === (source.style || "auto") &&
    draft.transparent === (source.transparent === true) &&
    JSON.stringify(references(draft.references)) ===
      JSON.stringify(references(source.references))
  );
}

export function previewOrigin(
  source: ImageSource,
  selectedId: string | null,
  recentGenerationIds: string[],
) {
  if (recentGenerationIds.includes(source.id))
    return ["queued", "running"].includes(source.status)
      ? "今回の生成"
      : "今回の生成結果";
  return selectedId === source.id ? "選択中の履歴" : "最新の履歴";
}
