/** The subset of the app-server protocol used by this adapter. */
export type ImageItem = {
  id: string; type: string; status?: string; savedPath?: string;
  result?: unknown; failure?: unknown; revisedPrompt?: string; text?: string; phase?: string;
};
export type Notification = {
  item?: ImageItem; willRetry?: boolean; error?: unknown;
  turn?: { status?: string; items?: ImageItem[]; error?: unknown };
};
export type RpcMessage = {
  id?: number | string; method?: string; params?: Notification;
  result?: unknown; error?: { message?: string };
};
export type RpcResults = {
  initialize: unknown;
  'account/read': { account?: { type?: string } | null };
  'model/list': { data?: { id: string; model: string; isDefault?: boolean }[] };
  'thread/start': { thread: { id: string } };
  'turn/start': unknown;
};
