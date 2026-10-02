import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type { ImageSource, StudioContextValue } from "@/lib/types";
import { StudioDialogs } from "./studio-dialogs";

afterEach(cleanup);

function image(id: string, extra: Partial<ImageSource> = {}): ImageSource {
  return {
    id,
    status: "succeeded",
    createdAt: "2026-10-02T06:25:00Z",
    prompt: id,
    image: {
      url: `/images/${id}.png`,
      downloadUrl: `/images/${id}.png?download=1`,
    },
    ...extra,
  };
}

const first = image("一枚目");
const second = image("二枚目");
const upload = image("アップロード", {
  kind: "upload",
  status: "uploaded",
  name: "アップロード",
});
const studio = {
  jobs: [
    first,
    image("生成中", { status: "running", image: undefined }),
    second,
  ],
  uploads: [upload],
  health: { ready: true },
  draft: { count: 1 },
  favoritePendingIds: [],
  metadata: { commits: [], branches: [], uploads: [] },
  view: "history",
  api: vi.fn().mockResolvedValue({}),
  refresh: vi.fn(),
} as unknown as StudioContextValue;

function Preview({
  initial = second,
  onPreview = vi.fn(),
}: {
  initial?: ImageSource | null;
  onPreview?: (source: ImageSource | null) => void;
}) {
  const [preview, setPreview] = useState(initial);
  return (
    <StudioContext.Provider value={studio}>
      <StudioDialogs
        preview={preview}
        onPreview={(source) => {
          onPreview(source);
          setPreview(source);
        }}
        deleting={null}
        onDelete={vi.fn()}
        trash={false}
        onTrash={vi.fn()}
      />
    </StudioContext.Provider>
  );
}

describe("拡大画像プレビュー", () => {
  it("画像操作中の矢印は位置を動かし、全体表示に戻すと画像を切り替える", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    render(<Preview onPreview={onPreview} />);
    const image = screen.getByRole("img", { name: "二枚目" });
    Object.defineProperties(image, { naturalWidth: { value: 1500 }, naturalHeight: { value: 1000 } });
    fireEvent.load(image);
    await user.click(screen.getByRole("button", { name: "画像を拡大" }));
    const viewport = screen.getByRole("button", { name: "画像の表示位置を操作" });
    viewport.focus();
    await user.keyboard("{ArrowRight}");
    expect(onPreview).not.toHaveBeenCalled();
    expect(image.style.transform).toContain("translate(-60px, 0px)");
    await user.click(screen.getByRole("button", { name: "全体表示" }));
    viewport.focus();
    await user.keyboard("{ArrowRight}");
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(upload);
    width.mockRestore(); height.mockRestore();
  });

  it("同じモーダルで詳細を開閉し、入力欄や倍率操作の矢印では画像を切り替えない", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    render(<Preview onPreview={onPreview} />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "詳細" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getAllByRole("img", { name: "二枚目" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "タイトル・メモ" }));
    screen.getByRole("textbox", { name: "タイトル" }).focus();
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    screen.getByRole("slider").focus();
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    expect(onPreview).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "画像の詳細を閉じる" }),
    );
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("画像のない失敗履歴には同じモーダル内で診断と編集操作を表示する", () => {
    render(
      <Preview
        initial={image("失敗", {
          image: undefined,
          status: "failed",
          error: "生成を中止しました",
        })}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("生成を中止しました");
    expect(
      screen.getByRole("button", { name: "内容を編集して再試行" }),
    ).toBeInTheDocument();
  });

  it("画像の切り替え時は表示倍率をリセットし、詳細パネルは開いたままにする", async () => {
    const user = userEvent.setup();
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(1000);
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(700);
    render(<Preview />);
    const img = screen.getByRole("img", { name: "二枚目" });
    Object.defineProperties(img, {
      naturalWidth: { value: 1500 },
      naturalHeight: { value: 1000 },
    });
    fireEvent.load(img);
    await user.click(screen.getByRole("button", { name: "画像を拡大" }));
    expect(screen.getByLabelText("現在の表示倍率")).toHaveTextContent("125%");
    await user.click(screen.getByRole("button", { name: "詳細" }));
    await user.click(screen.getByRole("button", { name: "次の画像" }));
    expect(screen.getByLabelText("現在の表示倍率")).toHaveTextContent("100%");
    expect(
      screen.getByRole("complementary", { name: "画像の詳細" }),
    ).toBeInTheDocument();
    width.mockRestore();
    height.mockRestore();
  });

  it("左右キーで生成済み画像とアップロード画像を切り替え、先頭と末尾では止まる", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    render(<Preview onPreview={onPreview} />);

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("img", { name: "アップロード" })).toHaveAttribute(
      "src",
      upload.image!.url,
    );
    expect(
      screen.queryByRole("button", { name: "次の画像" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(onPreview).toHaveBeenCalledTimes(1);

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("img", { name: "二枚目" })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("img", { name: "一枚目" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "前の画像" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(onPreview).toHaveBeenCalledTimes(3);
  });

  it("クリックと矢印キーで同じ順序を使い、ダウンロードにフォーカスしていても切り替えられる", async () => {
    const user = userEvent.setup();
    render(<Preview />);

    await user.click(screen.getByRole("button", { name: "前の画像" }));
    expect(screen.getByRole("img", { name: "一枚目" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "次の画像" }));
    expect(screen.getByRole("img", { name: "二枚目" })).toBeInTheDocument();
    screen.getByRole("link", { name: "画像をダウンロード" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("img", { name: "アップロード" }),
    ).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("img", { name: "二枚目" })).toBeInTheDocument();
  });

  it("操作メニューの矢印キーで画像を切り替えず、メニューを閉じると切り替えられる", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    render(<Preview onPreview={onPreview} />);

    await user.click(
      screen.getByRole("button", { name: "画像のその他の操作" }),
    );
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}{ArrowLeft}");
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getByAltText("二枚目")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("img", { name: "アップロード" }),
    ).toBeInTheDocument();
  });

  it("修飾キー付きの矢印を無視し、Escapeで閉じた後は矢印キーに反応しない", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    render(<Preview onPreview={onPreview} />);

    await user.keyboard(
      "{Control>}{ArrowRight}{/Control}{Alt>}{ArrowLeft}{/Alt}" +
        "{Meta>}{ArrowRight}{/Meta}{Shift>}{ArrowLeft}{/Shift}",
    );
    expect(onPreview).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it("一覧に含まれない画像には前後の移動を行わない", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    render(<Preview initial={image("一覧外")} onPreview={onPreview} />);

    expect(
      screen.queryByRole("button", { name: "前の画像" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "次の画像" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "一覧外" })).toBeInTheDocument();
  });
});
