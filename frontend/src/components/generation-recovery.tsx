import { useId } from "react";
import { CircleAlert, CircleSlash, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImageActionMenu } from "@/components/image-actions";
import { useStudio } from "@/lib/studio-context";
import { errorMessage } from "@/lib/format";
import type { ImageSource } from "@/lib/types";

export function GenerationRecovery({ source }: { source: ImageSource }) {
  const studio = useStudio();
  const titleId = useId();
  const cancelled = source.status === "cancelled";
  const error =
    source.error != null && typeof source.error === "object"
      ? source.error
      : null;
  const details =
    source.errorDetails ||
    error?.details ||
    "この履歴には詳しい理由が保存されていません。生成時の入力は保持されています。";
  const Icon = cancelled ? CircleSlash : CircleAlert;

  return (
    <section
      aria-labelledby={titleId}
      className="min-w-0 w-full space-y-5 text-left"
    >
      <div className="flex items-start gap-3" role={cancelled ? "status" : "alert"}>
        <Icon
          aria-hidden="true"
          className={`mt-0.5 size-5 shrink-0 ${cancelled ? "text-muted-foreground" : "text-destructive"}`}
        />
        <div className="min-w-0 space-y-2">
          <h3 id={titleId} className="text-base font-semibold">
            {cancelled ? "生成をキャンセルしました" : "生成に失敗しました"}
          </h3>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {cancelled
              ? "生成をキャンセルしました。入力は保持されています。"
              : errorMessage(source)}
          </p>
          {!cancelled && (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
              {typeof error?.advice === "string" && error.advice
                ? error.advice
                : "入力は保持されています。内容や設定を確認して再試行してください。"}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <Button
            className="h-auto min-h-10 min-w-0 shrink whitespace-normal py-2 text-left"
            onClick={() => studio.replaceFromSource(source)}
          >
            <Pencil className="size-4" />
            {cancelled ? "元の入力に置き換えて編集" : "内容を編集して再試行"}
          </Button>
          <ImageActionMenu source={source} />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          元の入力・参照画像・設定を読み込みます。編集後に生成してください。
        </p>
      </div>
      {!cancelled && (
        <details className="min-w-0 border-t pt-2 text-sm">
          <summary className="min-h-9 cursor-pointer content-center font-medium text-muted-foreground">
            エラーの詳細
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
            {error?.code ? `${error.code}\n` : ""}
            {details}
          </pre>
        </details>
      )}
    </section>
  );
}
