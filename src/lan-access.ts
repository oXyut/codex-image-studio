import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { AppError } from './validation.js';

const cookieName = 'studio-device';
const codeLifetime = 5 * 60_000;
const sessionLifetime = 8 * 60 * 60_000;
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };

export function validateLanHost(value: string | undefined, interfaces = networkInterfaces()): string | undefined {
  if (!value) return undefined;
  const parts = value.split('.').map(Number);
  const privateAddress = parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
  if (!isIPv4(value) || !privateAddress || !Object.values(interfaces).flat().some(address => address && !address.internal && address.address === value)) {
    throw new Error('LAN_HOSTには、このMacに割り当てられたプライベートIPv4アドレスを指定してください。');
  }
  return value;
}

export class LanAccess {
  private pairing?: { code: string; expires: number; failures: number };
  private sessions = new Map<string, number>();
  private attempts: number[] = [];
  constructor(readonly url: string, private now = Date.now) {}

  private prune() {
    const now = this.now();
    for (const [session, expires] of this.sessions) if (expires <= now) this.sessions.delete(session);
    this.attempts = this.attempts.filter(at => at > now - 60_000);
    if (this.pairing && this.pairing.expires <= now) this.pairing = undefined;
  }
  private session(request: IncomingMessage) {
    const cookies = (request.headers.cookie ?? '').split(';').map(cookie => cookie.trim());
    return cookies.find(cookie => cookie.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
  }
  private issueCode() {
    this.pairing = { code: String(randomInt(100_000_000)).padStart(8, '0'), expires: this.now() + codeLifetime, failures: 0 };
    return this.pairing.code;
  }
  // Runs before every LAN route, including assets, images, history and /api/session.
  async handle(request: IncomingMessage, response: ServerResponse, pathname: string, remote: boolean, csrfToken: string, nonce: string): Promise<boolean> {
    this.prune();
    if (!remote) {
      if (request.method === 'GET' && pathname === '/lan') {
        this.ownerPage(response, csrfToken, nonce); return true;
      }
      if (request.method === 'POST' && ['/lan/code', '/lan/revoke'].includes(pathname)) {
        const input = await form(request);
        if (!equal(input.get('token') ?? '', csrfToken) || request.headers.origin !== `http://${request.headers.host}`) throw new AppError('ページを開き直してください。', 'INVALID_SESSION', 403);
        if (pathname === '/lan/revoke') { this.sessions.clear(); this.pairing = undefined; this.ownerPage(response, csrfToken, nonce, undefined, 'すべてのスマホの承認を解除しました。'); }
        else this.ownerPage(response, csrfToken, nonce, this.issueCode());
        return true;
      }
      return false;
    }
    if (request.method === 'POST' && pathname === '/lan/pair') {
      if (request.headers.origin !== this.url) throw new AppError('接続元が一致しません。', 'INVALID_ORIGIN', 403);
      if (this.attempts.length >= 20) { response.statusCode = 429; response.setHeader('Retry-After', '60'); this.loginPage(response, nonce, '少し待ってからお試しください。'); return true; }
      this.attempts.push(this.now());
      const input = await form(request), code = input.get('code') ?? '';
      if (!/^\d{8}$/.test(code) || !this.pairing || !equal(code, this.pairing.code)) {
        if (this.pairing && ++this.pairing.failures >= 5) this.pairing = undefined;
        response.statusCode = 403; this.loginPage(response, nonce, 'コードが違うか、有効期限が切れています。Macでコードを発行し直してください。'); return true;
      }
      this.pairing = undefined;
      const session = randomBytes(32).toString('hex');
      if (this.sessions.size >= 10) this.sessions.delete(this.sessions.keys().next().value!);
      this.sessions.set(session, this.now() + sessionLifetime);
      response.setHeader('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}`);
      response.writeHead(303, { Location: '/' }); response.end(); return true;
    }
    if (this.sessions.has(this.session(request))) return false;
    if (request.method === 'GET' && pathname === '/') { this.loginPage(response, nonce); return true; }
    throw new AppError('Macに表示されたコードで、この端末を承認してください。', 'DEVICE_AUTH_REQUIRED', 401);
  }
  private ownerPage(response: ServerResponse, token: string, nonce: string, code?: string, message = '') {
    page(response, nonce, 'スマホで開く', `<p>同じWi-Fiに接続したスマホで、次のURLを開いてください。</p><p><a href="${this.url}">${this.url}</a></p><p>コードは5分間、1台だけに使えます。端末の承認は8時間、またはアプリ停止まで有効です。</p>${code ? `<p>スマホに入力するコード</p><strong id="pairing-code">${code}</strong>` : ''}<p>${message}</p><form method="post" action="/lan/code"><input type="hidden" name="token" value="${token}"><button>承認コードを発行${code ? 'し直す' : ''}</button></form><p>承認済み端末：${this.sessions.size}台</p><form method="post" action="/lan/revoke"><input type="hidden" name="token" value="${token}"><button>すべての端末の承認を解除</button></form><p>この接続は同じWi-Fi内のHTTP通信です。信頼できるネットワークで使ってください。</p><a href="/">制作画面に戻る</a>`);
  }
  private loginPage(response: ServerResponse, nonce: string, message = '') {
    page(response, nonce, 'このスマホを承認', `<p>Macの制作画面で「スマホで開く」を選び、承認コードを発行してください。</p>${message ? `<p role="alert">${message}</p>` : ''}<form method="post" action="/lan/pair"><label for="code">Macに表示された8桁のコード</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" maxlength="8" required><button>承認して開く</button></form>`);
  }
}

async function form(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new AppError('フォームから送信してください。', 'INVALID_CONTENT_TYPE', 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1024) throw new AppError('入力が大きすぎます。', 'PAYLOAD_TOO_LARGE', 413); chunks.push(chunk); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
function page(response: ServerResponse, nonce: string, title: string, body: string) {
  // Native form POSTs send Origin: null under no-referrer. Keep same-origin
  // submissions identifiable while still omitting referrers to other sites.
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Codex Image Studio</title><style nonce="${nonce}">body{font:16px/1.65 system-ui,sans-serif;color:#18181b;background:#fafafa;margin:0;padding:24px}main{max-width:480px;margin:40px auto;padding:24px;background:white;border:1px solid #ddd;border-radius:16px}h1{font-size:24px}a{color:#1d4ed8;overflow-wrap:anywhere}input,button{box-sizing:border-box;font:inherit;width:100%;padding:12px;margin:8px 0;border:1px solid #aaa;border-radius:8px}button{background:#18181b;color:white;cursor:pointer}strong{font:700 36px monospace;letter-spacing:4px}label{display:block}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`);
}

export function lanDisabledPage(response: ServerResponse, nonce: string) {
  page(response, nonce, 'スマホ接続は無効です', '<p>.envのLAN_HOSTに、このMacのWi-FiのプライベートIPv4アドレスを指定してアプリを起動し直してください。</p><p>有効にすると、ここでスマホの承認コードを発行できます。</p><a href="/">制作画面に戻る</a>');
}
