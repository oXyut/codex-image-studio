import { ImageActions, ImageContextMenu } from "@/components/image-actions";
import { ReferencePicker } from "@/components/reference-picker";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { dateLabel, imageTitle, statusLabels, styleLabels } from "@/lib/format";
import { draftMatchesSource, previewOrigin } from "@/lib/create-preview";
import { useStudio } from "@/lib/studio-context";
import { cn } from "@/lib/utils";
import { canvasSizeLabel } from "@shared/canvas-options.js";
import { batchVisibility } from "@shared/deletion-ui.js";
import { categoryLabel, composePrompt, referenceRoles } from "@shared/prompt-utils.js";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FilePlus,
  GitBranch,
  ImagePlus,
  Loader2,
  Maximize2,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { TemplatePicker } from "./templates";
import { GenerationRecovery } from "@/components/generation-recovery";
import "./create-layout.css";
const examples = [
  "朝のやわらかな光が差し込む、静かな森。木々の間に薄い霧が漂う。自然な写真の質感。",
  "白い背景に置いた、シンプルなガラスの香水ボトル。やわらかな影、スタジオ撮影。",
  "海辺の小さなカフェ。窓から差し込む午後の光、あたたかな色味のイラスト。",
];
export function CreateView({
  onSaveTemplate,
}: {
  onSaveTemplate: (body: string) => void;
}) {
  const studio = useStudio(),
    d = studio.draft;
  const [templateOpen, setTemplateOpen] = useState(false),
    [referenceOpen, setReferenceOpen] = useState(false),
    [uploading, setUploading] = useState(false),
    [promptOpen, setPromptOpen] = useState(false),
    [exampleOpen, setExampleOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(true);
  useEffect(() => {
    // Source-image edit actions must reveal the restored input at compact widths.
    if (d.lineageContext) setInputOpen(true);
  }, [d.lineageContext]);
  const fullPrompt = composePrompt(d.prompt, d.layers),
    source =
      studio.jobs.find((j) => j.id === studio.selectedId) || studio.jobs[0];
  const recentGeneration = studio.jobs.filter((job) =>
    (studio.recentGenerationIds || []).includes(job.id),
  );
  const showingRecentGeneration = source && recentGeneration.some((job) => job.id === source.id);
  const siblings = source?.batch
    ? studio.jobs
        .filter((j) => j.batch?.id === source.batch?.id)
        .sort((a, b) => (a.batch?.index || 0) - (b.batch?.index || 0))
    : source
      ? [source]
      : [];
  const [cancelling, setCancelling] = useState(false);
  const batchInfo = batchVisibility(siblings);
  const activeSiblings = siblings.filter((item) =>
    ["queued", "running"].includes(item.status),
  );
  const canGenerate =
    (d.prompt.trim() || d.layers.length > 0) &&
    fullPrompt.length <= 12000 &&
    studio.health?.ready &&
    !studio.submitting &&
    !uploading;
  const sources = [...studio.jobs, ...studio.uploads];
  const moveLayer = (index: number, delta: number) => {
    const layers = [...d.layers];
    [layers[index], layers[index + delta]] = [
      layers[index + delta],
      layers[index],
    ];
    studio.updateDraft({ layers });
  };
  return (
    <div className="flex h-full min-h-0 flex-col pb-44 md:pb-0">
      <header className="flex min-h-20 shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-white px-6 py-4 lg:min-h-[88px] lg:px-7">
        <h1 className="text-2xl font-semibold">新しい画像</h1>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {studio.draftSaved ? (
              <>
                <Check className="mr-1 inline size-4 text-emerald-700" />
                下書き保存済み
              </>
            ) : (
              "下書きを保存できません"
            )}
          </span>
          {studio.canUndo && (
            <Button variant="outline" size="sm" onClick={studio.undoDraft}>
              <Undo2 />
              元に戻す
            </Button>
          )}
        </div>
      </header>
      <div className="create-workspace flex min-h-0 flex-1 flex-col md:flex-row">
        <section
          aria-label="制作の入力"
          className="create-input flex w-full shrink-0 flex-col border-b bg-white md:w-[320px] md:border-b-0 md:border-r lg:w-[360px]"
        >
          <div className="create-input-summary hidden items-center gap-3 border-b p-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={d.prompt}>
                {d.prompt.trim() || "プロンプトを入力して画像をつくる"}
              </p>
              <p className="text-xs text-muted-foreground">
                テンプレート {d.layers.length}件 · 参照画像 {d.references.length}件
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={inputOpen}
              aria-controls="create-input-fields"
              onClick={() => setInputOpen((open) => !open)}
            >
              <SlidersHorizontal />
              {inputOpen ? "入力を閉じる" : "入力を編集"}
            </Button>
          </div>
          <div
            id="create-input-fields"
            className={cn(
              "create-input-fields flex-1 space-y-6 overflow-y-auto p-5 lg:p-7",
              !inputOpen && "create-input-collapsed",
            )}
          >
            <div className="create-prompt">
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="prompt" className="font-medium">
                  プロンプト
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1 text-xs text-muted-foreground"
                  onClick={() => setExampleOpen(true)}
                >
                  <Sparkles className="size-3" />
                  例を使う
                </Button>
              </div>
              <Textarea
                id="prompt"
                placeholder={
                  "どんな画像をつくりますか？\n被写体、雰囲気、光や構図などを入力…"
                }
                value={d.prompt}
                maxLength={4000}
                onChange={(e) => studio.updateDraft({ prompt: e.target.value })}
                className="min-h-40 resize-y text-[16px] md:text-base"
              />
              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {studio.draftSaved ? (
                    <>
                      <Check className="mr-1 inline size-3" />
                      下書きを保存済み
                    </>
                  ) : (
                    "このブラウザでは下書きを保存できません"
                  )}
                </span>
                <span>{d.prompt.length.toLocaleString()} / 4,000</span>
              </div>
            </div>
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-medium">
                  テンプレート{" "}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {d.layers.length}/12
                  </span>
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1 text-xs"
                  onClick={() => setTemplateOpen(true)}
                >
                  <Plus className="size-3" />
                  追加
                </Button>
              </div>
              {d.layers.length ? (
                <div className="flex flex-wrap gap-2">
                  {d.layers.map((layer, index) => (
                    <Popover key={layer.id}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="max-w-full">
                          <span className="truncate">{layer.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {layer.version ? `v${layer.version}` : ""}
                          </span>
                          <ChevronRight className="size-3 rotate-90" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="max-w-[calc(100vw-2rem)]">
                        <p className="text-xs text-muted-foreground">
                          {categoryLabel(layer.category)} · 適用順 {index + 1}
                        </p>
                        <p className="mt-2 whitespace-pre-wrap text-sm">
                          {layer.body}
                        </p>
                        <div className="mt-4 flex items-center justify-between gap-2">
                          <div className="flex gap-1">
                            <Button
                              variant="outline"
                              size="icon-sm"
                              disabled={!index}
                              aria-label={`${layer.name}を上へ`}
                              onClick={() => moveLayer(index, -1)}
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon-sm"
                              disabled={index === d.layers.length - 1}
                              aria-label={`${layer.name}を下へ`}
                              onClick={() => moveLayer(index, 1)}
                            >
                              <ArrowDown />
                            </Button>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              studio.updateDraft({
                                layers: d.layers.filter((_, i) => i !== index),
                              })
                            }
                          >
                            <X />
                            外す
                          </Button>
                        </div>
                      </PopoverContent>
                    </Popover>
                  ))}
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="h-10 w-full justify-start border-dashed text-muted-foreground"
                  onClick={() => setTemplateOpen(true)}
                >
                  <Plus />
                  テンプレートを選ぶ
                </Button>
              )}

              <Button
                variant="link"
                size="sm"
                className="mt-1 h-7 px-0 text-xs text-muted-foreground"
                disabled={!d.prompt.trim()}
                onClick={() => onSaveTemplate(d.prompt)}
              >
                <FilePlus className="size-3" />
                このプロンプトをテンプレートに保存
              </Button>
            </div>
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-medium">
                  参照画像{" "}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {d.references.length}/4
                  </span>
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1 text-xs"
                  onClick={() => setReferenceOpen(true)}
                >
                  選び直す
                  <ChevronRight className="size-3" />
                </Button>
              </div>
              {!!d.references.length && (
                <div className="mb-3 space-y-2">
                  {d.references.map((ref) => {
                    const id = ref.jobId || ref.uploadId,
                      s = sources.find((item) => item.id === id);
                    return (
                      <div
                        key={id}
                        className="flex items-center gap-2 rounded-lg border p-2"
                      >
                        {s?.image && (
                          <button
                            type="button"
                            onClick={() => studio.openPreview(s)}
                            aria-label={`${imageTitle(s)}を拡大`}
                          >
                            <img
                              src={s.image.url}
                              alt=""
                              className="size-12 rounded object-cover"
                            />
                          </button>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="mb-1 truncate text-xs">
                            {s ? imageTitle(s) : "参照画像"}
                          </p>
                          <Select
                            value={ref.role}
                            onValueChange={(role) =>
                              studio.updateDraft({
                                references: d.references.map((r) =>
                                  (r.jobId || r.uploadId) === id
                                    ? { ...r, role }
                                    : r,
                                ),
                              })
                            }
                          >
                            <SelectTrigger
                              className="h-7 w-full text-xs"
                              aria-label="参照画像の役割"
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
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${s ? imageTitle(s) : "参照画像"}を外す`}
                          onClick={() =>
                            studio.updateDraft({
                              references: d.references.filter(
                                (r) => (r.jobId || r.uploadId) !== id,
                              ),
                            })
                          }
                        >
                          <X />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              <Button
                variant="outline"
                className="h-12 w-full border-dashed text-muted-foreground"
                onClick={() => setReferenceOpen(true)}
              >
                <ImagePlus />
                生成画像・ファイルから選ぶ
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                人物・構図・色味など、画像ごとに役割を指定できます。
              </p>
            </div>
            <Accordion type="single" collapsible>
              <AccordionItem value="settings">
                <AccordionTrigger className="py-3">
                  <span className="flex items-center gap-2">
                    <SlidersHorizontal className="size-4" />
                    生成設定
                  </span>
                  <span className="ml-auto mr-2 text-xs font-normal text-muted-foreground">
                    {canvasSizeLabel(d.size)} · {styleLabels[d.style]}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-4 pt-2">
                    <div>
                      <label className="mb-2 block text-xs font-medium">
                        アスペクト比
                      </label>
                      <Select
                        value={d.size}
                        onValueChange={(size) => studio.updateDraft({ size })}
                      >
                        <SelectTrigger aria-label="アスペクト比">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[
                            "auto",
                            "square",
                            "landscape",
                            "portrait",
                            "widescreen",
                            "vertical",
                          ].map((size) => (
                            <SelectItem key={size} value={size}>
                              {canvasSizeLabel(size, { full: true })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="mb-2 block text-xs font-medium">
                        画風
                      </label>
                      <Select
                        value={d.style}
                        onValueChange={(style) => studio.updateDraft({ style })}
                      >
                        <SelectTrigger aria-label="画風">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(styleLabels).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center justify-between">
                      <label htmlFor="transparent">背景を透過</label>
                      <Switch
                        id="transparent"
                        checked={d.transparent}
                        onCheckedChange={(transparent) =>
                          studio.updateDraft({ transparent })
                        }
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      アスペクト比は構図の指示です。実際の解像度は生成結果によって変わります。
                    </p>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            {d.lineageContext && (
              <div className="rounded-lg border bg-muted/50 p-3">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <GitBranch className="size-4" />
                    {d.lineageContext.operation === "derive"
                      ? "この画像を起点に編集"
                      : "元の入力から別案"}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="制作の起点を解除"
                    onClick={() => studio.updateDraft({ lineageContext: null })}
                  >
                    <X />
                  </Button>
                </div>
                <p className="mt-2 truncate text-xs text-muted-foreground">
                  {imageTitle(
                    sources.find(
                      (s) => s.id === d.lineageContext?.sourceJobId,
                    ) || { id: "", status: "", createdAt: "" },
                  )}
                </p>
                <div className="mt-3 flex items-center justify-between">
                  <label htmlFor="new-branch" className="text-xs">
                    新しい枝に保存
                  </label>
                  <Switch
                    id="new-branch"
                    disabled={d.lineageContext.operation === "edit"}
                    checked={d.lineageContext.newBranch}
                    onCheckedChange={(newBranch) =>
                      studio.updateDraft({
                        lineageContext: { ...d.lineageContext!, newBranch },
                      })
                    }
                  />
                </div>
              </div>
            )}
          </div>
          <div className="create-submit fixed bottom-0 left-0 right-0 z-10 space-y-3 border-t bg-white p-5 md:sticky md:left-auto md:right-auto lg:p-6">
            <div className="flex items-center justify-between">
              <label className="font-medium" htmlFor="generation-count">
                生成枚数
              </label>
              <Select
                value={String(d.count)}
                onValueChange={(count) =>
                  studio.updateDraft({ count: Number(count) })
                }
              >
                <SelectTrigger
                  id="generation-count"
                  className="w-24"
                  aria-label="生成枚数"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 10 }, (_, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>
                      {i + 1}枚
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="h-11 w-full"
              disabled={!canGenerate}
              onClick={() => void studio.generate()}
            >
              {studio.submitting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Sparkles />
              )}
              {studio.submitting ? "開始中…" : `${d.count}枚の画像を生成`}
            </Button>
            {!studio.health?.ready && (
              <p className="text-xs text-destructive">
                {studio.health?.message || "ChatGPT接続を確認中…"}
                <button
                  className="ml-2 underline"
                  onClick={() => void studio.refreshHealth()}
                >
                  再確認
                </button>
              </p>
            )}
            {fullPrompt.length > 12000 && (
              <p role="alert" className="text-xs text-destructive">
                合成プロンプトが12,000文字を超えています。
              </p>
            )}
            <Button
              variant="link"
              size="sm"
              className="h-5 w-full text-xs text-muted-foreground"
              onClick={() => setPromptOpen(true)}
            >
              生成に使うプロンプトを確認
            </Button>
          </div>
        </section>
        <section
          aria-label="生成結果"
          className="create-result studio-result flex min-h-[540px] min-w-0 flex-1 flex-col bg-[#fafafa] md:min-h-0"
        >
          <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b bg-white px-5 py-3 lg:px-7">
            <div className="min-w-0 flex-1 basis-40">
              <h2 className="font-medium">
                {source ? previewOrigin(source, studio.selectedId, studio.recentGenerationIds || []) : "生成結果"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {source
                  ? `${dateLabel(source.createdAt)}${source.batch ? ` · ${source.batch.count}枚の生成` : ""}`
                  : "生成した画像がここに表示されます"}
              </p>
            </div>
            {source?.batch && activeSiblings.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={cancelling}
                onClick={() =>
                  void studio.run(async () => {
                    setCancelling(true);
                    try {
                      for (const item of [...activeSiblings].sort(
                        (a, b) =>
                          Number(b.status === "queued") -
                          Number(a.status === "queued"),
                      ))
                        await studio.cancel(item);
                    } finally {
                      setCancelling(false);
                    }
                  })
                }
              >
                この{activeSiblings.length}枚を停止
              </Button>
            )}
            {source && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => studio.navigate("history", source.id)}
              >
                履歴を開く
                <ChevronRight />
              </Button>
            )}
          </header>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-start p-5 lg:p-7">
            {studio.submitting && (
              <p role="status" className="mb-4 w-full max-w-4xl rounded-lg border bg-white p-3 text-sm">
                新しい生成を開始しています。{source && "下の表示は開始前の履歴です。"}
              </p>
            )}
            {!studio.submitting && !showingRecentGeneration && recentGeneration.length > 0 && (
              <div role="status" className="mb-4 flex w-full max-w-4xl flex-wrap items-center justify-between gap-2 rounded-lg border bg-white p-3 text-sm">
                <p>
                  今回の生成：完成 {recentGeneration.filter((job) => job.status === "succeeded").length}/{recentGeneration.length}枚
                  {recentGeneration.some((job) => ["queued", "running"].includes(job.status)) ? " · 進行中" : " · 終了"}
                  {["failed", "cancelled"].map((status) => {
                    const count = recentGeneration.filter((job) => job.status === status).length;
                    return count ? ` · ${statusLabels[status]} ${count}枚` : "";
                  })}
                  <span className="mt-1 block text-xs text-muted-foreground">下には過去の履歴を表示しています。</span>
                </p>
                <Button variant="outline" size="sm" onClick={() => studio.select(recentGeneration[0].id)}>
                  今回の生成を見る
                </Button>
              </div>
            )}
            {source ? (
              <>
                <div className="mb-4 w-full max-w-4xl min-w-0 space-y-2">
                  <h3 className="break-words text-base font-medium">{imageTitle(source)}</h3>
                  <p className="text-xs text-muted-foreground">
                    {draftMatchesSource(d, source)
                      ? "現在の下書きと生成時の入力は同じです。"
                      : "現在の下書きと生成時の入力は異なります。"}
                    {source.image ? " 表示中の画像は、この履歴に保存された結果です。" : " この履歴の状態を表示しています。"}
                  </p>
                  <details key={source.id} className="rounded-lg border bg-white text-sm">
                    <summary className="cursor-pointer rounded-lg px-3 py-2 focus-visible:outline-2 focus-visible:outline-ring">この履歴の元の入力を確認</summary>
                    <div className="max-h-60 space-y-3 overflow-y-auto border-t p-3">
                      <p className="text-xs text-muted-foreground">生成時の合成プロンプト</p>
                      <p className="whitespace-pre-wrap break-words">{source.prompt || composePrompt(source.basePrompt || "", source.layers) || "入力の記録がありません。"}</p>
                      <p className="text-xs text-muted-foreground">
                        {canvasSizeLabel(source.size, { full: true })} · {styleLabels[source.style || "auto"]} · {source.transparent ? "透過あり" : "透過なし"}
                      </p>
                      {Boolean(source.references?.length) && (
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">参照画像</p>
                          {source.references!.map((reference) => {
                            const id = reference.jobId || reference.uploadId;
                            const referenceSource = sources.find((item) => item.id === id);
                            return <p key={id} className="break-words">{referenceSource ? imageTitle(referenceSource) : "参照画像の記録がありません"} · {referenceRoles.find(([role]) => role === reference.role)?.[1] || reference.role}</p>;
                          })}
                        </div>
                      )}
                    </div>
                  </details>
                </div>
                <ImageContextMenu source={source}>
                  <div
                    tabIndex={0}
                    aria-label={source.image ? "生成結果の画像" : "生成の状態"}
                    className={cn(
                      "relative flex min-h-0 w-full max-w-4xl rounded-lg border bg-white shadow-sm",
                      source.image
                        ? "aspect-[3/2] min-h-40 items-center justify-center overflow-hidden"
                        : "shrink-0 p-5 sm:p-6",
                    )}
                  >
                    {source.image ? (
                      <>
                        <img
                          src={source.image.url}
                          alt={imageTitle(source)}
                          className={`size-full object-contain ${source.transparent ? "checkerboard" : ""}`}
                        />
                        <Button
                          variant="secondary"
                          size="icon"
                          aria-label="生成画像を拡大"
                          className="absolute right-3 top-3"
                          onClick={() => studio.openPreview(source)}
                        >
                          <Maximize2 />
                        </Button>
                      </>
                    ) : ["queued", "running"].includes(source.status) ? (
                      <div role="status" className="w-full py-7 text-center">
                        <Loader2 className="mx-auto mb-4 size-8 animate-spin text-muted-foreground" />
                        <p className="text-lg font-medium">
                          {statusLabels[source.status]}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          生成中もプロンプトを編集したり、ほかの画面を確認できます。
                        </p>
                        <Button
                          variant="outline"
                          className="mt-5"
                          onClick={() =>
                            void studio.run(() => studio.cancel(source))
                          }
                        >
                          生成を停止
                        </Button>
                      </div>
                    ) : (
                      <GenerationRecovery key={source.id} source={source} />
                    )}
                  </div>
                </ImageContextMenu>
                <div className="result-meta mt-4 flex w-full max-w-4xl flex-wrap items-center justify-between gap-3">
                  <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {canvasSizeLabel(source.size, { full: true })} ·{" "}
                    {styleLabels[source.style || "auto"]} ·{" "}
                    {source.transparent ? "透過あり" : "透過なし"}
                  </p>
                  {source.image && (
                    <div className="flex items-center gap-2">
                      <ImageActions source={source} compact />
                    </div>
                  )}
                </div>
                {source.batch && (
                  <p
                    role="status"
                    className="mt-3 flex flex-wrap gap-x-3 text-xs text-muted-foreground"
                  >
                    <span>
                      完成{" "}
                      {siblings.filter((j) => j.status === "succeeded").length}/
                      {source.batch.count}枚
                    </span>
                    {["running", "queued", "failed", "cancelled"].map(
                      (status) => {
                        const count = siblings.filter(
                          (j) => j.status === status,
                        ).length;
                        return count ? (
                          <span key={status}>
                            {statusLabels[status]} {count}枚
                          </span>
                        ) : null;
                      },
                    )}
                    {batchInfo.deleted > 0 && (
                      <span>削除 {batchInfo.deleted}枚</span>
                    )}
                    {batchInfo.missing > 0 && (
                      <span>未受付 {batchInfo.missing}枚</span>
                    )}
                  </p>
                )}
                <div
                  className="mt-6 grid w-full max-w-4xl grid-cols-4 gap-3 pb-1"
                  aria-label="同時に生成した画像"
                >
                  {siblings.map((item, index) => (
                    <ImageContextMenu key={item.id} source={item}>
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => studio.select(item.id)}
                        aria-pressed={source.id === item.id}
                        aria-label={`${item.batch?.index || index + 1}枚目の生成結果 ${statusLabels[item.status]}`}
                        className={`relative aspect-[3/2] w-full overflow-hidden rounded-lg border-2 bg-white ${source.id === item.id ? "border-primary" : "border-transparent"}`}
                      >
                        {item.image ? (
                          <img
                            src={item.image.url}
                            alt=""
                            className="size-full object-cover"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {statusLabels[item.status]}
                          </span>
                        )}
                        <span className="absolute bottom-1 left-1 rounded bg-white/90 px-1.5 text-[10px]">
                          {item.batch?.index || index + 1}
                        </span>
                      </button>
                    </ImageContextMenu>
                  ))}
                </div>
              </>
            ) : (
              <div className="max-w-md text-center">
                <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-2xl border bg-white">
                  <ImagePlus className="size-7 text-muted-foreground" />
                </div>
                <h2 className="text-lg font-semibold">
                  最初の一枚をつくりましょう
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  プロンプトを入力して、生成ボタンを押してください。
                  <br />
                  テンプレートや参照画像でイメージを具体化できます。
                </p>
                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={() => setExampleOpen(true)}
                >
                  <Sparkles />
                  プロンプトの例を見る
                </Button>
              </div>
            )}
          </div>
        </section>
        <TemplatePicker
          open={templateOpen}
          onOpenChange={setTemplateOpen}
          onManage={() => {
            setTemplateOpen(false);
            studio.navigate("templates");
          }}
        />
        <ReferencePicker
          open={referenceOpen}
          onOpenChange={setReferenceOpen}
          onBusy={setUploading}
        />
        <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>生成に使うプロンプト</DialogTitle>
              <DialogDescription>
                入力とテンプレートを、この順番で合成します。
                {fullPrompt.length.toLocaleString()} / 12,000文字
              </DialogDescription>
            </DialogHeader>
            <pre className="max-h-[60dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm">
              {fullPrompt ||
                "プロンプトを入力するか、テンプレートを選択してください。"}
            </pre>
          </DialogContent>
        </Dialog>
        <Dialog open={exampleOpen} onOpenChange={setExampleOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>プロンプトの例</DialogTitle>
              <DialogDescription>
                選んだ文章でプロンプトを置き換えます。「元に戻す」で変更前の入力全体に戻せます。
              </DialogDescription>
            </DialogHeader>
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                className="rounded-lg border p-4 text-left text-sm hover:bg-muted"
                onClick={() => {
                  studio.applyExample(example);
                  setExampleOpen(false);
                }}
              >
                {example}
              </button>
            ))}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
