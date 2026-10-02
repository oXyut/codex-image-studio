import type { ImageSource } from "./types";
export const statusLabels: Record<string, string> = {
  queued: "待機中",
  running: "生成中",
  succeeded: "完成",
  failed: "エラー",
  cancelled: "キャンセル",
  uploaded: "アップロード",
};
export const styleLabels: Record<string, string> = {
  auto: "おまかせ",
  photo: "フォトリアル",
  illustration: "イラスト",
  "3d": "3Dレンダー",
  minimal: "ミニマル",
};
export function imageTitle(source: ImageSource) {
  return (
    source.lineage?.title ||
    source.name ||
    source.basePrompt ||
    source.prompt ||
    "テンプレートから生成"
  );
}
export function dateLabel(value: string | undefined) {
  return value
    ? new Date(value).toLocaleString("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}
export function isComplete(source: ImageSource) {
  return (
    Boolean(source.image) &&
    (source.kind === "upload" || source.status === "succeeded")
  );
}
export function errorMessage(source: ImageSource) {
  return typeof source.error === "string"
    ? source.error
    : source.error?.message || source.message || "生成に失敗しました。";
}
