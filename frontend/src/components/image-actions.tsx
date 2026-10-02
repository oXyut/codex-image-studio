import {
  Download,
  GitBranch,
  ImagePlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStudio } from "@/lib/studio-context";
import { isComplete } from "@/lib/format";
import type { ImageSource } from "@/lib/types";

export function ImageActionMenu({
  source,
  includeEditor = false,
  includeDerive = includeEditor,
  includeRestore = includeEditor,
}: {
  source: ImageSource;
  includeEditor?: boolean;
  includeDerive?: boolean;
  includeRestore?: boolean;
}) {
  const studio = useStudio();
  const complete = isComplete(source);
  const active = source.status === "running" || source.status === "queued";
  const canRetry =
    source.kind !== "upload" &&
    !active &&
    Boolean(studio.health?.ready) &&
    !studio.submitting;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="画像のその他の操作">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        {includeDerive && (
          <>
            <DropdownMenuItem
              disabled={!complete}
              onSelect={() => studio.replaceFromSource(source, true)}
            >
              <GitBranch className="size-4" />
              この画像を参照して編集
            </DropdownMenuItem>
            <DropdownMenuLabel className="font-normal leading-relaxed text-muted-foreground">
              {source.kind === "upload"
                ? "制作中の入力を保持し、参照をこの画像に置き換えます。"
                : "元の入力・設定とこの画像を制作へ読み込みます。"}
              制作画面で元に戻せます。
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        {includeRestore && source.kind !== "upload" && (
          <>
            <DropdownMenuItem onSelect={() => studio.replaceFromSource(source)}>
              <Pencil className="size-4" />
              元の入力に置き換えて編集
            </DropdownMenuItem>
            <DropdownMenuLabel className="font-normal leading-relaxed text-muted-foreground">
              元の文章・テンプレート・参照画像・設定を復元します。制作画面で元に戻せます。
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        {source.kind !== "upload" && (
          <>
            <DropdownMenuLabel className="font-normal leading-relaxed text-muted-foreground">
              元の文章・テンプレート・参照画像・設定を使用します。枚数は現在の制作設定です。
            </DropdownMenuLabel>
            <DropdownMenuItem
              disabled={!canRetry}
              onSelect={() => {
                void studio.run(() => studio.retry(source));
              }}
            >
              <RefreshCw className="size-4" />
              元の設定で{studio.draft.count}枚を今すぐ生成
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {active && (
          <DropdownMenuItem
            onSelect={() => {
              void studio.run(() => studio.cancel(source));
            }}
          >
            <Square className="size-4" />
            生成を停止
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => studio.requestDelete(source)}
        >
          <Trash2 className="size-4" />
          画像と下流をゴミ箱へ
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ImageDownload({ source }: { source: ImageSource }) {
  if (!source.image) return null;
  return (
    <Button variant="outline" size="icon" asChild>
      <a
        href={source.image.downloadUrl}
        download
        aria-label="画像をダウンロード"
      >
        <Download className="size-4" />
      </a>
    </Button>
  );
}

export function ImageActions({
  source,
  compact = false,
}: {
  source: ImageSource;
  compact?: boolean;
}) {
  const studio = useStudio();
  const complete = isComplete(source);
  return (
    <div className="space-y-2" aria-label="画像の操作">
      <div className="flex flex-wrap items-center gap-2">
        {complete && (
          <Button
            variant={compact ? "outline" : "default"}
            onClick={() => studio.addReference(source)}
          >
            <ImagePlus className="size-4" />
            参照に追加
          </Button>
        )}
        {!compact && complete && (
          <Button
            variant="outline"
            onClick={() => studio.replaceFromSource(source, true)}
          >
            <GitBranch className="size-4" />
            この画像を参照して編集
          </Button>
        )}
        {!compact && source.kind !== "upload" && (
          <Button
            variant="outline"
            onClick={() => studio.replaceFromSource(source)}
          >
            <Pencil className="size-4" />
            元の入力に置き換えて編集
          </Button>
        )}
        <ImageDownload source={source} />
        <ImageActionMenu source={source} includeEditor={compact} />
      </div>
      {!compact && complete && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          {source.kind === "upload"
            ? "「この画像を参照して編集」は、制作中の入力を保持し、参照をこの画像に置き換えます。"
            : "「この画像を参照して編集」は、元の入力・設定とこの画像を制作へ読み込みます。"}
          制作画面で元に戻せます。
        </p>
      )}
    </div>
  );
}
