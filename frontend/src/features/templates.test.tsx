import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StudioContext } from "@/lib/studio-context";
import type {
  StudioContextValue,
  Template,
  TemplateVersion,
} from "@/lib/types";
import { TemplatePicker, TemplatesView } from "./templates";

const current: Template = {
  id: "color-template",
  name: "やわらかな暖色",
  body: "現在の暖色。",
  category: "color",
  tags: ["暖色"],
  favorite: true,
  version: 2,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  archivedAt: null,
};
const old: TemplateVersion = {
  ...current,
  body: "過去の暖色。",
  version: 1,
  createdAt: "2026-10-01T00:00:00Z",
  operation: "create",
};
const latest: TemplateVersion = {
  ...current,
  version: 2,
  createdAt: "2026-10-02T00:00:00Z",
  operation: "update",
};

function context(
  overrides: Partial<StudioContextValue> = {},
): StudioContextValue {
  return {
    templates: [current],
    draft: {
      prompt: "",
      layers: [],
      references: [],
      count: 1,
      size: "auto",
      style: "auto",
      transparent: false,
      lineageContext: null,
    },
    api: vi.fn().mockResolvedValue({ versions: [latest, old] }),
    refresh: vi.fn().mockResolvedValue(undefined),
    addTemplate: vi.fn().mockReturnValue(true),
    navigate: vi.fn(),
    run: vi.fn(async (action) => {
      await action();
    }),
    ...overrides,
  } as unknown as StudioContextValue;
}
function renderView(
  value: StudioContextValue,
  createRequest?: { key: number; body: string },
) {
  return render(
    <StudioContext.Provider value={value}>
      <TemplatesView createRequest={createRequest} />
    </StudioContext.Provider>,
  );
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});
afterEach(cleanup);

describe("テンプレートの管理", () => {
  it("制作から保存する本文は独立した新規ダイアログで開く", async () => {
    const value = context();
    const view = renderView(value);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(
      <StudioContext.Provider value={value}>
        <TemplatesView createRequest={{ key: 1, body: "制作中のプロンプト" }} />
      </StudioContext.Provider>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/プロンプトの本文/)).toHaveValue(
      "制作中のプロンプト",
    );
    expect(within(dialog).getByLabelText(/名前/)).toHaveValue(
      "制作中のプロンプト",
    );
    expect(within(dialog).getByLabelText(/名前/)).toHaveFocus();
  });

  it("本文だけで名前を自動入力し、本文の変更に追従して保存する", async () => {
    const user = userEvent.setup();
    const api = vi.fn().mockResolvedValue(current);
    renderView(context({ api }));
    await user.click(screen.getByRole("button", { name: "新しいテンプレート" }));
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByLabelText(/名前/);
    const body = within(dialog).getByLabelText(/プロンプトの本文/);
    await user.type(body, "白い背景");
    expect(name).toHaveValue("白い背景");
    await user.type(body, "と自然光");
    expect(name).toHaveValue("白い背景と自然光");
    await user.clear(body);
    expect(name).toHaveValue("");
    await user.type(body, "窓からの光");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/templates",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(JSON.parse(api.mock.calls[0][1].body)).toMatchObject({
      name: "窓からの光",
      body: "窓からの光",
    });
  });

  it("手動入力した名前を保持し、名前を空にしたら次の本文入力で自動入力を再開する", async () => {
    const user = userEvent.setup();
    renderView(context());
    await user.click(screen.getByRole("button", { name: "新しいテンプレート" }));
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByLabelText(/名前/);
    const body = within(dialog).getByLabelText(/プロンプトの本文/);
    await user.type(name, "背景の設定");
    await user.type(body, "白い背景");
    expect(name).toHaveValue("背景の設定");
    await user.clear(name);
    await user.type(body, "と自然光");
    expect(name).toHaveValue("白い背景と自然光");
    await user.clear(name);
    await user.type(name, "別の名前");
    await user.type(body, "を使う");
    expect(name).toHaveValue("別の名前");

    await user.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await user.click(screen.getByRole("button", { name: "新しいテンプレート" }));
    await user.type(screen.getByLabelText(/プロンプトの本文/), "新しい本文");
    expect(screen.getByLabelText(/名前/)).toHaveValue("新しい本文");
  });

  it("名前と本文が同じ既存テンプレートも本文の変更に追従する", async () => {
    const user = userEvent.setup();
    const template = { ...current, name: "白い背景", body: "白い背景" };
    const api = vi.fn().mockResolvedValue(template);
    renderView(context({ templates: [template], api }));
    await user.click(screen.getByRole("button", { name: "編集" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/プロンプトの本文/), "と自然光");
    expect(within(dialog).getByLabelText(/名前/)).toHaveValue("白い背景と自然光");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    expect(api.mock.calls[0][0]).toBe(`/api/templates/${template.id}`);
    expect(api.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(api.mock.calls[0][1].body)).toMatchObject({
      name: "白い背景と自然光",
      body: "白い背景と自然光",
      expectedVersion: 2,
    });
  });

  it("長文や改行を含む本文から80文字以内の名前を作り、本文と絵文字を壊さない", async () => {
    const user = userEvent.setup();
    const prefix = "あ".repeat(77);
    const prompt = `  ${prefix}\n🌸白い背景  `;
    const api = vi.fn().mockResolvedValue(current);
    renderView(context({ api }), { key: 1, body: prompt });
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText(/名前/);
    const body = within(dialog).getByLabelText(/プロンプトの本文/);
    expect(name).toHaveValue(`${prefix} 🌸`);
    expect(body).toHaveValue(prompt);
    await user.clear(body);
    await user.paste(`${"あ".repeat(79)}🌸白い背景`);
    expect(name).toHaveValue("あ".repeat(79));
    await user.clear(body);
    await user.paste(`${"あ".repeat(79)}\n🌸白い背景`);
    expect(name).toHaveValue("あ".repeat(79));
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    expect(JSON.parse(api.mock.calls[0][1].body)).toMatchObject({
      name: "あ".repeat(79),
      body: `${"あ".repeat(79)}\n🌸白い背景`,
    });
  });

  it("Escapeで編集を閉じると、編集を開いた操作へフォーカスを戻す", async () => {
    const user = userEvent.setup();
    renderView(context());
    const edit = screen.getByRole("button", { name: "編集" });
    await user.click(edit);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(edit).toHaveFocus());
  });

  it("409時は入力と編集元の版を保持し、明示的に最新版を読み込んだ後だけ置き換える", async () => {
    const user = userEvent.setup();
    const newer = { ...latest, version: 3, body: "別の操作で更新した本文。" };
    const api = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("競合しました"), {
          status: 409,
          code: "VERSION_CONFLICT",
        }),
      )
      .mockResolvedValueOnce({ versions: [newer, latest, old] })
      .mockResolvedValueOnce({ ...newer, version: 4 });
    const value = context({ api });
    renderView(value);
    await user.click(screen.getByRole("button", { name: "編集" }));
    const dialog = screen.getByRole("dialog");
    const body = within(dialog).getByLabelText(/プロンプトの本文/);
    await user.clear(body);
    await user.type(body, "編集中の内容を残す。");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await within(dialog).findByRole("alert");
    expect(body).toHaveValue("編集中の内容を残す。");
    expect(within(dialog).getByLabelText(/名前/)).toHaveValue(current.name);
    expect(JSON.parse(api.mock.calls[0][1].body)).toMatchObject({
      expectedVersion: 2,
      name: current.name,
      body: "編集中の内容を残す。",
    });
    expect(api).toHaveBeenCalledTimes(1);
    await user.click(
      within(dialog).getByRole("button", { name: "最新を読み込む" }),
    );
    await waitFor(() => expect(body).toHaveValue("別の操作で更新した本文。"));
    expect(within(dialog).getByLabelText(/名前/)).toHaveValue(newer.name);
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(JSON.parse(api.mock.calls[2][1].body)).toMatchObject({
      expectedVersion: 3,
      body: "別の操作で更新した本文。",
    });
  });

  it("選んだ過去版を制作に追加し、版復元には最新版のexpectedVersionを送る", async () => {
    const user = userEvent.setup();
    const api = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path.endsWith("/revert")
          ? { ...current, body: old.body, version: 3 }
          : { versions: [latest, old] },
      );
    const value = context({ api });
    renderView(value);
    await user.click(screen.getByRole("tab", { name: "履歴・差分" }));
    const afterSelect = await screen.findByRole("combobox", {
      name: "比較先の版",
    });
    await waitFor(() => expect(afterSelect).not.toBeDisabled());
    await user.click(afterSelect);
    await user.click(screen.getByRole("option", { name: "v1" }));
    await user.click(screen.getByRole("button", { name: "v1 を制作に追加" }));
    expect(value.addTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: current.id,
        version: 1,
        body: "過去の暖色。",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "v1 の内容を新しい版として復元" }),
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/templates/color-template/revert",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ version: 1, expectedVersion: 2 }),
        }),
      ),
    );
    expect(value.refresh).toHaveBeenCalled();
  });

  it("アーカイブからの復元は選択した版を編集元として送る", async () => {
    const user = userEvent.setup();
    const archived = {
      ...current,
      archivedAt: "2026-10-02T03:00:00Z",
      version: 3,
    };
    const api = vi
      .fn()
      .mockResolvedValue({ ...archived, archivedAt: null, version: 4 });
    const value = context({ templates: [archived], api });
    renderView(value);
    await user.click(screen.getByRole("tab", { name: /アーカイブ/ }));
    await user.click(
      screen.getByRole("button", { name: "アーカイブから復元" }),
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/templates/color-template/restore",
        { method: "POST", body: JSON.stringify({ expectedVersion: 3 }) },
      ),
    );
  });
});

describe("制作でのテンプレート選択", () => {
  it("追加済みの版を表示し、管理は明示的な遷移で開く", async () => {
    const user = userEvent.setup();
    const value = context({ draft: { ...context().draft, layers: [old] } });
    const onOpenChange = vi.fn(),
      onManage = vi.fn();
    render(
      <StudioContext.Provider value={value}>
        <TemplatePicker open onOpenChange={onOpenChange} onManage={onManage} />
      </StudioContext.Provider>,
    );
    expect(screen.getByText("下書きには v1 を追加済み")).toBeInTheDocument();
    expect(screen.queryByLabelText(/プロンプトの本文/)).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: `${current.name}を最新版に更新` }),
    );
    expect(value.addTemplate).toHaveBeenCalledWith(current);
    await user.click(
      screen.getByRole("button", { name: "テンプレートを管理" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onManage).toHaveBeenCalledOnce();
  });
});
