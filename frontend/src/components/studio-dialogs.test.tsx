import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
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
  jobs: [first, image("生成中", { status: "running", image: undefined }), second],
  uploads: [upload],
  health: { ready: true },
  draft: { count: 1 },
  favoritePendingIds: [],
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
    expect(screen.getByRole("img", { name: "アップロード" })).toBeInTheDocument();
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
    expect(screen.getByRole("img", { name: "アップロード" })).toBeInTheDocument();
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
