import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  Clock,
  ImageIcon,
  ImagePlus,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { groupGenerationHistory } from "@legacy/batch-groups.js";
import { canvasSizeLabel } from "@legacy/canvas-options.js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ImageInspector } from "@/components/image-inspector";
import { ImageFavoriteButton } from "@/components/image-actions";
import { useStudio } from "@/lib/studio-context";
import {
  dateLabel,
  errorMessage,
  imageTitle,
  isComplete,
  statusLabels,
} from "@/lib/format";
import type { ImageSource } from "@/lib/types";
import { cn } from "@/lib/utils";

type HistoryFilter = "all" | "complete" | "active" | "failed" | "cancelled";
type HistoryGroup = {
  kind: "batch" | "single";
  id: string;
  jobs: ImageSource[];
  total?: number;
  retained?: number;
  deleted?: number;
  missing?: number;
  createdAt?: string;
};
const filters: { value: HistoryFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "complete", label: "完成" },
  { value: "active", label: "生成中" },
];

function useWideScreen() {
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1280px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

function HistoryCard({
  source,
  onSelect,
}: {
  source: ImageSource;
  onSelect: () => void;
}) {
  const studio = useStudio();
  const selected = studio.selectedId === source.id;
  const active = ["running", "queued"].includes(source.status);
  return (
    <article className="min-w-0 space-y-2">
      <div className="group relative">
        <button
          type="button"
          onClick={onSelect}
          aria-label={`${imageTitle(source)}を選択`}
          aria-pressed={selected}
          className={cn(
            "relative block aspect-[3/2] w-full overflow-hidden rounded-xl border bg-muted/50 text-left transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            selected && "ring-2 ring-foreground ring-offset-2",
          )}
        >
          {source.image ? (
            <img
              src={source.image.url}
              alt={imageTitle(source)}
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <span className="flex h-full flex-col items-center justify-center gap-3 px-5 text-muted-foreground">
              {active ? (
                <LoaderCircle
                  className={cn(
                    "size-7",
                    source.status === "running" && "animate-spin",
                  )}
                />
              ) : (
                <ImageIcon className="size-7" />
              )}
              <span className="text-sm">
                {statusLabels[source.status] || source.status}
              </span>
              {source.status === "failed" && (
                <span className="line-clamp-2 text-center text-sm">
                  {errorMessage(source)}
                </span>
              )}
            </span>
          )}
          {selected && (
            <span className="absolute right-3 top-3 rounded-full bg-background p-1.5 shadow-sm">
              <Check className="size-4" />
            </span>
          )}
          {source.status !== "succeeded" && (
            <Badge
              variant={source.status === "failed" ? "destructive" : "secondary"}
              className="absolute left-3 top-3"
            >
              {statusLabels[source.status] || source.status}
            </Badge>
          )}
        </button>
        <ImageFavoriteButton
          source={source}
          className="absolute left-3 top-3 shadow-sm"
        />
        {isComplete(source) && (
          <Button
            variant="secondary"
            size="sm"
            className="absolute bottom-3 right-3 border border-foreground/10 shadow-sm xl:opacity-0 xl:group-hover:opacity-100 xl:group-focus-within:opacity-100"
            onClick={() => studio.addReference(source)}
            aria-label={`${imageTitle(source)}を参照に追加`}
          >
            <ImagePlus className="size-4" />
            参照に追加
          </Button>
        )}
      </div>
      <h3 className="truncate text-sm font-medium" title={imageTitle(source)}>
        {source.batch ? `${source.batch.index}. ` : ""}
        {imageTitle(source)}
      </h3>
      <div className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
        <time dateTime={source.createdAt}>{dateLabel(source.createdAt)}</time>
        <span>·</span>
        <span>{canvasSizeLabel(source.size, { full: true })}</span>
      </div>
    </article>
  );
}

export function HistoryView() {
  const studio = useStudio();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [batch, setBatch] = useState("all");
  const [moreFilters, setMoreFilters] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const wide = useWideScreen();
  const selected =
    studio.jobs.find((job) => job.id === studio.selectedId) ||
    studio.uploads.find((upload) => upload.id === studio.selectedId);
  const batches = useMemo(() => {
    const map = new Map<string, ImageSource>();
    studio.jobs.forEach((job) => {
      if (job.batch?.id && job.batch.count > 1 && !map.has(job.batch.id))
        map.set(job.batch.id, job);
    });
    return [...map.values()];
  }, [studio.jobs]);
  const filtered = useMemo(() => {
    const terms = query
      .normalize("NFKC")
      .toLocaleLowerCase("ja-JP")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return studio.jobs.filter((job) => {
      if (favoriteOnly && (!job.favorite || !isComplete(job))) return false;
      if (batch !== "all" && job.batch?.id !== batch) return false;
      if (filter === "complete" && !isComplete(job)) return false;
      if (filter === "active" && !["running", "queued"].includes(job.status))
        return false;
      if (filter === "failed" && job.status !== "failed") return false;
      if (filter === "cancelled" && job.status !== "cancelled") return false;
      const text = [
        imageTitle(job),
        job.prompt,
        job.basePrompt,
        job.lineage?.notes,
      ]
        .filter(Boolean)
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase("ja-JP");
      return terms.every((term) => text.includes(term));
    });
  }, [studio.jobs, query, batch, filter, favoriteOnly]);
  const groups = useMemo(
    () => groupGenerationHistory(filtered, studio.jobs) as HistoryGroup[],
    [filtered, studio.jobs],
  );
  const hasFilters = Boolean(
    query || filter !== "all" || batch !== "all" || favoriteOnly,
  );
  const clearFilters = () => {
    setQuery("");
    setFilter("all");
    setBatch("all");
    setFavoriteOnly(false);
  };

  useEffect(() => {
    if (studio.view === "history" && studio.selectedId) setMobileOpen(true);
  }, [studio.selectedId, studio.view]);
  useEffect(() => {
    if (batch !== "all" && !batches.some((job) => job.batch?.id === batch))
      setBatch("all");
  }, [batches, batch]);
  function closeInspector() {
    setMobileOpen(false);
    studio.select(null);
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-5 md:px-8">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">生成履歴</h1>
            <span className="text-sm text-muted-foreground">
              {studio.jobs.length}枚
            </span>
          </div>
          <Button variant="ghost" onClick={studio.openTrash}>
            <Trash2 className="size-4" />
            ゴミ箱
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 md:px-8">
          <div className="mb-7 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-0 flex-1 basis-56">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="履歴を検索"
                  placeholder="タイトル・プロンプト・メモを検索"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-11 pl-10"
                />
              </div>
              <div
                className="flex rounded-lg border p-1"
                role="group"
                aria-label="履歴の状態"
              >
                {filters.map((item) => (
                  <Button
                    key={item.value}
                    variant={filter === item.value ? "default" : "ghost"}
                    size="sm"
                    className="min-w-16"
                    aria-pressed={filter === item.value}
                    onClick={() => setFilter(item.value)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
              <Button
                variant={favoriteOnly ? "secondary" : "outline"}
                className="h-11"
                aria-pressed={favoriteOnly}
                onClick={() => setFavoriteOnly((value) => !value)}
              >
                <Star
                  className={cn(
                    "size-4",
                    favoriteOnly && "fill-amber-400 text-amber-600",
                  )}
                />
                お気に入りのみ
              </Button>
              <Button
                variant="outline"
                className="h-11"
                aria-expanded={moreFilters}
                onClick={() => setMoreFilters((value) => !value)}
              >
                <SlidersHorizontal className="size-4" />
                絞り込み
                {(batch !== "all" ||
                  ["failed", "cancelled"].includes(filter)) && (
                  <span className="size-1.5 rounded-full bg-foreground" />
                )}
              </Button>
            </div>
            {moreFilters && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 p-3">
                <Select value={batch} onValueChange={setBatch}>
                  <SelectTrigger
                    className="w-full sm:w-64"
                    aria-label="同時作成で絞り込む"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">すべての同時作成</SelectItem>
                    {batches.map((job) => (
                      <SelectItem key={job.batch!.id} value={job.batch!.id}>
                        {dateLabel(job.createdAt)} · {job.batch!.count}枚 · #
                        {job.batch!.id.slice(0, 6)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filter}
                  onValueChange={(value) => setFilter(value as HistoryFilter)}
                >
                  <SelectTrigger
                    className="w-full sm:w-40"
                    aria-label="状態で絞り込む"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      ...filters,
                      { value: "failed", label: "エラー" },
                      { value: "cancelled", label: "キャンセル" },
                    ].map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {hasFilters && (
                  <Button
                    variant="ghost"
                    onClick={clearFilters}
                  >
                    <X className="size-4" />
                    絞り込みを解除
                  </Button>
                )}
              </div>
            )}
            {hasFilters && (
              <p className="text-sm text-muted-foreground" role="status">
                {filtered.length}枚を表示 / 全{studio.jobs.length}枚
              </p>
            )}
          </div>
          {studio.loading ? (
            <div
              className="flex items-center justify-center gap-2 py-24 text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="size-5 animate-spin" />
              履歴を読み込んでいます…
            </div>
          ) : !filtered.length ? (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-5 py-20 text-center">
              <Clock className="size-8 text-muted-foreground" />
              <h2 className="font-medium">
                {hasFilters
                  ? "一致する履歴がありません"
                  : "生成した画像がここに並びます"}
              </h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                {hasFilters
                  ? "検索する言葉や絞り込み条件を変更してください。"
                  : "制作画面から画像を生成すると、参照への追加や元の入力の再利用ができます。"}
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  hasFilters
                    ? clearFilters()
                    : studio.navigate("create")
                }
              >
                {hasFilters ? "絞り込みを解除" : "制作画面へ"}
              </Button>
            </div>
          ) : (
            <div className="space-y-8">
              {groups.map((group) => {
                const all =
                  group.kind === "batch"
                    ? studio.jobs.filter((job) => job.batch?.id === group.id)
                    : group.jobs;
                const complete = all.filter(isComplete).length;
                return (
                  <section
                    key={`${group.kind}-${group.id}`}
                    className="space-y-4"
                    aria-label={
                      group.kind === "batch"
                        ? `同時作成 #${group.id.slice(0, 6)}`
                        : "個別の生成履歴"
                    }
                  >
                    {group.kind === "batch" && (
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <h2 className="font-semibold">
                            {dateLabel(group.createdAt)}
                          </h2>
                          <span className="text-sm text-muted-foreground">
                            同時作成 · {group.total}枚
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {complete} / {group.total} 完成
                          </span>
                          <span className="text-sm text-muted-foreground">
                            表示 {group.jobs.length}枚 / 保存 {group.retained}枚
                          </span>
                          {Boolean(group.deleted) && (
                            <Badge variant="outline">
                              削除 {group.deleted}枚
                            </Badge>
                          )}
                          {Boolean(group.missing) && (
                            <Badge variant="outline">
                              未受付 {group.missing}枚
                            </Badge>
                          )}
                        </div>
                        <Button
                          variant="link"
                          className="h-auto p-0 text-sm"
                          onClick={() =>
                            studio.navigate(
                              "lineage",
                              group.jobs[0]?.id,
                              group.id,
                            )
                          }
                        >
                          系統図で見る
                          <ArrowRight className="size-4" />
                        </Button>
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 2xl:grid-cols-3">
                      {group.jobs.map((job) => (
                        <HistoryCard
                          key={job.id}
                          source={job}
                          onSelect={() => {
                            studio.select(job.id);
                            setMobileOpen(true);
                          }}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {wide && (
        <aside
          className="hidden w-[360px] shrink-0 border-l xl:block 2xl:w-[400px]"
          aria-label="選択した画像の詳細"
        >
          {selected ? (
            <ImageInspector source={selected} onClose={closeInspector} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-muted-foreground">
              <ImageIcon className="size-8" />
              <p className="text-sm leading-relaxed">
                画像を選ぶと、生成時の入力や
                <br />
                参照元を確認できます。
              </p>
            </div>
          )}
        </aside>
      )}
      {!wide && (
        <Sheet
          open={mobileOpen && Boolean(selected) && studio.view === "history"}
          onOpenChange={(open) => {
            if (!open) closeInspector();
          }}
        >
          <SheetContent
            side="right"
            className="w-full gap-0 p-0 sm:max-w-md [&>button]:hidden"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>画像の詳細</SheetTitle>
              <SheetDescription>
                選択した画像のプレビュー、操作、生成時の設定
              </SheetDescription>
            </SheetHeader>
            {selected && (
              <ImageInspector source={selected} onClose={closeInspector} />
            )}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
