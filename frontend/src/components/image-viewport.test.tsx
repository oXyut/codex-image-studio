import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageViewport } from "./image-viewport";
import type { ImageSource } from "@/lib/types";

const source: ImageSource = {
  id: "landscape",
  status: "succeeded",
  createdAt: "2026-10-02T00:00:00Z",
  prompt: "横長の画像",
  image: {
    url: "/image.png",
    downloadUrl: "/image.png",
    width: 1500,
    height: 1000,
  },
};
let resize: () => void;
let width = 1000;
beforeEach(() => {
  width = 1000;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => width,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: 700,
      width,
      height: 700,
      toJSON() {},
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options);
        this.pointerId = options.pointerId || 1;
      }
    },
  );
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("画像の表示倍率と位置", () => {
  it("小さい画像も表示領域まで拡大し、縦横比を保って全体表示する", () => {
    render(
      <ImageViewport
        source={{
          ...source,
          image: { ...source.image!, width: 150, height: 100 },
        }}
      />,
    );
    const image = screen.getByRole("img");
    expect(image.style.width).toBe("968px");
    expect(parseFloat(image.style.height)).toBeCloseTo(645.33);
    expect(screen.getByLabelText("現在の表示倍率")).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "画像を縮小" })).toBeDisabled();
  });

  it("クリック位置を中心に拡大し、ドラッグ・スクロール・倍率指定と全体表示を使える", async () => {
    const user = userEvent.setup();
    render(<ImageViewport source={source} />);
    const viewport = screen.getByRole("button", {
      name: "画像をクリックして拡大・移動",
    });
    const image = screen.getByRole("img");
    fireEvent.click(viewport, { clientX: 600, clientY: 400 });
    expect(viewport).toHaveAttribute("aria-pressed", "true");
    expect(image.style.transform).toContain(
      "translate(-100px, -50px) scale(2)",
    );
    fireEvent.pointerDown(viewport, {
      pointerId: 1,
      button: 0,
      clientX: 600,
      clientY: 400,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1,
      clientX: 650,
      clientY: 450,
    });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 650, clientY: 450 });
    fireEvent.click(viewport, { clientX: 650, clientY: 450 });
    expect(image.style.transform).toContain("translate(-50px, 0px) scale(2)");
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(1);
    const wheel = new WheelEvent("wheel", {
      deltaY: -100,
      clientX: 500,
      clientY: 350,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(viewport, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(
      Number((screen.getByRole("slider") as HTMLInputElement).value),
    ).toBeGreaterThan(200);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "350" } });
    expect(screen.getByLabelText("現在の表示倍率")).toHaveTextContent("350%");
    await user.click(screen.getByRole("button", { name: "全体表示" }));
    expect(viewport).toHaveAttribute("aria-pressed", "false");
    expect(image.style.transform).toContain("translate(0px, 0px) scale(1)");
  });

  it("倍率と移動量を制限し、詳細パネルや画面幅の変化でも画像を見失わない", () => {
    render(<ImageViewport source={source} />);
    const viewport = screen.getByRole("button", {
      name: "画像をクリックして拡大・移動",
    });
    fireEvent.click(viewport, { clientX: 500, clientY: 350 });
    fireEvent.pointerDown(viewport, {
      pointerId: 1,
      button: 0,
      clientX: 500,
      clientY: 350,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1,
      clientX: 10000,
      clientY: 10000,
    });
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    const position = screen
      .getByRole("img")
      .style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)!;
    expect(Number(position[1])).toBeCloseTo(468);
    expect(Number(position[2])).toBeCloseTo(295.33);
    width = 400;
    // ResizeObserver measures the new canvas after opening the details panel.
    act(() => resize());
    expect(parseFloat(screen.getByRole("img").style.width)).toBe(368);
    expect(screen.getByRole("img").style.transform).toContain(
      "translate(168px, 0px)",
    );
    fireEvent.change(screen.getByRole("slider"), { target: { value: "800" } });
    expect(screen.getByRole("button", { name: "画像を拡大" })).toBeDisabled();
  });

  it("キーボードで拡大・移動・リセットでき、画像を読めない場合は操作を止める", async () => {
    const user = userEvent.setup();
    render(<ImageViewport source={source} />);
    const viewport = screen.getByRole("button", {
      name: "画像をクリックして拡大・移動",
    });
    viewport.focus();
    await user.keyboard("{Enter}{ArrowRight}{ArrowDown}");
    expect(screen.getByRole("img").style.transform).toContain(
      "translate(-60px, -60px) scale(2)",
    );
    await user.keyboard("0");
    expect(viewport).toHaveAttribute("aria-pressed", "false");
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "画像を読み込めませんでした",
    );
    expect(screen.getByRole("slider")).toBeDisabled();
  });
});
