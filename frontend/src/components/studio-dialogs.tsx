import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useStudio } from "@/lib/studio-context";
import { imageTitle, dateLabel, statusLabels } from "@/lib/format";
import type { ImageSource } from "@/lib/types";
import { ApiError } from "@/lib/api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { ImageActions } from "./image-actions";
type PlanNode = {
  id: string;
  kind: "job" | "upload";
  title: string;
  status: string;
  image?: { url: string };
};
type Plan = {
  rootId: string;
  planToken: string;
  count: number;
  jobCount: number;
  uploadCount: number;
  activeCount: number;
  alreadyDeletedCount: number;
  nodes: PlanNode[];
};
type TrashGroup = {
  id: string;
  title: string;
  nodeCount: number;
  jobCount: number;
  uploadCount: number;
  deletedAt: string;
  rootId: string;
};
export function StudioDialogs({
  preview,
  onPreview,
  deleting,
  onDelete,
  trash,
  onTrash,
}: {
  preview: ImageSource | null;
  onPreview: (value: ImageSource | null) => void;
  deleting: ImageSource | null;
  onDelete: (value: ImageSource | null) => void;
  trash: boolean;
  onTrash: (value: boolean) => void;
}) {
  const studio = useStudio();
  const [plan, setPlan] = useState<Plan | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [groups, setGroups] = useState<TrashGroup[]>([]),
    [trashError, setTrashError] = useState(""),
    [trashLoading, setTrashLoading] = useState(false);
  const loadPlan = async (id: string, changed = false) => {
    setPlan(null);
    setError(
      changed
        ? "削除対象が変わりました。更新された一覧を確認して、もう一度削除してください。"
        : "",
    );
    try {
      setPlan(await studio.api(`/api/lineage/nodes/${id}/deletion-preview`));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (!deleting) {
      setPlan(null);
      setError("");
      return;
    }
    let active = true;
    setPlan(null);
    setError("");
    studio
      .api<Plan>(`/api/lineage/nodes/${deleting.id}/deletion-preview`)
      .then((value) => {
        if (active) setPlan(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [deleting?.id]);
  const loadTrash = async () => {
    setTrashLoading(true);
    setTrashError("");
    try {
      setGroups(
        (await studio.api<{ deletions: TrashGroup[] }>("/api/trash")).deletions,
      );
    } catch (e) {
      setTrashError((e as Error).message);
    } finally {
      setTrashLoading(false);
    }
  };
  useEffect(() => {
    if (trash) void loadTrash();
  }, [trash]);
  const remove = async () => {
    if (!deleting || !plan || busy) return;
    setBusy(true);
    try {
      await studio.api(`/api/lineage/nodes/${deleting.id}`, {
        method: "DELETE",
        body: JSON.stringify({ planToken: plan.planToken }),
      });
      onDelete(null);
      if (preview && plan.nodes.some((n) => n.id === preview.id))
        onPreview(null);
      await studio.refresh();
      toast.success(`${plan.count}件をゴミ箱へ移動しました。`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "DELETE_PLAN_CHANGED")
        await loadPlan(deleting.id, true);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const visible = [...studio.jobs, ...studio.uploads].filter((s) => s.image);
  const current = preview
    ? visible.find((s) => s.id === preview.id) || preview
    : null;
  const index = visible.findIndex((s) => s.id === current?.id);
  const previousImage = index > 0 ? visible[index - 1] : null;
  const nextImage = index >= 0 ? visible[index + 1] : null;
  return (
    <>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) onPreview(null);
        }}
      >
        <DialogContent
          className="flex max-h-[92dvh] w-[calc(100%-2rem)] flex-col sm:max-w-5xl"
          onKeyDown={(event) => {
            if (
              !["ArrowLeft", "ArrowRight"].includes(event.key) ||
              event.defaultPrevented ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              !(event.target instanceof HTMLElement) ||
              !event.currentTarget.contains(event.target) ||
              event.target.closest(
                'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const adjacent =
              event.key === "ArrowLeft" ? previousImage : nextImage;
            if (adjacent) onPreview(adjacent);
          }}
        >
          <DialogHeader>
            <DialogTitle className="truncate pr-7">
              {current && imageTitle(current)}
            </DialogTitle>
            <DialogDescription>
              {current && dateLabel(current.createdAt)} · 画像プレビュー
            </DialogDescription>
          </DialogHeader>
          {current && (
            <>
              <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted p-2">
                <img
                  src={current.image?.url}
                  alt={imageTitle(current)}
                  className="max-h-[62dvh] max-w-full object-contain"
                />
                {previousImage && (
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute left-3"
                    aria-label="前の画像"
                    onClick={() => onPreview(previousImage)}
                  >
                    <ChevronLeft />
                  </Button>
                )}
                {nextImage && (
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute right-3"
                    aria-label="次の画像"
                    onClick={() => onPreview(nextImage)}
                  >
                    <ChevronRight />
                  </Button>
                )}
              </div>
              <DialogFooter className="flex-wrap">
                <ImageActions source={current} compact />
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) onDelete(null);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
          className="sm:max-w-xl"
        >
          <DialogHeader>
            <DialogTitle>画像をゴミ箱に移動</DialogTitle>
            <DialogDescription>
              この画像と、参照・入力の引き継ぎでつながる下流の画像をまとめて非表示にします。ファイルと生成条件は保存され、ゴミ箱から復元できます。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {!plan && !error && (
            <p role="status" className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              削除対象を確認中…
            </p>
          )}
          {plan && (
            <>
              <p className="font-medium">
                {plan.count}件 · 生成履歴 {plan.jobCount}件 · アップロード{" "}
                {plan.uploadCount}枚
              </p>
              {plan.alreadyDeletedCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  すでに非表示の下流画像 {plan.alreadyDeletedCount}
                  件も、この削除グループに含めます。
                </p>
              )}
              {plan.activeCount > 0 && (
                <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                  生成中・待機中の{plan.activeCount}
                  件を停止します。復元しても自動では再開しません。
                </p>
              )}
              <div className="max-h-64 overflow-y-auto rounded-lg border">
                {plan.nodes.map((source) => (
                  <div
                    key={source.id}
                    className="flex items-center gap-3 border-b p-3 last:border-0"
                  >
                    {source.image?.url && (
                      <img
                        src={source.image.url}
                        alt=""
                        className="size-11 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="truncate">{source.title || "画像"}</p>
                      <p className="text-xs text-muted-foreground">
                        {source.id === plan.rootId ? "選んだ画像 · " : ""}
                        {statusLabels[source.status] || source.status}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onDelete(null)}
            >
              キャンセル
            </Button>
            <Button
              variant="destructive"
              disabled={!plan?.count || busy}
              onClick={() => void remove()}
            >
              <Trash2 />
              {busy ? "移動中…" : `${plan?.count || 0}件をゴミ箱に移動`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={trash} onOpenChange={onTrash}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>ゴミ箱</DialogTitle>
            <DialogDescription>
              削除した画像を、グループごとに復元できます。
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="outline"
            className="self-start"
            disabled={trashLoading || busy}
            onClick={() => void loadTrash()}
          >
            <RotateCcw />
            再読み込み
          </Button>
          {trashError && (
            <p role="alert" className="text-destructive">
              {trashError}
            </p>
          )}
          <div className="max-h-[60dvh] space-y-3 overflow-y-auto">
            {trashLoading ? (
              <p role="status">読み込み中…</p>
            ) : !groups.length ? (
              <p className="py-8 text-center text-muted-foreground">
                ゴミ箱は空です
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.id} className="rounded-lg border p-4">
                  <p className="font-medium">{group.title || "削除した画像"}</p>
                  <p className="text-sm text-muted-foreground">
                    {group.nodeCount}件 · {dateLabel(group.deletedAt)}
                  </p>
                  <Button
                    variant="outline"
                    className="mt-3"
                    disabled={busy}
                    onClick={() =>
                      void studio.run(async () => {
                        setBusy(true);
                        try {
                          const result = await studio.api<{
                            restoredIds: string[];
                            stillDeletedIds: string[];
                          }>(`/api/trash/${group.id}/restore`, {
                            method: "POST",
                          });
                          await studio.refresh();
                          await loadTrash();
                          toast.success(
                            `${result.restoredIds.length}件を復元しました。${result.stillDeletedIds.length ? "別の削除グループにも含まれる画像は非表示のままです。" : ""}`,
                          );
                        } finally {
                          setBusy(false);
                        }
                      })
                    }
                  >
                    <RotateCcw />
                    このグループを復元
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
