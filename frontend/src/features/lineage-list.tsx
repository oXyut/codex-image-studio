import { ImageContextMenu } from "@/components/image-actions";
import { statusLabels } from "@/lib/format";
import { lineageFamilies, lineageRelationLabels } from "@/lib/lineage-navigation";
import type { ImageSource } from "@/lib/types";
import { cn } from "@/lib/utils";
import { lineageTitle, type LineageGraph, type VisibleGraph } from "@shared/lineage-utils.js";
import { ImageIcon } from "lucide-react";
import type { Ref } from "react";

type Family = ReturnType<typeof lineageFamilies>[number];

export function LineageImageList({
  graph,
  visible,
  families,
  selectedId,
  onOpen,
  listRef,
}: {
  graph: LineageGraph<ImageSource>;
  visible: VisibleGraph<ImageSource>;
  families: Family[];
  selectedId: string | null;
  onOpen: (source: ImageSource) => void;
  listRef: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={listRef}
      aria-label="系統ごとの画像リスト"
      className="min-w-0 flex-1 overflow-y-auto bg-zinc-50 p-4"
    >
      {visible.nodes.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-600">
          {graph.nodes.length
            ? "条件に合う画像がありません"
            : "画像を生成すると、つながりをたどれます。"}
        </p>
      )}
      {families.map((family) => {
        const nodes = visible.nodes.filter((node) => family.nodeIds.includes(node.id));
        if (!nodes.length) return null;
        return (
          <section key={family.id} className="mb-5" aria-label={`${family.title}の画像`}>
            <h2 className="mb-2 text-sm font-semibold">
              {family.title} · {nodes.length}枚
            </h2>
            <ul className="space-y-2">
              {nodes.map((node) => (
                <li key={node.id}>
                  <ImageContextMenu source={node.job}>
                    <button
                      type="button"
                      data-lineage-id={node.id}
                      aria-label={`${lineageTitle(node)}の詳細を開く`}
                      onClick={() => onOpen(node.job)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-xl border bg-white p-3 text-left focus-visible:outline-2 focus-visible:outline-zinc-900",
                        node.id === selectedId && "border-zinc-900",
                      )}
                    >
                      {node.job.image?.url ? (
                        <img src={node.job.image.url} alt="" className="size-16 shrink-0 rounded-lg object-cover" />
                      ) : (
                        <span className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-zinc-100">
                          <ImageIcon className="size-6 text-zinc-500" />
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-semibold">{lineageTitle(node)}</span>
                        <span className={cn("mt-1 block text-xs", node.job.status === "failed" ? "text-red-700" : "text-zinc-500")}>
                          {node.kind === "upload" ? "アップロード" : statusLabels[node.job.status]}
                          {node.batchId && ` · 同時作成 ${node.job.batch?.index}/${node.job.batch?.count}`}
                        </span>
                        {lineageRelationLabels(graph, node.id).map((label) => (
                          <span key={label} className="mt-1 block break-words text-xs text-zinc-600">{label}</span>
                        ))}
                      </span>
                    </button>
                  </ImageContextMenu>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
