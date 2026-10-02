import {
  ImageActionMenu,
  ImageContextMenu,
  ImageDownload,
  ImageFavoriteButton,
} from "@/components/image-actions";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { dateLabel, errorMessage, imageTitle, isComplete, statusLabels, styleLabels } from "@/lib/format";
import { useStudio } from "@/lib/studio-context";
import type { ImageSource } from "@/lib/types";
import { canvasSizeLabel } from "@shared/canvas-options.js";
import { buildLineageGraph } from "@shared/lineage-utils.js";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Expand,
  FileText,
  GitBranch,
  ImageIcon,
  ImagePlus,
  LoaderCircle,
  Pencil,
  Save,
  Square,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

function ImageRelations({
  title,
  sources,
  empty,
}: {
  title: string;
  sources: ImageSource[];
  empty: string;
}) {
  const studio = useStudio();
  return (
    <section className="space-y-3">
      <h4 className="text-sm font-medium">
        {title}{" "}
        <span className="text-muted-foreground">{sources.length}枚</span>
      </h4>
      {sources.length ? (
        <div className="grid grid-cols-3 gap-2">
          {sources.map((source) => (
            <button
              key={source.id}
              type="button"
              onClick={() => studio.openPreview(source)}
              className="group min-w-0 rounded-lg border bg-muted/30 p-1 text-left transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${imageTitle(source)}の詳細を見る`}
            >
              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted">
                {source.image ? (
                  <img
                    src={source.image.url}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover"
                  />
                ) : (
                  <ImageIcon className="size-5 text-muted-foreground" />
                )}
              </div>
              <p className="mt-1 truncate text-sm">
                {source.batch ? `${source.batch.index}. ` : ""}
                {imageTitle(source)}
              </p>
              <p className="text-sm text-muted-foreground">
                {statusLabels[source.status] || source.status}
              </p>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

export function ImageInspector({
  source,
  mode = "history",
  onClose,
  showPreview = true,
}: {
  source: ImageSource;
  mode?: "history" | "lineage";
  onClose?: () => void;
  showPreview?: boolean;
}) {
  const studio = useStudio();
  const id = useId();
  const graph = useMemo(
    () => buildLineageGraph(studio.metadata, studio.jobs),
    [studio.metadata, studio.jobs],
  );
  const node = graph.nodeMap.get(source.id);
  const metadata = node
    ? { title: node.title, notes: node.notes, branchId: node.branchId }
    : source.lineage;
  const title = metadata?.title || imageTitle(source);
  const branch = node?.branch;
  const [titleInput, setTitleInput] = useState(title);
  const [notes, setNotes] = useState(metadata?.notes || "");
  const [branchName, setBranchName] = useState(branch?.name || "");
  const [saving, setSaving] = useState(false);
  const [savingBranch, setSavingBranch] = useState(false);
  const complete = isComplete(source);
  const active = ["queued", "running"].includes(source.status);
  const uploaded = source.kind === "upload";
  const error = typeof source.error === "object" ? source.error : null;
  const details =
    source.errorDetails ||
    (typeof error?.details === "string" ? error.details : "") ||
    "この履歴には詳しい理由が保存されていません。生成時の入力は保持されています。";
  const resolveSources = (ids: string[]) =>
    ids
      .map((value) => graph.nodeMap.get(value)?.job)
      .filter(Boolean) as ImageSource[];
  const parents = resolveSources(
    node?.parentIds ||
      source.references
        ?.map((reference) => reference.jobId || reference.uploadId || "")
        .filter(Boolean) ||
      [],
  );
  const sourceId = node?.sourceJobId || source.lineage?.sourceJobId;
  const origin =
    sourceId && !parents.some((parent) => parent.id === sourceId)
      ? resolveSources([sourceId])
      : [];
  const descendants = resolveSources([
    ...new Set(
      graph.edges
        .filter((edge) => edge.from === source.id)
        .map((edge) => edge.to),
    ),
  ]);
  const peers = source.batch
    ? studio.jobs
        .filter((job) => job.batch?.id === source.batch?.id)
        .sort((a, b) => a.batch!.index - b.batch!.index)
    : [];

  useEffect(() => {
    setTitleInput(title);
    setNotes(metadata?.notes || "");
  }, [source.id, title, metadata?.notes]);
  useEffect(() => {
    setBranchName(branch?.name || "");
  }, [source.id, branch?.name]);

  async function saveAnnotations(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await studio.api(
        `/api/lineage/${uploaded ? "uploads" : "jobs"}/${source.id}`,
        { method: "PATCH", body: JSON.stringify({ title: titleInput, notes }) },
      );
      await studio.refresh();
      toast.success("タイトルとメモを保存しました。");
    } catch (failure) {
      toast.error(
        failure instanceof Error ? failure.message : "保存できませんでした。",
      );
    } finally {
      setSaving(false);
    }
  }
  async function saveBranch(event: FormEvent) {
    event.preventDefault();
    if (savingBranch || !metadata?.branchId) return;
    setSavingBranch(true);
    try {
      await studio.api(`/api/lineage/branches/${metadata.branchId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: branchName }),
      });
      await studio.refresh();
      toast.success("ブランチ名を変更しました。");
    } catch (failure) {
      toast.error(
        failure instanceof Error ? failure.message : "変更できませんでした。",
      );
    } finally {
      setSavingBranch(false);
    }
  }

  return (
    <div className="image-inspector flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b px-5 py-4">
        <h2 className="font-semibold">画像の詳細</h2>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="画像の詳細を閉じる"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5">
        {showPreview && (
          <ImageContextMenu source={source}>
            <button
              type="button"
              className="group relative flex aspect-[3/2] w-full items-center justify-center overflow-hidden rounded-xl border bg-muted/50 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => studio.openPreview(source)}
              disabled={!source.image}
              aria-label="画像を拡大プレビュー"
            >
              {source.image ? (
                <>
                  <img
                    src={source.image.url}
                    alt={title}
                    className="size-full object-contain"
                  />
                  <span className="absolute bottom-2 right-2 rounded-md bg-background/90 p-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    <Expand className="size-4" />
                  </span>
                </>
              ) : (
                <div className="space-y-3 p-5 text-center text-muted-foreground">
                  {active ? (
                    <LoaderCircle className="mx-auto size-8 animate-spin" />
                  ) : (
                    <ImageIcon className="mx-auto size-8" />
                  )}
                  <p className="text-sm">
                    {statusLabels[source.status] || source.status}
                  </p>
                </div>
              )}
            </button>
          </ImageContextMenu>
        )}
        <div className="space-y-2">
          <h3 className="break-words text-lg font-semibold leading-snug">
            {title}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              {complete ? (
                <CheckCircle2 className="size-4 text-emerald-600" />
              ) : (
                <Clock className="size-4" />
              )}
              {statusLabels[source.status] || source.status}
            </span>
            <span>·</span>
            <time dateTime={source.createdAt}>
              {dateLabel(source.createdAt)}
            </time>
            {source.batch && (
              <>
                <span>·</span>
                <span>
                  {source.batch.index} / {source.batch.count}
                </span>
              </>
            )}
          </div>
          {branch && (
            <Badge variant="secondary">
              <GitBranch className="mr-1 size-3.5" />
              {branch.name}
            </Badge>
          )}
        </div>
        {source.status === "failed" && (
          <Alert variant="destructive">
            <AlertTitle>生成に失敗しました</AlertTitle>
            <AlertDescription className="space-y-2">
              <p className="whitespace-pre-wrap break-words">
                {errorMessage(source)}
              </p>
              {typeof error?.advice === "string" && <p>{error.advice}</p>}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => studio.replaceFromSource(source)}
              >
                <Pencil className="size-4" />
                内容を編集して再試行
              </Button>
              <details className="text-sm">
                <summary className="cursor-pointer py-2">エラーの詳細</summary>
                <p className="whitespace-pre-wrap break-words">{details}</p>
              </details>
            </AlertDescription>
          </Alert>
        )}
        {active && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <p className="text-sm text-muted-foreground" role="status">
              {source.message ||
                (source.status === "queued"
                  ? "順番待ちです。開始までこのままお待ちください。"
                  : "画像を生成しています。")}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                void studio.run(() => studio.cancel(source));
              }}
            >
              <Square className="size-4" />
              生成を停止
            </Button>
          </div>
        )}
        {!complete &&
          !uploaded &&
          source.status !== "failed" &&
          mode === "history" && (
            <div className="space-y-2">
              <Button
                variant="outline"
                className="h-auto min-h-10 w-full whitespace-normal py-2"
                onClick={() => studio.replaceFromSource(source)}
              >
                <Pencil className="size-4 shrink-0" />
                元の入力に置き換えて編集
              </Button>
              <p className="text-sm leading-relaxed text-muted-foreground">
                元の入力・参照・設定を復元します。元に戻せます。
              </p>
            </div>
          )}
        {complete && (
          <div className="space-y-3">
            <Button
              className="w-full"
              onClick={() =>
                mode === "lineage"
                  ? studio.replaceFromSource(source, true)
                  : studio.addReference(source)
              }
            >
              {mode === "lineage" ? (
                <GitBranch className="size-4" />
              ) : (
                <ImagePlus className="size-4" />
              )}
              {mode === "lineage" ? "この画像を参照して編集" : "参照に追加"}
            </Button>
            <p className="text-center text-sm leading-relaxed text-muted-foreground">
              {mode === "history"
                ? "編集中の入力・設定を保持します。"
                : uploaded
                  ? "入力を保持し、参照だけ置き換えます。元に戻せます。"
                  : "元の入力・設定とこの画像を読み込みます。元に戻せます。"}
            </p>
            {mode === "lineage" && (
              <>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => studio.addReference(source)}
                >
                  <ImagePlus className="size-4" />
                  参照に追加
                </Button>
                <p className="text-center text-sm leading-relaxed text-muted-foreground">
                  参照への追加は、現在の入力を保持します。
                </p>
              </>
            )}
            {mode === "history" && !uploaded && (
              <>
                <Button
                  variant="outline"
                  className="h-auto min-h-10 w-full whitespace-normal py-2"
                  onClick={() => studio.replaceFromSource(source)}
                >
                  <Pencil className="size-4 shrink-0" />
                  元の入力に置き換えて編集
                </Button>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  元の入力・参照・設定を復元します。元に戻せます。
                </p>
              </>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="link"
            className="h-auto p-0"
            onClick={() =>
              studio.navigate("lineage", source.id, source.batch?.id)
            }
          >
            系統図で見る
            <ArrowRight className="size-4" />
          </Button>
          <div className="flex gap-2">
            <ImageFavoriteButton source={source} />
            <ImageDownload source={source} />
            <ImageActionMenu
              source={source}
              includeDerive={mode === "history" && complete}
              includeRestore={mode === "lineage" && source.status !== "failed"}
            />
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 border-t pt-5 text-sm">
          <dt className="text-muted-foreground">サイズ</dt>
          <dd className="text-right">
            {uploaded && source.image?.width
              ? `${source.image.width} × ${source.image.height}px`
              : canvasSizeLabel(source.size, { full: true })}
          </dd>
          {!uploaded && (
            <>
              <dt className="text-muted-foreground">スタイル</dt>
              <dd className="text-right">
                {styleLabels[source.style || "auto"] || source.style}
              </dd>
              <dt className="text-muted-foreground">背景透過</dt>
              <dd className="text-right">
                {source.transparent ? "リクエストあり" : "なし"}
              </dd>
              <dt className="text-muted-foreground">参照画像</dt>
              <dd className="text-right">{source.references?.length || 0}枚</dd>
              <dt className="text-muted-foreground">テンプレート</dt>
              <dd className="text-right">{source.layers?.length || 0}件</dd>
            </>
          )}
          {typeof source.image?.bytes === "number" && (
            <>
              <dt className="text-muted-foreground">ファイル</dt>
              <dd className="text-right">
                {(source.image.bytes / 1024 / 1024).toFixed(1)} MB
              </dd>
            </>
          )}
        </dl>
        <Accordion type="multiple" className="space-y-3">
          {!uploaded && (
            <AccordionItem value="prompt" className="rounded-lg border px-3">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <FileText className="size-4" />
                  生成時のプロンプト
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 text-sm">
                <p className="whitespace-pre-wrap break-words">
                  {source.basePrompt || source.prompt || "テンプレートから生成"}
                </p>
                {Boolean(source.layers?.length) && (
                  <div className="space-y-2">
                    <p className="font-medium">使用したテンプレート</p>
                    {source.layers?.map((layer) => (
                      <div key={layer.id} className="rounded-md bg-muted p-3">
                        <p className="font-medium">
                          {layer.name}
                          {layer.version ? ` · v${layer.version}` : ""}
                        </p>
                        <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
                          {layer.body}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
                {source.basePrompt && source.prompt !== source.basePrompt && (
                  <details>
                    <summary className="cursor-pointer py-2 font-medium">
                      テンプレートを含む全文
                    </summary>
                    <p className="whitespace-pre-wrap break-words">
                      {source.prompt}
                    </p>
                  </details>
                )}
              </AccordionContent>
            </AccordionItem>
          )}
          <AccordionItem value="relations" className="rounded-lg border px-3">
            <AccordionTrigger className="text-sm">
              参照元と、ここから生まれた画像
            </AccordionTrigger>
            <AccordionContent className="space-y-5">
              {peers.length > 1 && (
                <ImageRelations title="同時作成" sources={peers} empty="" />
              )}
              {!uploaded && (
                <ImageRelations
                  title="参照した画像"
                  sources={parents}
                  empty="参照画像なしで生成しました。"
                />
              )}
              {origin.length > 0 && (
                <ImageRelations
                  title={
                    node?.operation === "regenerate"
                      ? "再生成した元の履歴"
                      : "入力を引き継いだ履歴"
                  }
                  sources={origin}
                  empty=""
                />
              )}
              <ImageRelations
                title="ここから生まれた画像"
                sources={descendants}
                empty="まだ次の画像はありません。"
              />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="annotations" className="rounded-lg border px-3">
            <AccordionTrigger className="text-sm">
              タイトル・メモ
            </AccordionTrigger>
            <AccordionContent>
              <form className="space-y-4" onSubmit={saveAnnotations}>
                <div className="space-y-2">
                  <label
                    htmlFor={`${id}-title`}
                    className="text-sm font-medium"
                  >
                    タイトル
                  </label>
                  <Input
                    id={`${id}-title`}
                    maxLength={100}
                    required
                    value={titleInput}
                    onChange={(event) => setTitleInput(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor={`${id}-notes`}
                    className="text-sm font-medium"
                  >
                    メモ
                  </label>
                  <Textarea
                    id={`${id}-notes`}
                    maxLength={2000}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="変えた要素や、次に試したいこと"
                    className="min-h-24"
                  />
                </div>
                <Button type="submit" variant="outline" disabled={saving}>
                  <Save className="size-4" />
                  {saving ? "保存中…" : "タイトルとメモを保存"}
                </Button>
              </form>
            </AccordionContent>
          </AccordionItem>
          {branch && (
            <AccordionItem value="branch" className="rounded-lg border px-3">
              <AccordionTrigger className="text-sm">
                ブランチ名を変更
              </AccordionTrigger>
              <AccordionContent>
                <form className="space-y-3" onSubmit={saveBranch}>
                  <label
                    htmlFor={`${id}-branch`}
                    className="text-sm font-medium"
                  >
                    ブランチ名
                  </label>
                  <Input
                    id={`${id}-branch`}
                    maxLength={80}
                    required
                    value={branchName}
                    onChange={(event) => setBranchName(event.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={savingBranch}
                  >
                    {savingBranch ? "変更中…" : "変更を保存"}
                  </Button>
                </form>
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
        <p className="break-all text-sm text-muted-foreground">
          ID: {source.id}
        </p>
      </div>
    </div>
  );
}
