import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { createApi } from "@/lib/api";
import { StudioContext } from "@/lib/studio-context";
import {
  cloneDraft,
  draftKey,
  loadDraft,
  reconcileDraft,
  sourceDraft,
} from "@/lib/draft";
import type {
  Draft,
  ImageSource,
  LineageMetadata,
  Template,
  View,
  StudioContextValue,
} from "@/lib/types";
import { StudioDialogs } from "./studio-dialogs";
const api = createApi();
export function StudioProvider({ children }: { children: ReactNode }) {
  const [saved, setSaved] = useState(() => loadDraft());
  const draftRef = useRef(saved.current);
  draftRef.current = saved.current;
  const [draftSaved, setDraftSaved] = useState(true);
  const [jobs, setJobs] = useState<ImageSource[]>([]),
    [uploads, setUploads] = useState<ImageSource[]>([]),
    [templates, setTemplates] = useState<Template[]>([]);
  const [metadata, setMetadata] = useState<LineageMetadata>({
    commits: [],
    branches: [],
    uploads: [],
  });
  const [health, setHealth] = useState<StudioContextValue["health"]>(null);
  const [loading, setLoading] = useState(true),
    [loadingError, setLoadingError] = useState("");
  const [view, setView] = useState<View>("create"),
    [selectedId, select] = useState<string | null>(null),
    [graphBatchId, setGraphBatchId] = useState("");
  const [submitting, setSubmitting] = useState(false),
    submitLock = useRef(false);
  const [preview, setPreview] = useState<ImageSource | null>(null),
    [deleting, setDeleting] = useState<ImageSource | null>(null),
    [trash, setTrash] = useState(false);
  const refreshing = useRef<Promise<void> | null>(null);
  const favoriteLocks = useRef(new Set<string>());
  const [favoritePendingIds, setFavoritePendingIds] = useState<string[]>([]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(saved));
      setDraftSaved(true);
    } catch {
      setDraftSaved(false);
    }
  }, [saved]);
  const refresh = useCallback(async (force = false) => {
    if (refreshing.current && !force) return refreshing.current;
    while (refreshing.current) await refreshing.current;
    refreshing.current = (async () => {
      try {
        const [j, u, t, m] = await Promise.all([
          api<{ jobs: ImageSource[] }>("/api/jobs"),
          api<{ uploads: ImageSource[] }>("/api/uploads"),
          api<{ templates: Template[] }>("/api/templates?all=1"),
          api<LineageMetadata>("/api/lineage"),
        ]);
        setJobs(j.jobs);
        setUploads(u.uploads);
        setTemplates(t.templates);
        setMetadata(m);
        setLoadingError("");
        setSaved((previous) => {
          const current = reconcileDraft(previous.current, j.jobs, u.uploads),
            undo = previous.undo
              ? reconcileDraft(previous.undo, j.jobs, u.uploads)
              : null;
          return current === previous.current && undo === previous.undo
            ? previous
            : { current, undo };
        });
      } catch (error) {
        setLoadingError(
          error instanceof Error
            ? error.message
            : "データを読み込めませんでした。",
        );
      } finally {
        setLoading(false);
      }
    })().finally(() => {
      refreshing.current = null;
    });
    return refreshing.current;
  }, []);
  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api("/api/health?refresh=1"));
    } catch (error) {
      setHealth({
        ready: false,
        message:
          error instanceof Error ? error.message : "接続を確認してください。",
      });
    }
  }, []);
  useEffect(() => {
    void refresh();
    void refreshHealth();
    const poll = setInterval(() => void refresh(), 2500);
    const healthPoll = setInterval(() => void refreshHealth(), 30000);
    return () => {
      clearInterval(poll);
      clearInterval(healthPoll);
    };
  }, [refresh, refreshHealth]);
  const updateDraft: StudioContextValue["updateDraft"] = (change) =>
    setSaved((previous) => {
      const current =
        typeof change === "function"
          ? change(previous.current)
          : { ...previous.current, ...change };
      if (
        current.lineageContext?.operation === "derive" &&
        !current.references.some(
          (ref) =>
            (ref.jobId || ref.uploadId) === current.lineageContext?.sourceJobId,
        )
      )
        current.lineageContext = null;
      return { ...previous, current };
    });
  const replace = (change: (draft: Draft) => Draft) =>
    setSaved((previous) => ({
      current: change(previous.current),
      undo: cloneDraft(previous.current),
    }));
  const navigate: StudioContextValue["navigate"] = (next, id, batchId) => {
    setView(next);
    if (next === "create") setPreview(null);
    if (id) select(id);
    if (batchId !== undefined) setGraphBatchId(batchId);
  };
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "処理に失敗しました。",
      );
    }
  };
  const addReference: StudioContextValue["addReference"] = (
    source,
    role = "overall",
  ) => {
    const current = draftRef.current;
    if (
      current.references.some(
        (ref) => (ref.jobId || ref.uploadId) === source.id,
      )
    ) {
      toast.info("この画像は参照に追加済みです。");
      navigate("create");
      return false;
    }
    if (current.references.length >= 4) {
      toast.error(
        "参照画像は4枚までです。制作画面で参照を外してから追加してください。",
      );
      return false;
    }
    updateDraft({
      references: [
        ...current.references,
        { [source.kind === "upload" ? "uploadId" : "jobId"]: source.id, role },
      ],
    });
    navigate("create");
    toast.success("参照に追加しました。入力中の内容は保持しています。");
    return true;
  };
  const addTemplate = (template: Template) => {
    const existing = draftRef.current.layers.find(
      (layer) => layer.id === template.id,
    );
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(template)) {
        toast.info("この版は追加済みです。");
        return false;
      }
      updateDraft({
        layers: draftRef.current.layers.map((layer) =>
          layer.id === template.id ? structuredClone(template) : layer,
        ),
      });
      toast.success("選択中のテンプレートをこの版に更新しました。");
      return true;
    }
    if (draftRef.current.layers.length >= 12) {
      toast.error("テンプレートは12件までです。");
      return false;
    }
    updateDraft({
      layers: [...draftRef.current.layers, structuredClone(template)],
    });
    toast.success("テンプレートを追加しました。");
    return true;
  };
  const acceptGeneration = async (result: {
    jobs?: ImageSource[];
    id?: string;
  }) => {
    const accepted = result.jobs || (result.id ? [result as ImageSource] : []);
    setJobs((previous) => [
      ...accepted,
      ...previous.filter(
        (source) => !accepted.some((item) => item.id === source.id),
      ),
    ]);
    const id = accepted[0]?.id;
    if (id) select(id);
    setView("create");
    setPreview(null);
    await refresh(true);
    toast.success("画像生成を開始しました。");
  };
  const generate = async () => {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      const d = cloneDraft(draftRef.current);
      const { lineageContext, count, ...input } = d;
      const result = await api<{ jobs?: ImageSource[]; id?: string }>(
        count > 1 ? "/api/batches" : "/api/jobs",
        {
          method: "POST",
          body: JSON.stringify({
            ...input,
            ...(lineageContext ? { lineageContext } : {}),
            ...(count > 1 ? { count } : {}),
          }),
        },
      );
      await acceptGeneration(result);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "生成を開始できませんでした。",
      );
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };
  const retry = async (source: ImageSource) => {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      const count = draftRef.current.count;
      await acceptGeneration(
        await api(
          `/api/jobs/${source.id}/${count > 1 ? "retry-batch" : "retry"}`,
          {
            method: "POST",
            ...(count > 1 ? { body: JSON.stringify({ count }) } : {}),
          },
        ),
      );
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };
  const value: StudioContextValue = {
    api,
    jobs,
    uploads,
    templates,
    metadata,
    health,
    loading,
    loadingError,
    refresh: () => refresh(true),
    refreshHealth,
    draft: saved.current,
    updateDraft,
    canUndo: !!saved.undo,
    undoDraft: () =>
      setSaved((previous) =>
        previous.undo
          ? { current: cloneDraft(previous.undo), undo: null }
          : previous,
      ),
    draftSaved,
    view,
    navigate,
    selectedId,
    select,
    graphBatchId,
    setGraphBatchId,
    addReference,
    addTemplate,
    replaceFromSource: (source, derive = false) => {
      replace((d) => sourceDraft(d, source, derive));
      navigate("create");
      toast.success("入力を読み込みました。「元に戻す」で変更前に戻せます。");
    },
    applyExample: (prompt) => replace((d) => ({ ...d, prompt })),
    generate,
    submitting,
    retry,
    cancel: async (source) => {
      await api(`/api/jobs/${source.id}/cancel`, { method: "POST" });
      await refresh(true);
      toast.success("生成を停止しました。");
    },
    favoritePendingIds,
    setFavorite: async (source, favorite) => {
      if (favoriteLocks.current.has(source.id)) return;
      favoriteLocks.current.add(source.id);
      setFavoritePendingIds([...favoriteLocks.current]);
      try {
        const updated = await api<ImageSource>(`/api/jobs/${source.id}/favorite`, {
          method: "PATCH",
          body: JSON.stringify({ favorite }),
        });
        // Finish any earlier poll before loading the saved state.
        await refresh(true);
        setJobs((previous) =>
          previous.map((job) =>
            job.id === source.id ? { ...job, favorite: updated.favorite } : job,
          ),
        );
      } finally {
        favoriteLocks.current.delete(source.id);
        setFavoritePendingIds([...favoriteLocks.current]);
      }
    },
    openPreview: setPreview,
    requestDelete: setDeleting,
    openTrash: () => setTrash(true),
    run,
  };
  return (
    <StudioContext.Provider value={value}>
      {children}
      <StudioDialogs
        preview={preview}
        onPreview={setPreview}
        deleting={deleting}
        onDelete={setDeleting}
        trash={trash}
        onTrash={setTrash}
      />
    </StudioContext.Provider>
  );
}
