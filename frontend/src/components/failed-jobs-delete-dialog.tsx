import { type ComponentProps, useEffect, useState } from "react";
import { LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { useStudio } from "@/lib/studio-context";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type FailedDeletionPlan = {
  planToken: string;
  count: number;
  nodes: { id: string; title: string; status: string }[];
};

export function FailedJobsDeleteDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}) {
  const studio = useStudio();
  const [plan, setPlan] = useState<FailedDeletionPlan | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setPlan(null);
    if (!open) {
      setError("");
      return;
    }
    let active = true;
    setLoading(true);
    studio.api<FailedDeletionPlan>("/api/jobs/failed/deletion-preview")
      .then((value) => { if (active) setPlan(value); })
      .catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, revision, studio.api]);

  const remove = async () => {
    if (!plan?.count || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await studio.api<{ deletedIds: string[]; count: number }>(
        "/api/jobs/failed",
        { method: "DELETE", body: JSON.stringify({ planToken: plan.planToken }) },
      );
      if (studio.selectedId && result.deletedIds.includes(studio.selectedId))
        studio.select(null);
      await studio.refresh();
      onOpenChange(false);
      toast.success(`エラー画像${result.count}件をゴミ箱へ移動しました。`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "DELETE_PLAN_CHANGED") {
        setPlan(null);
        setError("エラー画像の件数が変わりました。更新された一覧を確認して、もう一度削除してください。");
        setRevision((value) => value + 1);
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className="sm:max-w-xl"
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>エラー画像を一括削除</DialogTitle>
          <DialogDescription>
            検索・絞り込み条件に関係なく、生成履歴全体のエラー画像だけをゴミ箱へ移動します。完成済み・生成中・待機中・キャンセル済みの画像は残ります。生成条件は保存され、ゴミ箱からまとめて復元できます。
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {loading && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <LoaderCircle className="size-4 animate-spin" />
            エラー画像を確認中…
          </p>
        )}
        {plan && (
          <>
            <p className="font-medium">
              {plan.count ? `削除対象：エラー画像 ${plan.count}件` : "削除するエラー画像はありません。"}
            </p>
            {plan.count > 0 && (
              <ul aria-label="削除するエラー画像" className="max-h-64 overflow-y-auto rounded-lg border">
                {plan.nodes.map((node) => (
                  <li key={node.id} className="truncate border-b p-3 text-sm last:border-0" title={node.title}>
                    {node.title || "画像の生成"}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {!plan && error && !loading && (
          <Button variant="outline" onClick={() => { setError(""); setRevision((value) => value + 1); }}>
            <RotateCcw className="size-4" />再読み込み
          </Button>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>キャンセル</Button>
          <Button variant="destructive" disabled={!plan?.count || loading || busy} onClick={() => void remove()}>
            <Trash2 className="size-4" />
            {busy ? "移動中…" : `${plan?.count || 0}件をゴミ箱に移動`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
