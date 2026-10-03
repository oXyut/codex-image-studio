import { imageTitle } from "./format";
import type { ImageSource } from "./types";

const shortId = (id: string) =>
  id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

export function referenceInfo(source: ImageSource) {
  const batch = source.kind !== "upload" && source.batch && source.batch.count > 1
    ? source.batch
    : null;
  const ordinal = batch
    ? `${batch.index} / ${batch.count}枚目`
    : source.kind === "upload" ? "アップロード" : "1枚生成";
  const unit = `${batch ? "同時作成" : "画像"} #${shortId(batch?.id || source.id)}`;
  const date = new Date(source.createdAt);
  const timestamp = Number.isNaN(date.getTime()) ? "日時不明" : date.toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  return {
    ordinal, unit, timestamp,
    label: `${imageTitle(source)}、${ordinal}、${unit}、${timestamp}`,
  };
}
