import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  Archive,
  Check,
  Clock3,
  FileText,
  History,
  ImagePlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Star,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  categories,
  categoryLabel,
  searchTemplates,
} from "@legacy/prompt-utils.js";
import { compareTemplateVersions } from "@legacy/template-diff.js";
import { useStudio } from "@/lib/studio-context";
import { dateLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Template, TemplateVersion } from "@/lib/types";

const categoryColors: Record<string, string> = {
  clothing: "bg-emerald-50 text-emerald-800",
  face: "bg-pink-50 text-pink-800",
  expression: "bg-rose-50 text-rose-800",
  hair: "bg-violet-50 text-violet-800",
  pose: "bg-orange-50 text-orange-800",
  background: "bg-blue-50 text-blue-800",
  color: "bg-orange-50 text-orange-800",
  camera: "bg-green-50 text-green-800",
  lighting: "bg-amber-50 text-amber-800",
  style: "bg-indigo-50 text-indigo-800",
  negative: "bg-slate-50 text-slate-800",
};
const operationNames: Record<string, string> = {
  create: "作成",
  update: "編集",
  archive: "アーカイブ",
  unarchive: "アーカイブから復元",
  restore: "アーカイブから復元",
  revert: "過去版から復元",
};
const versionOf = (template: Template) => template.version ?? 1;
const isConflict = (error: unknown) =>
  (error as { status?: number; code?: string })?.status === 409 ||
  (error as { code?: string })?.code === "VERSION_CONFLICT";
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "操作を完了できませんでした。もう一度お試しください。";
type TemplateDiff = {
  lines: {
    type: string;
    text: string;
    beforeLine: number | null;
    afterLine: number | null;
  }[];
  metadata: {
    key: string;
    label: string;
    before: string;
    after: string;
    changed: boolean;
  }[];
  added: number;
  removed: number;
  changedFields: number;
};

function CategoryBadge({ category }: { category: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "whitespace-nowrap rounded-md font-normal",
        categoryColors[category],
      )}
    >
      {categoryLabel(category)}
    </Badge>
  );
}

function TemplateFilters({
  query,
  onQuery,
  category,
  onCategory,
  favorite,
  onFavorite,
  prefix,
}: {
  query: string;
  onQuery: (value: string) => void;
  category: string;
  onCategory: (value: string) => void;
  favorite: boolean;
  onFavorite: (value: boolean) => void;
  prefix: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-0 flex-1 basis-64">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={`${prefix}-search`}
          aria-label="テンプレートを検索"
          placeholder="名前・タグ・本文を検索"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          className="pl-9"
        />
      </div>
      <Select
        value={category || "all"}
        onValueChange={(value) => onCategory(value === "all" ? "" : value)}
      >
        <SelectTrigger className="w-52" aria-label="テンプレートの分類">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">すべての分類</SelectItem>
          {categories.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant={favorite ? "secondary" : "outline"}
        aria-pressed={favorite}
        onClick={() => onFavorite(!favorite)}
      >
        <Star
          className={cn("size-4", favorite && "fill-amber-400 text-amber-600")}
        />
        お気に入り
      </Button>
    </div>
  );
}

function useTemplateFilters(templates: Template[], archived = false) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [favorite, setFavorite] = useState(false);
  const results = useMemo(
    () =>
      searchTemplates(templates, {
        query,
        category,
        favorite,
        archived,
      }) as Template[],
    [templates, query, category, favorite, archived],
  );
  return {
    results,
    query,
    onQuery: setQuery,
    category,
    onCategory: setCategory,
    favorite,
    onFavorite: setFavorite,
  };
}

function EmptyTemplates({
  archived = false,
  filtered,
  onCreate,
}: {
  archived?: boolean;
  filtered: boolean;
  onCreate?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-5 py-16 text-center">
      <div className="rounded-xl bg-muted p-3">
        <FileText className="size-6 text-muted-foreground" />
      </div>
      <h2 className="font-medium">
        {filtered
          ? "条件に合うテンプレートがありません"
          : archived
            ? "アーカイブは空です"
            : "テンプレートを保存しましょう"}
      </h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        {filtered
          ? "検索語や分類を変更してお試しください。"
          : archived
            ? "アーカイブしたテンプレートは、ここから復元できます。"
            : "よく使うプロンプトの要素を保存して、制作で組み合わせられます。"}
      </p>
      {!archived && onCreate && (
        <Button variant="outline" onClick={onCreate}>
          <Plus className="size-4" />
          新しいテンプレート
        </Button>
      )}
    </div>
  );
}

export function TemplatesView({
  createRequest,
}: { createRequest?: { key: number; body: string } } = {}) {
  const studio = useStudio();
  const [archived, setArchived] = useState(false);
  const filters = useTemplateFilters(studio.templates, archived);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [detailTab, setDetailTab] = useState("body");
  const [editor, setEditor] = useState<{
    template?: Template;
    body?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const requestKey = useRef<number | undefined>(undefined);
  const selected =
    filters.results.find((template) => template.id === selectedId) ??
    filters.results[0];
  const activeCount = studio.templates.filter(
    (template) => !template.archivedAt,
  ).length;
  const archivedCount = studio.templates.length - activeCount;

  useEffect(() => {
    if (createRequest && requestKey.current !== createRequest.key) {
      requestKey.current = createRequest.key;
      setEditor({ body: createRequest.body });
    }
  }, [createRequest]);

  function selectTemplate(
    template: Template,
    trigger?: HTMLElement,
    tab = "body",
  ) {
    if (trigger) returnFocus.current = trigger;
    setSelectedId(template.id);
    setDetailTab(tab);
    setMobileDetail(true);
  }
  function backToList() {
    setMobileDetail(false);
    requestAnimationFrame(
      () => returnFocus.current?.isConnected && returnFocus.current.focus(),
    );
  }
  async function mutate(
    template: Template,
    action: "favorite" | "archive" | "restore",
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      await studio.api(
        `/api/templates/${template.id}${action === "restore" ? "/restore" : ""}`,
        {
          method:
            action === "favorite"
              ? "PATCH"
              : action === "archive"
                ? "DELETE"
                : "POST",
          body: JSON.stringify({
            expectedVersion: versionOf(template),
            ...(action === "favorite" ? { favorite: !template.favorite } : {}),
          }),
        },
      );
      await studio.refresh();
      if (action !== "favorite") {
        toast(
          action === "archive"
            ? "アーカイブしました。後から復元できます。"
            : "テンプレートを復元しました。",
        );
        setMobileDetail(false);
      }
    } catch (cause) {
      setError(
        isConflict(cause)
          ? "別の操作で更新されています。最新の内容を読み込んでから、もう一度操作してください。"
          : messageOf(cause),
      );
      setConflict(isConflict(cause));
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    try {
      await studio.refresh();
      setError("");
      setConflict(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  function useTemplate(template: Template) {
    if (studio.addTemplate(template)) studio.navigate("create");
  }

  return (
    <section
      className="flex min-w-0 flex-col"
      aria-labelledby="templates-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-5 md:px-8">
        <div className="flex items-baseline gap-3">
          <h1
            id="templates-title"
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight"
          >
            テンプレート
          </h1>
          <span className="text-sm text-muted-foreground">{activeCount}件</span>
        </div>
        <Button onClick={() => setEditor({})}>
          <Plus className="size-4" />
          新しいテンプレート
        </Button>
      </div>
      <div
        className={cn(
          "space-y-5 border-b px-5 pt-5 md:px-8",
          mobileDetail && "hidden lg:block",
        )}
      >
        <TemplateFilters {...filters} prefix="templates" />
        <Tabs
          value={archived ? "archived" : "active"}
          onValueChange={(value) => {
            setArchived(value === "archived");
            setMobileDetail(false);
          }}
        >
          <TabsList className="h-auto rounded-none bg-transparent p-0">
            <TabsTrigger
              value="active"
              className="rounded-none border-x-0 border-t-0 border-b-2 border-b-transparent px-3 pb-3 data-[state=active]:border-b-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              すべて{" "}
              <span className="ml-1 text-muted-foreground">
                ({activeCount})
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="archived"
              className="rounded-none border-x-0 border-t-0 border-b-2 border-b-transparent px-3 pb-3 data-[state=active]:border-b-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              アーカイブ{" "}
              <span className="ml-1 text-muted-foreground">
                ({archivedCount})
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b bg-red-50 px-5 py-3 text-sm text-red-800 md:px-8"
        >
          <p className="flex-1">{error}</p>
          {conflict && (
            <Button
              variant="outline"
              size="sm"
              onClick={reload}
              disabled={busy}
            >
              <RotateCcw className="size-4" />
              最新を読み込む
            </Button>
          )}
        </div>
      )}
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
        <div
          className={cn(
            "min-w-0 px-3 md:px-6",
            mobileDetail && selected && "hidden lg:block",
          )}
        >
          {filters.results.length ? (
            <>
              <p className="sr-only" aria-live="polite">
                {filters.results.length}件のテンプレート
              </p>
              <table
                className="w-full table-fixed text-left text-sm"
                aria-label="テンプレート一覧"
              >
                <thead className="border-b text-sm font-normal text-muted-foreground">
                  <tr>
                    <th className="w-12 py-4">
                      <span className="sr-only">お気に入り</span>
                    </th>
                    <th className="py-4 font-normal">名前</th>
                    <th className="hidden w-36 font-normal md:table-cell">
                      分類
                    </th>
                    <th className="hidden w-14 font-normal sm:table-cell">
                      版
                    </th>
                    <th className="hidden w-20 font-normal xl:table-cell">
                      更新日
                    </th>
                    <th className="w-11">
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filters.results.map((template) => (
                    <tr
                      key={template.id}
                      className={cn(
                        "border-b border-l-2 border-l-transparent transition-colors hover:bg-muted/50",
                        selected?.id === template.id &&
                          "border-l-foreground bg-muted/70",
                      )}
                    >
                      <td className="py-4">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-9"
                          disabled={busy}
                          onClick={() => mutate(template, "favorite")}
                          aria-label={`${template.name}のお気に入りを切り替え`}
                          aria-pressed={template.favorite}
                        >
                          <Star
                            className={cn(
                              "size-4",
                              template.favorite
                                ? "fill-amber-400 text-amber-600"
                                : "text-muted-foreground",
                            )}
                          />
                        </Button>
                      </td>
                      <td className="py-4 pr-3">
                        <button
                          className="w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(event) =>
                            selectTemplate(template, event.currentTarget)
                          }
                          aria-label={`${template.name}の詳細`}
                          aria-current={
                            selected?.id === template.id ? "true" : undefined
                          }
                        >
                          <span className="block truncate text-base font-medium text-foreground">
                            {template.name}
                          </span>
                          <span className="mt-1 block truncate text-sm text-muted-foreground">
                            {template.body}
                          </span>
                          <span className="mt-2 inline-flex gap-2 md:hidden">
                            <CategoryBadge category={template.category} />
                            <span className="text-xs text-muted-foreground sm:hidden">
                              v{versionOf(template)}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="hidden md:table-cell">
                        <CategoryBadge category={template.category} />
                      </td>
                      <td className="hidden text-xs text-muted-foreground sm:table-cell">
                        v{versionOf(template)}
                      </td>
                      <td className="hidden text-xs text-muted-foreground xl:table-cell">
                        {new Date(template.updatedAt).toLocaleDateString(
                          "ja-JP",
                          { month: "numeric", day: "numeric" },
                        )}
                      </td>
                      <td>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              onClick={(event) => {
                                returnFocus.current = event.currentTarget;
                              }}
                              aria-label={`${template.name}の操作`}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {!template.archivedAt && (
                              <>
                                <DropdownMenuItem
                                  onSelect={() => setEditor({ template })}
                                >
                                  <Pencil className="size-4" />
                                  編集
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => useTemplate(template)}
                                >
                                  <ImagePlus className="size-4" />
                                  制作で使う
                                </DropdownMenuItem>
                              </>
                            )}
                            <DropdownMenuItem
                              onSelect={() =>
                                selectTemplate(template, undefined, "history")
                              }
                            >
                              <History className="size-4" />
                              履歴・差分
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={busy}
                              onSelect={() =>
                                mutate(
                                  template,
                                  template.archivedAt ? "restore" : "archive",
                                )
                              }
                            >
                              {template.archivedAt ? (
                                <RotateCcw className="size-4" />
                              ) : (
                                <Archive className="size-4" />
                              )}
                              {template.archivedAt
                                ? "アーカイブから復元"
                                : "アーカイブ"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <EmptyTemplates
              archived={archived}
              filtered={Boolean(
                filters.query || filters.category || filters.favorite,
              )}
              onCreate={() => setEditor({})}
            />
          )}
        </div>
        <aside
          className={cn(
            "min-w-0 border-l px-5 py-6 md:px-7",
            !mobileDetail && "hidden lg:block",
          )}
          aria-label="選択したテンプレートの詳細"
        >
          {selected ? (
            <TemplateDetails
              key={selected.id}
              template={selected}
              tab={detailTab}
              onTab={setDetailTab}
              mobileDetail={mobileDetail}
              busy={busy}
              onBack={backToList}
              onEdit={() => setEditor({ template: selected })}
              onUse={useTemplate}
              onFavorite={() => mutate(selected, "favorite")}
              onRestore={() => mutate(selected, "restore")}
            />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              テンプレートを選ぶと、本文や履歴を確認できます。
            </p>
          )}
        </aside>
      </div>
      <TemplateEditor
        editor={editor}
        onClose={() => setEditor(null)}
        onSaved={(template) => {
          setSelectedId(template.id);
          setArchived(Boolean(template.archivedAt));
          setDetailTab("body");
        }}
      />
    </section>
  );
}

function TemplateDetails({
  template,
  tab,
  onTab,
  mobileDetail,
  busy,
  onBack,
  onEdit,
  onUse,
  onFavorite,
  onRestore,
}: {
  template: Template;
  tab: string;
  onTab: (value: string) => void;
  mobileDetail: boolean;
  busy: boolean;
  onBack: () => void;
  onEdit: () => void;
  onUse: (template: Template) => void;
  onFavorite: () => void;
  onRestore: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (mobileDetail && window.matchMedia("(max-width: 1023px)").matches)
      heading.current?.focus();
  }, [mobileDetail, template.id]);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="mb-4 -ml-2 lg:hidden"
        onClick={onBack}
      >
        <ArrowLeft className="size-4" />
        一覧に戻る
      </Button>
      <div className="flex items-start justify-between gap-3">
        <h2
          ref={heading}
          tabIndex={-1}
          className="break-words text-xl font-semibold"
        >
          {template.name}
        </h2>
        <Button
          size="icon"
          variant="ghost"
          className="shrink-0"
          disabled={busy}
          onClick={onFavorite}
          aria-label={`${template.name}のお気に入りを切り替え`}
          aria-pressed={template.favorite}
        >
          <Star
            className={cn(
              "size-5",
              template.favorite
                ? "fill-amber-400 text-amber-600"
                : "text-muted-foreground",
            )}
          />
        </Button>
      </div>
      <div className="mb-6 mt-3 flex flex-wrap gap-2">
        <Badge variant="secondary" className="bg-blue-50 text-blue-700">
          v{versionOf(template)} · 現在の版
        </Badge>
        <CategoryBadge category={template.category} />
        {template.archivedAt && <Badge variant="outline">アーカイブ</Badge>}
      </div>
      <Tabs value={tab} onValueChange={onTab}>
        <TabsList className="mb-5 h-auto w-full justify-start rounded-none border-b bg-transparent p-0">
          <TabsTrigger
            value="body"
            className="rounded-none border-x-0 border-t-0 border-b-2 border-b-transparent px-3 pb-3 data-[state=active]:border-b-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            本文
          </TabsTrigger>
          <TabsTrigger
            value="history"
            className="rounded-none border-x-0 border-t-0 border-b-2 border-b-transparent px-3 pb-3 data-[state=active]:border-b-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            履歴・差分
          </TabsTrigger>
        </TabsList>
        <TabsContent value="body" className="space-y-6">
          <div>
            <h3 className="mb-2 text-sm font-medium">プロンプトの本文</h3>
            <p className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 text-sm leading-7">
              {template.body}
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">タグ</h3>
            <div className="flex flex-wrap gap-2">
              {template.tags.length ? (
                template.tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="max-w-full break-all font-normal"
                  >
                    #{tag}
                  </Badge>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  タグはありません
                </p>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-3 border-y py-5 text-sm">
            <dt className="text-muted-foreground">分類</dt>
            <dd>{categoryLabel(template.category)}</dd>
            <dt className="text-muted-foreground">最終更新</dt>
            <dd>{dateLabel(template.updatedAt)}</dd>
            {template.archivedAt && (
              <>
                <dt className="text-muted-foreground">アーカイブ</dt>
                <dd>{dateLabel(template.archivedAt)}</dd>
              </>
            )}
          </dl>
          {template.archivedAt ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={onRestore}
              disabled={busy}
            >
              <RotateCcw className="size-4" />
              アーカイブから復元
            </Button>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" onClick={onEdit}>
                <Pencil className="size-4" />
                編集
              </Button>
              <Button variant="outline" onClick={() => onUse(template)}>
                <ImagePlus className="size-4" />
                制作で使う
              </Button>
            </div>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            {template.archivedAt
              ? "復元すると、制作で再び使えるようになります。"
              : "保存済みの要素を制作の下書きに追加します。編集すると新しい版として保存されます。"}
          </p>
        </TabsContent>
        <TabsContent value="history">
          <TemplateHistory template={template} onUse={onUse} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function TemplateHistory({
  template,
  onUse,
}: {
  template: Template;
  onUse: (template: Template) => void;
}) {
  const studio = useStudio();
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [beforeNumber, setBeforeNumber] = useState<number | null>(null);
  const [afterNumber, setAfterNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const request = useRef(0);
  const latest = versions[0];
  const before = versions.find((version) => version.version === beforeNumber);
  const after = versions.find((version) => version.version === afterNumber);
  const diff =
    before && after
      ? (compareTemplateVersions(before, after) as unknown as TemplateDiff)
      : null;
  const load = useCallback(
    async (preserve = false) => {
      const currentRequest = ++request.current;
      setLoading(true);
      setError("");
      try {
        const result = await studio.api<{ versions: TemplateVersion[] }>(
          `/api/templates/${template.id}/versions`,
        );
        if (currentRequest !== request.current) return;
        const snapshots = result.versions.map((version) => ({
          ...version,
          id: template.id,
          updatedAt: version.createdAt,
        }));
        setVersions(snapshots);
        setBeforeNumber((value) =>
          preserve && snapshots.some((version) => version.version === value)
            ? value
            : (snapshots[1]?.version ?? snapshots[0]?.version ?? null),
        );
        setAfterNumber((value) =>
          preserve && snapshots.some((version) => version.version === value)
            ? value
            : (snapshots[0]?.version ?? null),
        );
        setConflict(false);
      } catch (cause) {
        if (currentRequest === request.current) setError(messageOf(cause));
      } finally {
        if (currentRequest === request.current) setLoading(false);
      }
    },
    [studio.api, template.id],
  );
  useEffect(() => {
    void load(true);
    return () => {
      request.current++;
    };
  }, [load, template.version]);
  async function revert() {
    if (!after || saving || loading) return;
    setSaving(true);
    setError("");
    try {
      const restored = await studio.api<Template>(
        `/api/templates/${template.id}/revert`,
        {
          method: "POST",
          body: JSON.stringify({
            version: after.version,
            expectedVersion: latest?.version ?? versionOf(template),
          }),
        },
      );
      await studio.refresh();
      await load(true);
      toast(
        `v${after.version} の内容を v${versionOf(restored)} として復元しました。`,
      );
    } catch (cause) {
      setConflict(isConflict(cause));
      setError(
        isConflict(cause)
          ? "別の操作で更新されています。選んだ比較は保持しています。最新の履歴を読み込んで、もう一度確認してください。"
          : messageOf(cause),
      );
    } finally {
      setSaving(false);
    }
  }
  async function reload() {
    await load(true);
    await studio.run(() => studio.refresh());
  }
  const disabled = loading || saving;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          保存した版{" "}
          <span className="font-normal text-muted-foreground">
            {versions.length}版
          </span>
        </h3>
        <Button size="sm" variant="ghost" onClick={reload} disabled={disabled}>
          <RotateCcw className={cn("size-3.5", loading && "animate-spin")} />
          最新の履歴
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <p>{error}</p>
          {conflict && (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={reload}
            >
              最新の履歴を読み込む
            </Button>
          )}
        </div>
      )}
      {loading && !versions.length ? (
        <p
          role="status"
          className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" />
          履歴を読み込んでいます
        </p>
      ) : (
        versions.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  className="mb-2 block text-xs text-muted-foreground"
                  htmlFor="template-compare-before"
                >
                  比較元
                </label>
                <Select
                  value={beforeNumber == null ? "" : String(beforeNumber)}
                  onValueChange={(value) => setBeforeNumber(Number(value))}
                  disabled={disabled}
                >
                  <SelectTrigger
                    id="template-compare-before"
                    className="w-full"
                    aria-label="比較元の版"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((version) => (
                      <SelectItem
                        key={version.version}
                        value={String(version.version)}
                      >
                        v{version.version}
                        {version.version === latest?.version ? " · 最新" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label
                  className="mb-2 block text-xs text-muted-foreground"
                  htmlFor="template-compare-after"
                >
                  比較先
                </label>
                <Select
                  value={afterNumber == null ? "" : String(afterNumber)}
                  onValueChange={(value) => setAfterNumber(Number(value))}
                  disabled={disabled}
                >
                  <SelectTrigger
                    id="template-compare-after"
                    className="w-full"
                    aria-label="比較先の版"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((version) => (
                      <SelectItem
                        key={version.version}
                        value={String(version.version)}
                      >
                        v{version.version}
                        {version.version === latest?.version ? " · 最新" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {after && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock3 className="size-3.5" />
                {dateLabel(after.createdAt)} ·{" "}
                {operationNames[after.operation || ""] || "保存"}
                {after.archivedAt ? " · アーカイブの版" : ""}
              </p>
            )}
            {diff && (
              <>
                <p
                  className="rounded-md bg-muted/60 px-3 py-2 text-xs"
                  aria-live="polite"
                >
                  v{beforeNumber} → v{afterNumber} · 本文 ＋{diff.added}行 −
                  {diff.removed}行 · 属性 {diff.changedFields}項目の変更
                </p>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">
                      名前・分類・タグ・保存状態の比較
                    </caption>
                    <thead className="border-b bg-muted/30">
                      <tr>
                        <th className="p-2 font-medium">属性</th>
                        <th className="p-2 font-medium">v{beforeNumber}</th>
                        <th className="p-2 font-medium">v{afterNumber}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.metadata.map((field) => (
                        <tr
                          key={field.key}
                          className={cn(
                            "border-b last:border-0",
                            field.changed && "bg-amber-50",
                          )}
                        >
                          <th scope="row" className="p-2 font-medium">
                            {field.label}
                          </th>
                          <td className="max-w-28 break-words p-2">
                            {field.before}
                          </td>
                          <td className="max-w-28 break-words p-2">
                            {field.after}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <h4 className="mb-2 text-sm font-medium">本文の差分</h4>
                  <div
                    className="overflow-hidden rounded-lg border text-xs"
                    aria-label="テンプレート本文の差分"
                  >
                    {diff.lines.length ? (
                      diff.lines.map((line, index) => (
                        <div
                          key={index}
                          className={cn(
                            "grid grid-cols-[1.6rem_1.6rem_1rem_minmax(0,1fr)] gap-1 px-2 py-1.5",
                            line.type === "added" &&
                              "bg-green-50 text-green-900",
                            line.type === "removed" && "bg-red-50 text-red-900",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className="text-right text-muted-foreground"
                          >
                            {line.beforeLine}
                          </span>
                          <span
                            aria-hidden="true"
                            className="text-right text-muted-foreground"
                          >
                            {line.afterLine}
                          </span>
                          <span
                            aria-label={
                              line.type === "added"
                                ? "追加"
                                : line.type === "removed"
                                  ? "削除"
                                  : "変更なし"
                            }
                          >
                            {line.type === "added"
                              ? "+"
                              : line.type === "removed"
                                ? "−"
                                : " "}
                          </span>
                          <code className="whitespace-pre-wrap break-words font-mono">
                            {line.text || " "}
                          </code>
                        </div>
                      ))
                    ) : (
                      <p className="p-3 text-muted-foreground">
                        本文は空です。
                      </p>
                    )}
                  </div>
                </div>
              </>
            )}
            {after && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={disabled}
                  onClick={() => onUse(after)}
                >
                  <ImagePlus className="size-4" />v{after.version} を制作に追加
                </Button>
                <Button
                  variant="outline"
                  className="h-auto min-h-9 w-full whitespace-normal py-2"
                  disabled={disabled || after.version === latest?.version}
                  onClick={revert}
                >
                  <RotateCcw className="size-4" />
                  {saving
                    ? "復元しています…"
                    : `v${after.version} の内容を新しい版として復元`}
                </Button>
              </div>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              復元すると新しい版を作ります。過去の履歴と制作の下書きは保持します。選んだ版のアーカイブ状態も引き継ぎます。
            </p>
          </>
        )
      )}
      {!loading && !versions.length && !error && (
        <p className="text-sm text-muted-foreground">
          保存した版がありません。
        </p>
      )}
    </div>
  );
}

type EditorFields = {
  name: string;
  body: string;
  category: string;
  tags: string;
  favorite: boolean;
};
const templateNameFromBody = (body: string) =>
  body
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
const editorFields = (template?: Template, body = ""): EditorFields => ({
  name: template?.name ?? templateNameFromBody(body),
  body: template?.body ?? body,
  category: template?.category ?? "other",
  tags: template?.tags.join(", ") ?? "",
  favorite: template?.favorite ?? false,
});

function TemplateEditor({
  editor,
  onClose,
  onSaved,
}: {
  editor: { template?: Template; body?: string } | null;
  onClose: () => void;
  onSaved: (template: Template) => void;
}) {
  const studio = useStudio();
  const returnFocus = useRef<HTMLElement | null>(null);
  const [fields, setFields] = useState<EditorFields>(editorFields());
  const [expectedVersion, setExpectedVersion] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (editor) {
      setFields(editorFields(editor.template, editor.body));
      setExpectedVersion(
        editor.template ? versionOf(editor.template) : undefined,
      );
      setError("");
      setConflict(false);
    }
  }, [editor]);
  function update<K extends keyof EditorFields>(
    field: K,
    value: EditorFields[K],
  ) {
    setFields((current) => ({ ...current, [field]: value }));
  }
  function updateBody(body: string) {
    setFields((current) => ({
      ...current,
      body,
      name:
        !current.name.trim() ||
        current.name === templateNameFromBody(current.body)
          ? templateNameFromBody(body)
          : current.name,
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editor || saving) return;
    const tags = [
      ...new Set(
        fields.tags
          .split(/[,、\n]/)
          .map((tag) => tag.trim().replace(/^#/, ""))
          .filter(Boolean),
      ),
    ];
    if (!fields.name.trim() || !fields.body.trim()) {
      setError("名前と本文を入力してください。");
      return;
    }
    if (tags.length > 12 || tags.some((tag) => tag.length > 40)) {
      setError("タグは12個まで、各40文字以内で入力してください。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await studio.api<Template>(
        `/api/templates${editor.template ? `/${editor.template.id}` : ""}`,
        {
          method: editor.template ? "PATCH" : "POST",
          body: JSON.stringify({
            ...fields,
            tags,
            ...(editor.template ? { expectedVersion } : {}),
          }),
        },
      );
      await studio.refresh();
      onSaved(saved);
      onClose();
      toast("テンプレートを保存しました。");
    } catch (cause) {
      setConflict(isConflict(cause));
      setError(
        isConflict(cause)
          ? "別の操作で更新されています。編集中の内容は保持しています。「最新を読み込む」を押すと、入力を最新の内容に置き換えます。"
          : messageOf(cause),
      );
    } finally {
      setSaving(false);
    }
  }
  async function loadLatest() {
    if (!editor?.template || saving) return;
    setSaving(true);
    try {
      const result = await studio.api<{ versions: TemplateVersion[] }>(
        `/api/templates/${editor.template.id}/versions`,
      );
      const latest = result.versions[0];
      if (!latest) throw new Error("最新の版が見つかりませんでした。");
      setFields(editorFields(latest));
      setExpectedVersion(latest.version);
      setConflict(false);
      setError("");
      await studio.refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement as HTMLElement;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (returnFocus.current?.isConnected &&
          !returnFocus.current.closest("[hidden]") &&
          returnFocus.current.tagName !== "BODY"
            ? returnFocus.current
            : document.getElementById("templates-title")
          )?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {editor?.template ? "テンプレートを編集" : "新しいテンプレート"}
          </DialogTitle>
          <DialogDescription>
            {editor?.template
              ? `v${expectedVersion ?? versionOf(editor.template)} を編集し、新しい版として保存します。`
              : "制作で使うプロンプトの要素を保存します。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <label
              htmlFor="template-editor-name"
              className="text-sm font-medium"
            >
              名前 <span className="text-muted-foreground">必須</span>
            </label>
            <Input
              id="template-editor-name"
              value={fields.name}
              onChange={(event) => update("name", event.target.value)}
              maxLength={80}
              required
              placeholder="例：やわらかな暖色"
              disabled={saving}
              aria-describedby="template-editor-name-hint"
            />
            <p
              id="template-editor-name-hint"
              className="text-xs text-muted-foreground"
            >
              本文から80文字以内で自動入力します。名前は自由に変更できます。
            </p>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="template-editor-category"
              className="text-sm font-medium"
            >
              分類
            </label>
            <Select
              value={fields.category}
              onValueChange={(value) => update("category", value)}
              disabled={saving}
            >
              <SelectTrigger id="template-editor-category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="template-editor-body"
              className="text-sm font-medium"
            >
              プロンプトの本文{" "}
              <span className="text-muted-foreground">必須</span>
            </label>
            <Textarea
              id="template-editor-body"
              value={fields.body}
              onChange={(event) => updateBody(event.target.value)}
              maxLength={2000}
              required
              rows={7}
              placeholder="制作に追加したいプロンプトの要素を入力"
              disabled={saving}
              className="min-h-40"
            />
            <p className="text-right text-xs text-muted-foreground">
              {fields.body.length.toLocaleString()} / 2,000文字
            </p>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="template-editor-tags"
              className="text-sm font-medium"
            >
              タグ
            </label>
            <Input
              id="template-editor-tags"
              value={fields.tags}
              onChange={(event) => update("tags", event.target.value)}
              placeholder="暖色, ナチュラル"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              カンマで区切って12個まで。各40文字以内。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="template-editor-favorite"
              checked={fields.favorite}
              onCheckedChange={(checked) =>
                update("favorite", checked === true)
              }
              disabled={saving}
            />
            <label htmlFor="template-editor-favorite" className="text-sm">
              お気に入りに登録
            </label>
          </div>
          {error && (
            <div
              role="alert"
              className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              <p>{error}</p>
              {conflict && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={loadLatest}
                  disabled={saving}
                >
                  <RotateCcw className="size-4" />
                  最新を読み込む
                </Button>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              キャンセル
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? "保存しています…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TemplatePicker({
  open,
  onOpenChange,
  onManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onManage: () => void;
}) {
  const studio = useStudio();
  const returnFocus = useRef<HTMLElement | null>(null);
  const filters = useTemplateFilters(studio.templates);
  const existingById = new Map(
    studio.draft.layers.map((template) => [template.id, template]),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement as HTMLElement;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (returnFocus.current?.isConnected &&
          !returnFocus.current.closest("[hidden]") &&
          returnFocus.current.tagName !== "BODY"
            ? returnFocus.current
            : document.getElementById("templates-title")
          )?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>テンプレートを追加</DialogTitle>
          <DialogDescription>
            保存した要素を選んで、制作の下書きに追加します。
          </DialogDescription>
        </DialogHeader>
        <TemplateFilters {...filters} prefix="template-picker" />
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <p aria-live="polite">{filters.results.length}件</p>
          <p>下書きに {studio.draft.layers.length} / 12件追加済み</p>
        </div>
        <div className="divide-y rounded-lg border">
          {filters.results.length ? (
            filters.results.map((template) => {
              const existing = existingById.get(template.id);
              const identical =
                existing &&
                versionOf(existing) === versionOf(template) &&
                existing.body === template.body &&
                existing.name === template.name &&
                existing.category === template.category;
              return (
                <article
                  key={template.id}
                  className="flex items-start gap-3 p-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <h3 className="break-words text-sm font-medium">
                        {template.name}
                      </h3>
                      {template.favorite && (
                        <Star
                          className="size-3.5 fill-amber-400 text-amber-600"
                          aria-label="お気に入り"
                        />
                      )}
                      <CategoryBadge category={template.category} />
                      <span className="text-xs text-muted-foreground">
                        v{versionOf(template)}
                      </span>
                    </div>
                    <p className="line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
                      {template.body}
                    </p>
                    {existing && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        下書きには v{versionOf(existing)} を追加済み
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={identical ? "secondary" : "outline"}
                    className="shrink-0"
                    disabled={Boolean(identical)}
                    onClick={() => studio.addTemplate(template)}
                    aria-label={`${template.name}を${existing && !identical ? "最新版に更新" : "追加"}`}
                  >
                    {identical ? (
                      <Check className="size-4" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    <span className="hidden sm:inline">
                      {identical ? "追加済み" : existing ? "更新" : "追加"}
                    </span>
                  </Button>
                </article>
              );
            })
          ) : (
            <EmptyTemplates
              filtered={Boolean(
                filters.query || filters.category || filters.favorite,
              )}
            />
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onManage();
            }}
          >
            <FileText className="size-4" />
            テンプレートを管理
          </Button>
          <Button onClick={() => onOpenChange(false)}>完了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
