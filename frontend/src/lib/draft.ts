import { normalizeCanvasSize } from "@shared/canvas-options.js";
import { normalizeReferences, reconcileDraftSources } from "@shared/studio-features.js";
import type { Draft, ImageSource } from "./types";
export const draftKey = "codex-image-studio-draft-v3";
export const emptyDraft: Draft = {
  prompt: "",
  layers: [],
  references: [],
  count: 1,
  size: "auto",
  style: "auto",
  transparent: false,
  lineageContext: null,
};
export const cloneDraft = (draft: Draft): Draft => structuredClone(draft);
export function normalizeDraft(raw: Partial<Draft> = {}): Draft {
  const context = raw.lineageContext;
  return {
    prompt: typeof raw.prompt === "string" ? raw.prompt.slice(0, 4000) : "",
    layers: Array.isArray(raw.layers)
      ? raw.layers
          .filter(
            (layer) =>
              layer &&
              typeof layer.body === "string" &&
              typeof layer.id === "string",
          )
          .slice(0, 12)
      : [],
    references: normalizeReferences(raw.references),
    count: Number.isInteger(raw.count)
      ? Math.min(10, Math.max(1, raw.count!))
      : 1,
    size: normalizeCanvasSize(raw.size ?? ""),
    style: ["auto", "photo", "illustration", "minimal", "3d"].includes(
      raw.style || "",
    )
      ? raw.style!
      : "auto",
    transparent: raw.transparent === true,
    lineageContext:
      context &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        context.sourceJobId,
      ) &&
      ["derive", "edit"].includes(context.operation)
        ? { ...context, newBranch: context.newBranch === true }
        : null,
  };
}
export function loadDraft(storage?: Storage): {
  current: Draft;
  undo: Draft | null;
} {
  try {
    const target = storage ?? globalThis.localStorage;
    const saved = target.getItem(draftKey);
    if (saved) {
      const data = JSON.parse(saved);
      return {
        current: normalizeDraft(data.current),
        undo: data.undo ? normalizeDraft(data.undo) : null,
      };
    }
    return {
      current: normalizeDraft(
        JSON.parse(target.getItem("codex-image-studio-draft-v2") || "{}"),
      ),
      undo: null,
    };
  } catch {
    return { current: cloneDraft(emptyDraft), undo: null };
  }
}
export function sourceDraft(
  draft: Draft,
  source: ImageSource,
  derive = false,
): Draft {
  const upload = source.kind === "upload";
  return {
    ...(upload
      ? cloneDraft(draft)
      : {
          ...cloneDraft(draft),
          prompt: source.basePrompt ?? source.prompt ?? "",
          layers: structuredClone(source.layers || []),
          size: normalizeCanvasSize(source.size ?? ""),
          style: source.style || "auto",
          transparent: source.transparent === true,
        }),
    references: upload
      ? [{ uploadId: source.id, role: "overall" }]
      : derive
        ? [{ jobId: source.id, role: "overall" }]
        : normalizeReferences(source.references),
    lineageContext: {
      sourceJobId: source.id,
      operation: derive || upload ? "derive" : "edit",
      newBranch: !derive && !upload,
    },
  };
}
export function reconcileDraft(
  draft: Draft,
  jobs: ImageSource[],
  uploads: ImageSource[],
): Draft {
  const sources = reconcileDraftSources(draft, {
    jobs,
    uploads,
    jobsLoaded: true,
    uploadsLoaded: true,
  });
  if (
    sources.lineageContext?.operation === "derive" &&
    !sources.references.some(
      (ref) =>
        (ref.jobId || ref.uploadId) === sources.lineageContext?.sourceJobId,
    )
  )
    sources.lineageContext = null;
  if (
    JSON.stringify(sources.references) === JSON.stringify(draft.references) &&
    sources.lineageContext === draft.lineageContext
  )
    return draft;
  return { ...draft, ...sources };
}
