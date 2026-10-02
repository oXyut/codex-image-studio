import { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { useStudio } from "@/lib/studio-context";
import { imageTitle, isComplete } from "@/lib/format";
import type { ImageSource, Reference } from "@/lib/types";
import { uploadFileType } from "@legacy/studio-features.js";
import { referenceRoles } from "@legacy/prompt-utils.js";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
export function ReferencePicker({
  open,
  onOpenChange,
  onBusy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const studio = useStudio(),
    fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Reference[]>([]),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("all"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [added, setAdded] = useState<ImageSource[]>([]);
  const uploadLock = useRef(false);
  useEffect(() => {
    if (open) {
      setPending(structuredClone(studio.draft.references));
      setError("");
    }
  }, [open]);
  useEffect(() => {
    setAdded((previous) =>
      previous.filter(
        (source) => !studio.uploads.some((item) => item.id === source.id),
      ),
    );
  }, [studio.uploads]);
  const all = [
    ...studio.uploads,
    ...added.filter(
      (source) => !studio.uploads.some((s) => s.id === source.id),
    ),
    ...studio.jobs.filter(isComplete),
  ];
  const sources = all.filter(
    (s) =>
      (kind === "all" || (kind === "uploads") === (s.kind === "upload")) &&
      imageTitle(s).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const toggle = (source: ImageSource) => {
    setPending((current) => {
      if (current.some((ref) => (ref.jobId || ref.uploadId) === source.id))
        return current.filter(
          (ref) => (ref.jobId || ref.uploadId) !== source.id,
        );
      if (current.length >= 4) {
        toast.error("参照画像は4枚までです。");
        return current;
      }
      return [
        ...current,
        {
          [source.kind === "upload" ? "uploadId" : "jobId"]: source.id,
          role: "overall",
        },
      ];
    });
  };
  const upload = async (files: File[]) => {
    if (uploadLock.current || !files.length) return;
    setError("");
    try {
      files.forEach(uploadFileType);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    uploadLock.current = true;
    setBusy(true);
    onBusy(true);
    try {
      for (const file of files) {
        const source = await studio.api<ImageSource>(
          `/api/uploads?name=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            headers: { "Content-Type": uploadFileType(file) },
            body: file,
          },
        );
        setAdded((previous) => [source, ...previous]);
        setPending((current) =>
          current.length < 4
            ? [...current, { uploadId: source.id, role: "overall" }]
            : current,
        );
      }
      await studio.refresh();
      toast.success("画像をアップロードしました。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      uploadLock.current = false;
      setBusy(false);
      onBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col sm:max-w-3xl"
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>参照画像を選ぶ</DialogTitle>
          <DialogDescription>
            生成済み・アップロード画像から最大4枚。入力中のプロンプトと設定を保持します。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={kind} onValueChange={setKind}>
            <TabsList>
              <TabsTrigger value="all">すべて</TabsTrigger>
              <TabsTrigger value="generated">生成画像</TabsTrigger>
              <TabsTrigger value="uploads">アップロード</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative min-w-36 flex-1">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="参照画像を検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="画像名・プロンプトで検索"
              className="pl-9"
            />
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="sr-only"
          aria-label="参照画像をアップロード"
          disabled={busy}
          onChange={(e) => void upload(Array.from(e.target.files || []))}
        />
        <button
          type="button"
          disabled={busy}
          className="flex items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/30 px-4 py-5 text-sm focus-visible:ring-2"
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload(Array.from(e.dataTransfer.files));
          }}
        >
          {busy ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Upload className="size-5" />
          )}
          <span>
            {busy ? "アップロード中…" : "画像をドロップ、またはファイルを選択"}
            <span className="mt-1 block text-xs text-muted-foreground">
              PNG・JPEG・WebP / 1枚10MBまで
            </span>
          </span>
        </button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {sources.map((source) => {
              const selected = pending.some(
                (ref) => (ref.jobId || ref.uploadId) === source.id,
              );
              return (
                <button
                  key={source.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={selected}
                  aria-label={`${imageTitle(source)}を${selected ? "参照から外す" : "参照に選択"}`}
                  onClick={() => toggle(source)}
                  className={`relative min-w-0 overflow-hidden rounded-lg border-2 text-left ${selected ? "border-primary" : "border-transparent hover:border-input"}`}
                >
                  <img
                    src={source.image?.url}
                    alt=""
                    loading="lazy"
                    className="aspect-square w-full rounded-md bg-muted object-cover"
                  />
                  <span className="mt-1 block truncate text-xs">
                    {imageTitle(source)}
                  </span>
                  {selected && (
                    <span className="absolute right-2 top-2 rounded-full bg-primary p-1 text-white">
                      <Check className="size-3" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {!sources.length && (
            <div className="py-10 text-center text-muted-foreground">
              <ImagePlus className="mx-auto mb-2 size-7" />
              <p>選択できる画像がありません</p>
              <p className="text-xs">
                画像をアップロードするか、制作画面で生成してください。
              </p>
            </div>
          )}
        </div>
        {!!pending.length && (
          <div className="space-y-2 border-t pt-3">
            {pending.map((ref) => {
              const id = ref.jobId || ref.uploadId,
                source = all.find((s) => s.id === id);
              return (
                <div key={id} className="flex min-w-0 items-center gap-3">
                  <span className="flex-1 truncate text-xs">
                    {source ? imageTitle(source) : "参照画像"}
                  </span>
                  <Select
                    value={ref.role}
                    onValueChange={(role) =>
                      setPending((current) =>
                        current.map((r) =>
                          (r.jobId || r.uploadId) === id ? { ...r, role } : r,
                        ),
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={`${source ? imageTitle(source) : "参照画像"}の役割`}
                      className="h-8 w-32"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {referenceRoles.map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter className="items-center">
          <p className="mr-auto text-sm text-muted-foreground">
            {pending.length} / 4枚選択
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            キャンセル
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              studio.updateDraft({ references: pending });
              onOpenChange(false);
            }}
          >
            選択を反映
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
