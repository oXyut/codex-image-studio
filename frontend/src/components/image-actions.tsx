import { type ReactElement } from "react";
import {
  Download,
  Expand,
  GitBranch,
  ImagePlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Square,
  Star,
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
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useStudio } from "@/lib/studio-context";
import { imageTitle, isComplete } from "@/lib/format";
import type { ImageSource } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ImageFavoriteButton({
  source,
  className,
}: {
  source: ImageSource;
  className?: string;
}) {
  const studio = useStudio();
  if (source.kind === "upload" || !isComplete(source)) return null;
  const favorite = source.favorite === true;
  const label = `${imageTitle(source)}をお気に入り${favorite ? "から外す" : "に追加"}`;
  return (
    <Button
      variant="outline"
      size="icon"
      className={cn("bg-background", className)}
      aria-label={label}
      title={label}
      aria-pressed={favorite}
      disabled={studio.favoritePendingIds.includes(source.id)}
      onClick={() => {
        void studio.run(() => studio.setFavorite(source, !favorite));
      }}
    >
      <Star
        className={cn("size-4", favorite && "fill-amber-400 text-amber-600")}
      />
    </Button>
  );
}

type ImageMenuOptions = {
  source: ImageSource;
  includeEditor?: boolean;
  includeDerive?: boolean;
  includeRestore?: boolean;
};

function ImageMenuItems({
  source,
  includeEditor = false,
  includeDerive = includeEditor,
  includeRestore = includeEditor,
  contextMenu = false,
}: ImageMenuOptions & { contextMenu?: boolean }) {
  const studio = useStudio();
  const complete = isComplete(source);
  const active = source.status === "running" || source.status === "queued";
  const canRetry =
    source.kind !== "upload" &&
    !active &&
    Boolean(studio.health?.ready) &&
    !studio.submitting;
  const Item = contextMenu ? ContextMenuItem : DropdownMenuItem;
  const Label = contextMenu ? ContextMenuLabel : DropdownMenuLabel;
  const Separator = contextMenu ? ContextMenuSeparator : DropdownMenuSeparator;
  return (
    <>
      {contextMenu && (
        <>
          <Label className="max-w-72 truncate">{imageTitle(source)}</Label>
          {complete && (
            <>
              <Item onSelect={() => studio.openPreview(source)}>
                <Expand />
                拡大プレビュー
              </Item>
              <Item onSelect={() => studio.addReference(source)}>
                <ImagePlus />
                参照に追加
              </Item>
              {source.kind !== "upload" && (
                <Item
                  disabled={studio.favoritePendingIds.includes(source.id)}
                  onSelect={() =>
                    void studio.run(() =>
                      studio.setFavorite(source, !source.favorite),
                    )
                  }
                >
                  <Star
                    className={cn(
                      source.favorite && "fill-amber-400 text-amber-600",
                    )}
                  />
                  {source.favorite ? "お気に入りから外す" : "お気に入りに追加"}
                </Item>
              )}
              <Item asChild>
                <a href={source.image!.downloadUrl} download>
                  <Download />
                  画像をダウンロード
                </a>
              </Item>
            </>
          )}
          <Item onSelect={() => studio.navigate("lineage", source.id, "")}>
            <GitBranch />
            系統図で見る
          </Item>
          <Separator />
        </>
      )}
      {includeDerive && (
        <>
          <Item
            disabled={!complete}
            onSelect={() => studio.replaceFromSource(source, true)}
          >
            <GitBranch className="size-4" />
            この画像を参照して編集
          </Item>
          <Label
            hidden={contextMenu}
            className="font-normal leading-relaxed text-muted-foreground"
          >
            {source.kind === "upload"
              ? "制作中の入力を保持し、参照をこの画像に置き換えます。"
              : "元の入力・設定とこの画像を制作へ読み込みます。"}
            制作画面で元に戻せます。
          </Label>
          <Separator />
        </>
      )}
      {includeRestore && source.kind !== "upload" && (
        <>
          <Item onSelect={() => studio.replaceFromSource(source)}>
            <Pencil className="size-4" />
            元の入力に置き換えて編集
          </Item>
          <Label
            hidden={contextMenu}
            className="font-normal leading-relaxed text-muted-foreground"
          >
            元の文章・テンプレート・参照画像・設定を復元します。制作画面で元に戻せます。
          </Label>
          <Separator />
        </>
      )}
      {source.kind !== "upload" && (
        <>
          <Label className="font-normal leading-relaxed text-muted-foreground">
            元の文章・テンプレート・参照画像・設定を使用します。枚数は現在の制作設定です。
          </Label>
          <Item
            disabled={!canRetry}
            onSelect={() => {
              void studio.run(() => studio.retry(source));
            }}
          >
            <RefreshCw className="size-4" />
            元の設定で{studio.draft.count}枚を今すぐ生成
          </Item>
          <Separator />
        </>
      )}
      {active && (
        <Item
          onSelect={() => {
            void studio.run(() => studio.cancel(source));
          }}
        >
          <Square className="size-4" />
          生成を停止
        </Item>
      )}
      <Item variant="destructive" onSelect={() => studio.requestDelete(source)}>
        <Trash2 className="size-4" />
        画像と下流をゴミ箱へ
      </Item>
    </>
  );
}

export function ImageActionMenu(options: ImageMenuOptions) {
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
        <ImageMenuItems {...options} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ImageContextMenu({
  source,
  children,
}: {
  source: ImageSource;
  children: ReactElement;
}) {
  return (
    <ContextMenu
      label={`${imageTitle(source)}の操作`}
      className="w-80"
      content={<ImageMenuItems source={source} includeEditor contextMenu />}
    >
      {children}
    </ContextMenu>
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
        <ImageFavoriteButton source={source} />
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
