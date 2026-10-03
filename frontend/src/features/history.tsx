import { FailedJobsDeleteDialog } from "@/components/failed-jobs-delete-dialog";
import { ImageContextMenu, ImageFavoriteButton } from "@/components/image-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dateLabel, errorMessage, imageTitle, isComplete, statusLabels } from "@/lib/format";
import { useStudio } from "@/lib/studio-context";
import type { ImageSource } from "@/lib/types";
import { cn } from "@/lib/utils";
import { groupGenerationHistory } from "@shared/batch-groups.js";
import { canvasSizeLabel } from "@shared/canvas-options.js";
import {
  ArrowRight,
  Check,
  Clock,
  Columns2,
  Grid2X2,
  ImageIcon,
  ImagePlus,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

type HistoryFilter = "all" | "complete" | "active" | "failed" | "cancelled";
type HistoryDensity = "large" | "compact";
const historyDensityKey = "codex-image-studio.history-density";
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
  if (source.status === "failed") {
    return (
      <ImageContextMenu source={source}>
        <article
          aria-label={imageTitle(source)}
          className={cn(
            "min-w-0 rounded-xl border bg-muted/20 p-4",
            selected && "ring-2 ring-foreground ring-offset-2",
          )}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge variant="destructive">{statusLabels.failed}</Badge>
            <h3 className="min-w-0 break-words text-sm font-medium">
              {source.batch ? `${source.batch.index}. ` : ""}
              {imageTitle(source)}
            </h3>
            <time
              className="text-xs text-muted-foreground"
              dateTime={source.createdAt}
            >
              {dateLabel(source.createdAt)}
            </time>
          </div>
          <div className="mt-2 flex flex-col gap-3">
            <p
              className="min-w-0 flex-1 line-clamp-2 break-words text-sm text-muted-foreground"
              title={errorMessage(source)}
            >
              {errorMessage(source)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                className="h-auto min-h-9 whitespace-normal py-2"
                onClick={() => studio.replaceFromSource(source)}
              >
                <Pencil className="size-4" />
                内容を編集して再試行
              </Button>
              <Button
                variant="ghost"
                onClick={onSelect}
                aria-label={`${imageTitle(source)}を選択`}
                aria-haspopup="dialog"
                aria-pressed={selected}
              >
                詳細
              </Button>
            </div>
          </div>
        </article>
      </ImageContextMenu>
    );
  }
  return (
    <ImageContextMenu source={source}>
      <article className="min-w-0 space-y-2">
        <div className="group relative">
          <button
            type="button"
            onClick={onSelect}
            aria-label={`${imageTitle(source)}を選択`}
            aria-haspopup="dialog"
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
              </span>
            )}
            {selected && (
              <span className="absolute right-3 top-3 rounded-full bg-background p-1.5 shadow-sm">
                <Check className="size-4" />
              </span>
            )}
            {source.status !== "succeeded" && (
              <Badge
                variant="secondary"
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
    </ImageContextMenu>
  );
}

export function HistoryView() {
  const studio = useStudio();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [batch, setBatch] = useState("all");
  const [moreFilters, setMoreFilters] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchPanelId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const menuSelection = useRef<HTMLElement | null>(null);
  const [deleteFailedOpen, setDeleteFailedOpen] = useState(false);
  const [density, setDensity] = useState<HistoryDensity>(() => {
    try {
      return localStorage.getItem(historyDensityKey) === "compact"
        ? "compact"
        : "large";
    } catch {
      return "large";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(historyDensityKey, density);
    } catch {
      // The current selection still works when browser storage is unavailable.
    }
  }, [density]);
  const failedCount = studio.jobs.filter(
    (job) => job.status === "failed",
  ).length;
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
  const activeFilterCount = [query, filter !== "all", batch !== "all", favoriteOnly].filter(Boolean).length;
  const clearFilters = () => {
    setQuery("");
    setFilter("all");
    setBatch("all");
    setFavoriteOnly(false);
  };

  useEffect(() => {
    if (batch !== "all" && !batches.some((job) => job.batch?.id === batch))
      setBatch("all");
  }, [batches, batch]);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-2 md:px-8 md:py-5">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">生成履歴</h1>
            <span className="text-sm text-muted-foreground">
              {studio.jobs.length}枚
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="size-11 md:hidden" aria-label="履歴の操作">
                <MoreHorizontal className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* ダイアログを閉じた後に選択項目へ戻れるよう、メニューを保持する。 */}
              <DropdownMenuItem className="min-h-11" disabled={studio.loading || failedCount === 0} onSelect={(event) => {
                event.preventDefault();
                if (event.currentTarget instanceof HTMLElement) {
                  menuSelection.current = event.currentTarget;
                  event.currentTarget.focus();
                }
                setDeleteFailedOpen(true);
              }}>
                <Trash2 />エラー画像を一括削除（{failedCount}件）
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-11" onSelect={(event) => {
                event.preventDefault();
                if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
                studio.openTrash();
              }}>
                <Trash2 />ゴミ箱
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="hidden flex-wrap items-center gap-2 md:flex">
            <Button
              variant="outline"
              disabled={studio.loading || failedCount === 0}
              onClick={() => { menuSelection.current = null; setDeleteFailedOpen(true); }}
            >
              <Trash2 className="size-4" />
              エラー画像を一括削除（{failedCount}件）
            </Button>
            <Button variant="ghost" onClick={studio.openTrash}>
              <Trash2 className="size-4" />
              ゴミ箱
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3 md:px-8 md:py-5">
          <div className="mb-4 space-y-3 md:mb-7">
            <Button
              variant="outline"
              className="h-11 w-full justify-start md:hidden"
              aria-expanded={searchOpen}
              aria-controls={searchPanelId}
              onClick={() => setSearchOpen((value) => !value)}
            >
              <Search className="size-4" />
              検索・絞り込み{activeFilterCount > 0 ? `（${activeFilterCount}）` : ""}
              <span className="ml-auto text-xs text-muted-foreground">{searchOpen ? "閉じる" : "開く"}</span>
            </Button>
            <div id={searchPanelId} className={cn("space-y-3", !searchOpen && "hidden md:block")}>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-0 flex-1 basis-56">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchInput}
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
                  <Button variant="ghost" onClick={clearFilters}>
                    <X className="size-4" />
                    絞り込みを解除
                  </Button>
                )}
              </div>
            )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-sm text-muted-foreground">表示</span>
              <div
                className="flex rounded-lg border p-1"
                role="group"
                aria-label="履歴の表示密度"
              >
                <Button
                  variant={density === "large" ? "default" : "ghost"}
                  size="sm"
                  aria-pressed={density === "large"}
                  onClick={() => setDensity("large")}
                >
                  <Columns2 className="size-4" />
                  大きく表示
                </Button>
                <Button
                  variant={density === "compact" ? "default" : "ghost"}
                  size="sm"
                  aria-pressed={density === "compact"}
                  onClick={() => setDensity("compact")}
                >
                  <Grid2X2 className="size-4" />
                  コンパクト
                </Button>
              </div>
            </div>
            {hasFilters && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground" role="status">
                  {filtered.length}枚を表示 / 全{studio.jobs.length}枚
                </p>
                <Button variant="ghost" className="h-11 md:hidden" onClick={clearFilters}>
                  <X className="size-4" />条件を解除
                </Button>
              </div>
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
                  hasFilters ? clearFilters() : studio.navigate("create")
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
                    <div
                      className={cn(
                        "grid grid-cols-1 items-start sm:grid-cols-2",
                        density === "compact"
                          ? "gap-3 lg:grid-cols-3 xl:grid-cols-4"
                          : "gap-x-5 gap-y-6 2xl:grid-cols-3",
                      )}
                    >
                      {group.jobs.map((job) => (
                        <HistoryCard
                          key={job.id}
                          source={job}
                          onSelect={() => {
                            studio.openPreview(job);
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
      <FailedJobsDeleteDialog
        open={deleteFailedOpen}
        onOpenChange={setDeleteFailedOpen}
        onCloseAutoFocus={(event) => {
          if (!menuSelection.current?.isConnected) return;
          event.preventDefault();
          menuSelection.current.focus();
        }}
      />
    </div>
  );
}
