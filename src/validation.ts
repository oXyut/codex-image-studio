import type { FailureCategory } from '../shared/types.js';
import { isRecord } from '../shared/unknown.js';

export class AppError extends Error {
  code: string; status: number;
  declare category?: FailureCategory; declare details?: string | null; declare advice?: string; declare retryable?: boolean; declare autoRetryAllowed?: boolean;
  constructor(message: string, code = 'INTERNAL_ERROR', status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const sizes: Record<string, string> = { auto: '自動', square: '1024×1024', landscape: '1536×1024', portrait: '1024×1536', widescreen: '1600×900', vertical: '900×1600' };
export const aspectRatios: Record<string, string> = { auto: 'auto', square: '1:1', landscape: '3:2', portrait: '2:3', widescreen: '16:9', vertical: '9:16' };
export const styles = ['auto', 'photo', 'illustration', '3d', 'minimal'];
export function validateBatchCount(count: unknown): number {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10) throw new AppError('生成枚数は1〜10枚の整数で指定してください。', 'INVALID_BATCH_COUNT', 400);
  return count;
}
export function validateInput(input: unknown, { allowEmptyPrompt = false } = {}) {
  if (!input || !isRecord(input)) throw new AppError('入力を確認してください。', 'INVALID_INPUT', 400);
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if ((!prompt && !allowEmptyPrompt) || prompt.length > 4000) throw new AppError('プロンプトを1〜4,000文字で入力するか、テンプレートを選んでください。', 'INVALID_PROMPT', 400);
  const size = input.size ?? 'square';
  const style = input.style ?? 'auto';
  if (typeof size !== 'string' || typeof style !== 'string' || !Object.hasOwn(sizes, size) || !styles.includes(style)) throw new AppError('サイズまたはスタイルを確認してください。', 'INVALID_OPTIONS', 400);
  if (input.transparent !== undefined && typeof input.transparent !== 'boolean') throw new AppError('背景の指定を確認してください。', 'INVALID_OPTIONS', 400);
  return { prompt, size, style, transparent: input.transparent ?? false };
}

export function safeMessage(value: unknown) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 1200);
}

export function cliErrorMessage(value: unknown) {
  let message = String(value ?? '');
  try { const parsed = JSON.parse(message); message = parsed.error?.message || parsed.message || message; } catch {}
  if (/model.*not supported|unsupported.*model/i.test(message)) return '選択されたモデルをこのChatGPTアカウントで利用できません。CODEX_MODELの設定を確認してください。';
  if (/usage limit|rate limit|quota|credits.*exhaust/i.test(message)) return '画像生成の利用上限に達しました。利用枠が回復してから再試行してください。';
  if (/unauthorized|authentication|token.*expired|sign in|log in/i.test(message)) return 'ChatGPT認証を確認してください。必要に応じて codex login を実行し、再試行してください。';
  return safeMessage(message);
}

export function imageType(buffer: Buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { extension: 'png', mime: 'image/png' };
  if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { extension: 'jpg', mime: 'image/jpeg' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
  throw new AppError('CLIから有効な画像データを受け取れませんでした。', 'INVALID_IMAGE');
}
