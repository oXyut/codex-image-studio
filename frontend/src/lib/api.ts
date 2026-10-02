import type { Api } from "./types";
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export function createApi(): Api {
  let token = "";
  let session: Promise<void> | undefined;
  const renew = async () => {
    if (!session)
      session = fetch("/api/session")
        .then(async (response) => {
          if (!response.ok) throw new Error("ローカルアプリに接続できません。");
          token = (await response.json()).token;
        })
        .finally(() => {
          session = undefined;
        });
    await session;
  };
  return async function api<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const mutation =
      options.method && !["GET", "HEAD"].includes(options.method);
    if (mutation && !token) await renew();
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(options.headers);
      if (mutation) {
        headers.set("X-Studio-Token", token);
        if (typeof options.body === "string")
          headers.set("Content-Type", "application/json");
      }
      const response = await fetch(path, { ...options, headers });
      const data = await response.json();
      if (response.ok) return data as T;
      if (data.error?.code === "INVALID_SESSION" && attempt === 0) {
        await renew();
        continue;
      }
      throw new ApiError(
        data.error?.message || "処理に失敗しました。",
        data.error?.code || "REQUEST_FAILED",
        response.status,
      );
    }
    throw new Error("ページを再読み込みしてからお試しください。");
  };
}
