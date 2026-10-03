import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type { StudioContextValue } from "@/lib/types";
import { App } from "./app";

vi.mock("@/features/create", () => ({ CreateView: () => <h1>新しい画像</h1> }));
vi.mock("@/features/history", () => ({ HistoryView: () => <h1>生成履歴</h1> }));
vi.mock("@/features/templates", () => ({ TemplatesView: () => <h1>テンプレート一覧</h1> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const originalWindow = window;
function hostname(value: string) {
  vi.stubGlobal("window", new Proxy(originalWindow, {
    get(target, key) {
      return key === "location" ? { hostname: value } : Reflect.get(target, key);
    },
  }));
}
function studio(): StudioContextValue {
  return { view: "create", navigate: vi.fn(), health: { ready: false }, refreshHealth: vi.fn() } as unknown as StudioContextValue;
}

describe("共通ナビゲーション", () => {
  it("画面切替後も4つの主ナビと現在位置を保持する", async () => {
    hostname("127.0.0.1");
    const context = studio();
    const user = userEvent.setup();
    const { rerender } = render(<StudioContext.Provider value={context}><App /></StudioContext.Provider>);
    const nav = within(screen.getByRole("navigation", { name: "メインナビゲーション" }));
    expect(nav.getAllByRole("button")).toHaveLength(4);
    expect(nav.getByRole("button", { name: "制作" })).toHaveAttribute("aria-current", "page");
    await user.click(nav.getByRole("button", { name: "履歴" }));
    expect(context.navigate).toHaveBeenCalledWith("history");
    rerender(<StudioContext.Provider value={{ ...context, view: "history" }}><App /></StudioContext.Provider>);
    expect(nav.getByRole("button", { name: "履歴" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("button", { name: "制作" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("heading", { name: "生成履歴" })).toBeInTheDocument();
  });

  it.each(["localhost", "127.0.0.1"])("%sでは別画面のスマホ接続案内へ進める", (host) => {
    hostname(host);
    render(<StudioContext.Provider value={studio()}><App /></StudioContext.Provider>);
    for (const link of screen.getAllByRole("link", { name: "スマホで開く" })) {
      expect(link).toHaveAttribute("href", "/lan");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("LANのホスト名ではMac専用のスマホ接続案内を表示しない", () => {
    hostname("192.168.11.11");
    render(<StudioContext.Provider value={studio()}><App /></StudioContext.Provider>);
    expect(screen.queryByRole("link", { name: "スマホで開く" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "メインナビゲーション" })).toBeInTheDocument();
  });
});
