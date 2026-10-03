import { imageTitle, isComplete } from "@/lib/format";
import { referenceInfo } from "@/lib/reference-info";
import { useStudio } from "@/lib/studio-context";
import type { ImageSource, Reference } from "@/lib/types";
import { referenceRoles } from "@shared/prompt-utils.js";
import { uploadFileType } from "@shared/studio-features.js";
import {
  ArrowLeft, Check, ImagePlus, Loader2, Maximize2, Search, Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
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
    [preview, setPreview] = useState<ImageSource | null>(null),
    [previewError, setPreviewError] = useState(false),
    [added, setAdded] = useState<ImageSource[]>([]);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const previewBack = useRef<HTMLButtonElement>(null);
  const uploadLock = useRef(false);
  useEffect(() => {
    if (open) {
      setPending(structuredClone(studio.draft.references));
      setError("");
      setPreview(null);
    }
  }, [open]);
  useEffect(() => {
    if (preview) previewBack.current?.focus();
    else previewTrigger.current?.focus();
  }, [preview]);
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
      referenceInfo(s).label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const previewSelected = !!preview && pending.some(
    (ref) => (ref.jobId || ref.uploadId) === preview.id,
  );
  const previewInfo = preview ? referenceInfo(preview) : null;
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
        className={`flex max-h-[90dvh] flex-col sm:max-w-3xl ${preview ? "h-[90dvh]" : ""}`}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
          else if (preview) {
            e.preventDefault();
            setPreview(null);
          }
        }}
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        {preview && previewInfo && (
          <>
            <DialogHeader className="shrink-0 pr-6 text-left">
              <DialogTitle>参照候補を確認</DialogTitle>
              <DialogDescription className="text-foreground">
                {previewInfo.ordinal} · {previewInfo.unit}
                <span className="mt-1 block text-xs text-muted-foreground">
                  {previewInfo.timestamp}
                </span>
              </DialogDescription>
              <p className="max-h-[16dvh] overflow-y-auto break-words text-sm">
                {imageTitle(preview)}
              </p>
            </DialogHeader>
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-muted/30">
              <img
                key={preview.id}
                src={preview.image?.url}
                alt={previewInfo.label}
                className={`size-full object-contain ${previewError ? "invisible" : ""}`}
                onError={() => setPreviewError(true)}
              />
              {previewError && (
                <p role="alert" className="absolute inset-0 flex items-center justify-center bg-background/90 p-4 text-sm">
                  画像を読み込めませんでした。選択は保持されています。
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button ref={previewBack} variant="outline" onClick={() => setPreview(null)}>
                <ArrowLeft className="size-4" />候補に戻る
              </Button>
              <Button
                variant={previewSelected ? "secondary" : "default"}
                aria-pressed={previewSelected}
                aria-label={`${previewInfo.label}を${previewSelected ? "参照から外す" : "参照に選択"}`}
                onClick={() => toggle(preview)}
              >
                {previewSelected && <Check className="size-4" />}
                {previewSelected ? "参照から外す" : "参照に選択"}
              </Button>
              <p role="status" className="text-xs text-muted-foreground">{pending.length} / 4枚選択</p>
            </div>
          </>
        )}
        <div hidden={!!preview} className={preview ? "hidden" : "contents"}>
        {!preview && <DialogHeader>
          <DialogTitle>参照画像を選ぶ</DialogTitle>
          <DialogDescription>
            生成済み・アップロード画像から最大4枚。入力中のプロンプトと設定を保持します。
          </DialogDescription>
        </DialogHeader>}
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
              const info = referenceInfo(source);
              return (
                <div key={source.id} className="min-w-0">
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={selected}
                  aria-label={`${info.label}を${selected ? "参照から外す" : "参照に選択"}`}
                  onClick={() => toggle(source)}
                  className={`relative w-full min-w-0 overflow-hidden rounded-lg border-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary" : "border-transparent hover:border-input"}`}
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
                  <span className="mt-1 block text-xs font-medium">{info.ordinal}</span>
                  <span className="block break-words text-[11px] text-muted-foreground" title={source.batch?.id || source.id}>{info.unit}</span>
                  <span className="block text-[11px] text-muted-foreground">{info.timestamp}</span>
                  {selected && (
                    <span className="absolute right-2 top-2 rounded-full bg-primary p-1 text-white">
                      <Check className="size-3" />
                    </span>
                  )}
                </button>
                <Button
                  variant="outline"
                  className="mt-1 w-full"
                  disabled={busy}
                  aria-label={`${info.label}を大きく確認`}
                  onClick={(event) => {
                    previewTrigger.current = event.currentTarget;
                    setPreviewError(false);
                    setPreview(source);
                  }}
                >
                  <Maximize2 className="size-3.5" />大きく確認
                </Button>
                </div>
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
          <div className="max-h-[22dvh] shrink-0 space-y-2 overflow-y-auto border-t pt-3">
            {pending.map((ref) => {
              const id = ref.jobId || ref.uploadId,
                source = all.find((s) => s.id === id);
              return (
                <div key={id} className="flex min-w-0 items-center gap-3">
                  <div className="min-w-0 flex-1 text-xs">
                    <p className="truncate">{source ? imageTitle(source) : "参照画像"}</p>
                    {source && <p className="text-[11px] text-muted-foreground">{referenceInfo(source).ordinal} · {referenceInfo(source).unit}</p>}
                  </div>
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
                      aria-label={`${source ? referenceInfo(source).label : "参照画像"}の役割`}
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
        <DialogFooter className="shrink-0 flex-row flex-wrap items-center">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
