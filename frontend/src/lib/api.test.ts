import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api";

const fetchMock = vi.fn<typeof fetch>();
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function requestHeaders(index: number) {
  return new Headers(fetchMock.mock.calls[index]?.[1]?.headers);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("ローカルAPIセッション", () => {
  it("読み取りではセッションを作らず、変更リクエストだけにトークンを付ける", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ jobs: [] }))
      .mockResolvedValueOnce(response({ token: "local-token" }))
      .mockResolvedValueOnce(response({ saved: true }))
      .mockResolvedValueOnce(response({ ready: true }));
    const api = createApi();
    await api("/api/jobs");
    await api("/api/templates", {
      method: "POST",
      body: JSON.stringify({ name: "光" }),
      headers: { Accept: "application/json" },
    });
    await api("/api/health", { method: "HEAD" });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/jobs",
      "/api/session",
      "/api/templates",
      "/api/health",
    ]);
    expect(requestHeaders(0).has("X-Studio-Token")).toBe(false);
    expect(requestHeaders(2).get("X-Studio-Token")).toBe("local-token");
    expect(requestHeaders(2).get("Content-Type")).toBe("application/json");
    expect(requestHeaders(2).get("Accept")).toBe("application/json");
    expect(requestHeaders(3).has("X-Studio-Token")).toBe(false);
  });

  it("同時の変更リクエストでは最初のセッション取得を共有する", async () => {
    let finishSession!: (response: Response) => void;
    fetchMock.mockImplementation((path) =>
      path === "/api/session"
        ? new Promise((resolve) => {
            finishSession = resolve;
          })
        : Promise.resolve(response({ saved: true })),
    );
    const api = createApi();
    const first = api("/api/templates/a", { method: "PATCH", body: "{}" });
    const second = api("/api/templates/b", { method: "DELETE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishSession(response({ token: "shared-token" }));
    await Promise.all([first, second]);

    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/session"),
    ).toHaveLength(1);
    expect(requestHeaders(1).get("X-Studio-Token")).toBe("shared-token");
    expect(requestHeaders(2).get("X-Studio-Token")).toBe("shared-token");
  });

  it("INVALID_SESSIONでは一度だけ更新し、同じ変更を新しいトークンで再試行する", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ token: "expired-token" }))
      .mockResolvedValueOnce(
        response(
          { error: { code: "INVALID_SESSION", message: "期限切れ" } },
          403,
        ),
      )
      .mockResolvedValueOnce(response({ token: "renewed-token" }))
      .mockResolvedValueOnce(response({ saved: true }));
    const api = createApi();
    const body = JSON.stringify({ title: "新しいタイトル" });
    await expect(
      api("/api/lineage/jobs/id", { method: "PATCH", body }),
    ).resolves.toEqual({ saved: true });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/session",
      "/api/lineage/jobs/id",
      "/api/session",
      "/api/lineage/jobs/id",
    ]);
    expect(requestHeaders(1).get("X-Studio-Token")).toBe("expired-token");
    expect(requestHeaders(3).get("X-Studio-Token")).toBe("renewed-token");
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: "PATCH", body });
  });

  it("更新後もINVALID_SESSIONなら追加の再試行をせずサーバーのエラーを返す", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ token: "first" }))
      .mockResolvedValueOnce(
        response(
          { error: { code: "INVALID_SESSION", message: "期限切れ" } },
          403,
        ),
      )
      .mockResolvedValueOnce(response({ token: "second" }))
      .mockResolvedValueOnce(
        response(
          {
            error: {
              code: "INVALID_SESSION",
              message: "このセッションは無効です",
            },
          },
          403,
        ),
      );
    await expect(
      createApi()("/api/jobs", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({
      message: "このセッションは無効です",
      code: "INVALID_SESSION",
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("更新以外の失敗はメッセージ・コード・HTTP状態を保持し、再試行しない", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ token: "token" }))
      .mockResolvedValueOnce(
        response(
          {
            error: {
              message: "別の画面でテンプレートが更新されています。",
              code: "VERSION_CONFLICT",
            },
          },
          409,
        ),
      );
    const failure = await createApi()("/api/templates/id", {
      method: "PATCH",
      body: "{}",
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      message: "別の画面でテンプレートが更新されています。",
      code: "VERSION_CONFLICT",
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("画像の生アップロードではファイル本体とMIME指定を保持する", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ token: "token" }))
      .mockResolvedValueOnce(response({ upload: { id: "uploaded" } }));
    const file = new File(["image bytes"], "forest.webp", {
      type: "image/webp",
    });
    await createApi()("/api/uploads?name=forest.webp", {
      method: "POST",
      body: file,
      headers: { "Content-Type": "image/webp" },
    });

    expect(fetchMock.mock.calls[1][1]?.body).toBe(file);
    expect(requestHeaders(1).get("Content-Type")).toBe("image/webp");
    expect(requestHeaders(1).get("X-Studio-Token")).toBe("token");
  });

  it("セッション取得が失敗した場合は変更を送らず、次の操作で取得し直せる", async () => {
    fetchMock
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({ token: "recovered" }))
      .mockResolvedValueOnce(response({ saved: true }));
    const api = createApi();
    await expect(
      api("/api/jobs", { method: "POST", body: "{}" }),
    ).rejects.toThrow("ローカルアプリに接続できません。");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/session",
    ]);
    await expect(
      api("/api/jobs", { method: "POST", body: "{}" }),
    ).resolves.toEqual({ saved: true });
    expect(requestHeaders(2).get("X-Studio-Token")).toBe("recovered");
  });

  it("通信の失敗を元の例外のまま返す", async () => {
    const failure = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValueOnce(failure);
    await expect(createApi()("/api/jobs")).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
