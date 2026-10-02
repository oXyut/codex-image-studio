import type { FailureCategory } from '../shared/types.js';
import { record } from '../shared/unknown.js';
import { AppError, safeMessage } from './validation.js';

const categories = new Set(['unknown', 'content', 'usage', 'auth', 'transient', 'timeout', 'cancelled']);
const connectionTypes = new Set(['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']);
const normalizedCode = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

// Read individual text fields, never serialize an event, arbitrary object, or
// image result. Mask before truncation so a partial credential cannot survive.
function textDetail(value: unknown, max = 1200) {
  if (typeof value !== 'string') return '';
  if (/^(?:iVBORw0KGgo|UklGR|\/9j\/)/.test(value.trimStart())) return '[画像データ省略]';
  const masked = safeMessage(value);
  return masked
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/_=\s-]+/gi, '[画像データ省略]')
    .replace(/\b(?:iVBORw0KGgo|UklGR)[a-z0-9+/_=-]+|\/9j\/[a-z0-9+/_=-]+/gi, '[画像データ省略]')
    .replace(/[a-z0-9+/_=-]{128,}/gi, '[長いデータ省略]')
    .trim().slice(0, max);
}

function errorInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // Image payloads can be many megabytes; only bounded JSON error messages
  // should be parsed. Opaque strings still pass through the text-only filter.
  if (/^[{[]/.test(value.trimStart())) {
    if (value.length > 64000) return null;
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

function codexInfo(inner: Record<string, unknown>) {
  const info = inner?.codexErrorInfo;
  if (typeof info === 'string') return { type: textDetail(info, 120), httpStatusCode: null };
  if (!info || typeof info !== 'object' || Array.isArray(info)) return { type: '', httpStatusCode: null };
  // The enum's object variants have one known key. Do not inspect arbitrary
  // nested data, even when a future protocol adds fields to this object.
  for (const type of connectionTypes) if (Object.hasOwn(info, type)) {
    const status = record(record(info)[type]).httpStatusCode;
    return { type, httpStatusCode: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null };
  }
  if (Object.hasOwn(info, 'activeTurnNotSteerable')) return { type: 'activeTurnNotSteerable', httpStatusCode: null };
  return { type: '', httpStatusCode: null };
}

function detailSummary(inner: Record<string, unknown>, original: string, code: string, info: { type: string; httpStatusCode: number | null }) {
  const parts = [];
  if (info.type) parts.push(`Codex: ${info.type}`);
  if (code && code !== info.type) parts.push(`エラーコード: ${code}`);
  const status = info.httpStatusCode ?? inner?.httpStatusCode ?? (inner instanceof Error ? undefined : inner?.status);
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) parts.push(`HTTP: ${status}`);
  if (original) parts.push(original);
  const additional = textDetail(inner?.additionalDetails ?? inner?.detail, 700);
  if (additional && additional !== original) parts.push(additional);
  const explanation = textDetail(record(inner.misalignment).detailedExplanation, 700);
  if (explanation && !parts.includes(explanation)) parts.push(explanation);
  return textDetail(parts.join('\n')) || null;
}

export function generationError(value: unknown, fallbackCode = 'GENERATION_FAILED') {
  const existing = value instanceof Error;
  const data = errorInput(value);
  const innerValue = record(data).error ?? record(data).failure ?? data;
  const inner = record(innerValue);
  const rawCode = existing ? record(value).code : inner?.code ?? inner?.type;
  const sourceCode = typeof rawCode === 'string' ? textDetail(rawCode, 120) : '';
  const code = sourceCode || fallbackCode;
  const original = textDetail(existing ? value.message : typeof innerValue === 'string' ? innerValue : inner?.message ?? inner?.detail, 900);
  const info = codexInfo(inner);
  const status = info.httpStatusCode ?? inner?.httpStatusCode ?? (inner instanceof Error ? undefined : inner?.status);
  const details = existing && Object.hasOwn(value, 'details')
    ? textDetail(record(value).details) || null
    : detailSummary(inner, original, sourceCode, info);
  const hint = `${code} ${info.type} ${original} ${textDetail(inner?.additionalDetails, 700)}`;
  const type = normalizedCode(info.type || code);
  let category: FailureCategory = 'unknown';
  let message = original || '画像を生成できませんでした。';
  let advice = '入力を保持しています。設定や入力内容を確認して再試行してください。', retryable = false, resultCode = code;

  if (normalizedCode(code) === 'cancelled' || normalizedCode(code) === 'canceled') {
    category = 'cancelled'; advice = '生成をキャンセルしました。入力は保持しています。';
  } else if (['timeout', 'rpctimeout'].includes(normalizedCode(code))) {
    category = 'timeout'; advice = '処理の状態が不明なため自動で再生成しません。入力を保持しています。必要に応じて再試行してください。';
  } else if (/^(?:contentpolicy|contentreview|moderation|safety|refusal|cyberpolicy|misalignmentpolicyviolation)/.test(type) ||
    /content[_ -]polic(?:y|ies)|moderation[_ -]?(?:blocked|rejected|violation)|safety[_ -](?:policy|violation|blocked)|policy.?violation|\brefusal\b|CONTENT_REVIEW|ガイドライン|ポリシー/i.test(hint) ||
    /(?:性的(?:な)?内容|sexual content)[^\n]{0,100}(?:拒否|停止|rejected|blocked)|(?:拒否|rejected|blocked)[^\n]{0,100}(?:性的(?:な)?内容|sexual content)/i.test(hint)) {
    category = 'content'; resultCode = 'CONTENT_REVIEW'; message = '画像の内容確認により生成が停止しました。';
    advice = '文章・テンプレート・参照画像は保持しています。意図や内容を確認・編集してから再試行してください。'; retryable = true;
  } else if (['usagelimitexceeded', 'sessionbudgetexceeded', 'imageusagelimit'].includes(type) ||
    /usage.?limit|quota|credits.*exhaust|IMAGE_USAGE_LIMIT|利用上限/i.test(hint)) {
    category = 'usage'; resultCode = 'IMAGE_USAGE_LIMIT'; message = '画像生成の利用上限に達しました。';
    advice = '入力を保持しています。利用枠が回復してから再試行してください。';
  } else if (type === 'unauthorized' || status === 401 || /unauthorized|authentication|token.*expired|CHATGPT_LOGIN_REQUIRED/i.test(hint)) {
    category = 'auth'; resultCode = 'CHATGPT_LOGIN_REQUIRED'; message = 'ChatGPT認証を確認してください。';
    advice = '必要に応じてターミナルで codex login を実行してください。入力は保持しています。';
  } else if (['ratelimitexceeded', 'serveroverloaded', 'internalservererror'].includes(type) ||
    (connectionTypes.has(info.type) && (status === null || status === undefined)) || status === 429 || [502, 503, 504].includes(typeof status === 'number' ? status : 0) ||
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|CLI_DISCONNECTED|temporar|connection.*(?:reset|closed|lost)|service.*unavailable|internal_server_error|overloaded|rate_limit_exceeded|too many requests|(?:HTTP.?)?\b50[234]\b|TRANSIENT_ERROR/i.test(hint)) {
    category = 'transient'; resultCode = 'TRANSIENT_ERROR'; message = '通信または生成サービスで一時的なエラーが発生しました。';
    advice = '入力を保持しています。少し待ってから再試行できます。'; retryable = true;
  }

  // The manager normalizes adapter failures again. Keep the adapter's selected
  // diagnosis and conservative no-retry decision across that boundary.
  if (existing && typeof record(value).category === 'string' && categories.has(record(value).category as string) && !['cancelled', 'timeout'].includes(category)) {
    category = record(value).category as FailureCategory; resultCode = code; message = original || message;
    advice = textDetail(record(value).advice) || advice;
    retryable = typeof record(value).retryable === 'boolean' ? record(value).retryable as boolean : ['transient', 'content'].includes(category);
  }
  if (['usage', 'auth', 'timeout', 'cancelled'].includes(category)) retryable = false;
  const error = new AppError(message, resultCode, existing && typeof record(value).status === 'number' ? record(value).status as number : 500);
  return Object.assign(error, { category, details, advice, retryable,
    autoRetryAllowed: retryable && (existing && typeof record(value).autoRetryAllowed === 'boolean' ? record(value).autoRetryAllowed as boolean : true) });
}

export function publicFailure(error: unknown) {
  const result = generationError(error);
  return { code: result.code, category: result.category, message: result.message, details: result.details,
    advice: result.advice, retryable: result.retryable };
}
