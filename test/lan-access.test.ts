import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { createApp } from '../src/http-app.js';
import { JobManager, JobStore } from '../src/job-store.js';
import { LanAccess, validateLanHost } from '../src/lan-access.js';
import { close, listen, serverPort, type TestAdapter } from './helpers.js';

function readPairing(page: string) {
  const image = page.match(/id="pairing-qr"[^>]+src="data:image\/png;base64,([^"]+)"/);
  assert.ok(image, 'QR画像が表示される');
  const png = PNG.sync.read(Buffer.from(image[1], 'base64'));
  const decoded = jsQR.default(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(decoded, '表示されたQR画像を読み取れる');
  const url = new URL(decoded.data);
  const qrToken = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.match(qrToken ?? '', /^[A-Za-z0-9_-]{43}$/);
  const code = page.match(/id="pairing-code">(\d{8})/);
  assert.ok(code, '番号入力用の8桁コードを残す');
  return { url, qrToken: qrToken!, code: code[1] };
}

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-lan-'));
  const store = new JobStore(directory); await store.initialize();
  const adapter: TestAdapter = { health: async () => ({ ready: true, message: 'Ready' }), generate: async () => { throw new Error('テストで画像生成を呼び出してはいけません'); } };
  const manager = new JobManager(store, adapter);
  let now = Date.now();
  const access = new LanAccess('http://192.168.11.11', () => now);
  const options = { store, manager, adapter, publicDirectory: resolve('public'), lanAccess: access };
  const local = createApp(options), remote = createApp({ ...options, lanHost: '192.168.11.11' });
  await listen(local); await listen(remote);
  // The test connects to a loopback socket while using exactly the allowed LAN Host.
  const localBase = `http://127.0.0.1:${serverPort(local)}`, remoteBase = `http://192.168.11.11:${serverPort(remote)}`;
  Object.defineProperty(access, 'url', { value: remoteBase });
  t.after(async () => { await manager.close(); await close(local); await close(remote); await rm(directory, { recursive: true, force: true }); });
  async function lan(path: string, { method = 'GET', headers = {}, body = '' }: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return await new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${serverPort(remote)}${path}`, { method, headers: { Host: `192.168.11.11:${serverPort(remote)}`, ...headers } }, response => {
        let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body: text, headers: response.headers }));
      }); request.on('error', reject); request.end(body);
    });
  }
  async function owner(action = 'code') {
    const page = await (await fetch(`${localBase}/lan`)).text();
    const token = page.match(/name="token" value="([^"]+)"/)![1];
    const response = await fetch(`${localBase}/lan/${action}`, { method: 'POST', headers: { Origin: localBase, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
    assert.equal(response.status, 200); return await response.text();
  }
  async function code() { return (await owner()).match(/id="pairing-code">(\d{8})/)![1]; }
  async function pair(value: string) { return await lan('/lan/pair', { method: 'POST', headers: { Origin: remoteBase, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: value }).toString() }); }
  async function pairQr(qrToken: string) { return await lan('/lan/pair', { method: 'POST', headers: { Origin: remoteBase, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ qrToken }).toString() }); }
  async function cookie() { const response = await pair(await code()); assert.equal(response.status, 303); return response.headers['set-cookie']![0].split(';')[0]; }
  return { store, localBase, remoteBase, lan, owner, code, pair, pairQr, cookie, advance: (ms: number) => { now += ms; } };
}

test('LAN_HOSTはMacに割り当てられたプライベートIPv4だけを受け付ける', () => {
  const interfaces = { en0: [{ address: '192.168.11.11', family: 'IPv4' as const, internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: '192.168.11.11/24' }] };
  assert.equal(validateLanHost(undefined, interfaces), undefined);
  assert.equal(validateLanHost('192.168.11.11', interfaces), '192.168.11.11');
  for (const address of ['0.0.0.0', '127.0.0.1', '::', '8.8.8.8', '192.168.11.12', 'localhost', '<script>']) assert.throws(() => validateLanHost(address, interfaces));
});
test('未承認端末にはコード入力だけを表示し、全APIと画像・画面アセットを保護する', async t => {
  const { localBase, lan } = await setup(t);
  assert.equal((await fetch(localBase)).status, 200);
  const login = await lan('/'); assert.equal(login.status, 200); assert.match(login.body, /このスマホを承認/); assert.doesNotMatch(login.body, /\/assets\//);
  assert.equal(login.headers['referrer-policy'], 'same-origin');
  for (const path of ['/api/session', '/api/jobs', '/api/lineage', '/api/templates', '/api/uploads', '/api/trash', '/api/health', '/api/jobs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/image', '/api/uploads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/image', '/assets/index.js', '/favicon.svg', '/lan', '/lan/code']) {
    const response = await lan(path); assert.equal(response.status, 401, path); assert.match(response.body, /DEVICE_AUTH_REQUIRED/);
  }
  assert.equal((await lan('/api/jobs', { method: 'POST', body: '{"prompt":"cat"}' })).status, 401);
});
test('スマホ連携を開くだけで読めるQRと番号を表示し、再読み込みで期限を延ばさない', async t => {
  const { localBase, remoteBase, pairQr, advance } = await setup(t);
  const response = await fetch(`${localBase}/lan`), page = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  const pairing = readPairing(page);
  assert.equal(pairing.url.origin, remoteBase);
  assert.equal(pairing.url.pathname, '/lan/qr');
  assert.equal(pairing.url.search, '');
  advance(4 * 60_000);
  const refreshed = readPairing(await (await fetch(`${localBase}/lan`)).text());
  assert.equal(refreshed.qrToken, pairing.qrToken);
  assert.equal(refreshed.code, pairing.code);
  advance(60_000);
  assert.equal((await pairQr(pairing.qrToken)).status, 403);
  const renewed = readPairing(await (await fetch(`${localBase}/lan`)).text());
  assert.notEqual(renewed.qrToken, pairing.qrToken);
  assert.equal((await pairQr(renewed.qrToken)).status, 303);
});
test('QRリンクのプレビューでは消費せず、ブラウザがURLから秘密を消して自動承認する', async t => {
  const { owner, lan, remoteBase, pair } = await setup(t);
  const pairing = readPairing(await owner());
  const preview = await lan(pairing.url.pathname), script = await lan('/lan/qr.js');
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['set-cookie'], undefined);
  assert.equal(preview.headers['referrer-policy'], 'same-origin');
  assert.doesNotMatch(preview.body, new RegExp(pairing.qrToken));
  assert.match(preview.body, /<script src="\/lan\/qr.js" defer>/);
  assert.match(preview.headers['content-security-policy'] as string, /script-src 'self';/);
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'] as string, /text\/javascript/);
  assert.doesNotMatch(script.body, new RegExp(pairing.qrToken));
  const dom = new JSDOM(preview.body, { url: pairing.url.href, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  let submission: ReturnType<typeof lan> | undefined;
  const form = dom.window.document.querySelector<HTMLFormElement>('#qr-pairing-form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    assert.equal(dom.window.location.hash, '');
    assert.equal(dom.window.location.search, '');
    const input = form.querySelector<HTMLInputElement>('#qr-token')!;
    assert.equal(input.value, pairing.qrToken);
    submission = lan(form.getAttribute('action')!, { method: 'POST', headers: { Origin: remoteBase, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ [input.name]: input.value }).toString() });
  });
  dom.window.eval(script.body);
  assert.ok(submission, '番号入力やボタン操作なしで送信する');
  const response = await submission;
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/');
  assert.match(response.headers['set-cookie']![0], /HttpOnly; SameSite=Strict; Path=\//);
  const cookie = response.headers['set-cookie']![0].split(';')[0];
  assert.equal((await lan('/api/jobs', { headers: { Cookie: cookie } })).status, 200);
  assert.match((await lan('/', { headers: { Cookie: cookie } })).body, /\/assets\//);
  assert.equal((await pair(pairing.code)).status, 403);
});
test('QRが欠けたリンクでは自動送信せず、番号入力へ案内する', async t => {
  const { lan, remoteBase } = await setup(t);
  const preview = await lan('/lan/qr'), script = await lan('/lan/qr.js');
  for (const hash of ['', '#token=invalid', '#token=%3Cscript%3E']) {
    const dom = new JSDOM(preview.body, { url: `${remoteBase}/lan/qr${hash}`, runScripts: 'outside-only' });
    try {
      let submitted = false;
      dom.window.document.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); submitted = true; });
      dom.window.eval(script.body);
      assert.equal(submitted, false);
      assert.equal(dom.window.location.hash, '');
      assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /番号で承認/);
      assert.equal(dom.window.document.querySelector('a')!.getAttribute('href'), '/');
    } finally { dom.window.close(); }
  }
});
test('QRと番号はどちらで承認しても両方が単回使用になり、同時送信でも1台だけ承認する', async t => {
  const { owner, pair, pairQr } = await setup(t);
  const first = readPairing(await owner());
  assert.equal((await pairQr(first.qrToken)).status, 303);
  assert.equal((await pairQr(first.qrToken)).status, 403);
  assert.equal((await pair(first.code)).status, 403);
  const second = readPairing(await owner());
  assert.equal((await pair(second.code)).status, 303);
  assert.equal((await pairQr(second.qrToken)).status, 403);
  const third = readPairing(await owner());
  const simultaneous = await Promise.all([pairQr(third.qrToken), pair(third.code)]);
  assert.deepEqual(simultaneous.map(response => response.status).sort(), [303, 403]);
});
test('QRの再発行・期限切れ・承認解除と8時間の端末期限でアクセスを失効する', async t => {
  const { owner, pairQr, lan, advance } = await setup(t);
  const old = readPairing(await owner()); await owner();
  assert.equal((await pairQr(old.qrToken)).status, 403);
  const expired = readPairing(await owner()); advance(5 * 60_000);
  assert.equal((await pairQr(expired.qrToken)).status, 403);
  const fresh = readPairing(await owner()), paired = await pairQr(fresh.qrToken);
  const cookie = paired.headers['set-cookie']![0].split(';')[0];
  advance(8 * 60 * 60_000);
  assert.equal((await lan('/api/jobs', { headers: { Cookie: cookie } })).status, 401);
  const next = readPairing(await owner()), connected = await pairQr(next.qrToken);
  const nextCookie = connected.headers['set-cookie']![0].split(';')[0];
  const pending = readPairing(await owner());
  const revoked = await owner('revoke');
  assert.doesNotMatch(revoked, /id="pairing-qr"|id="pairing-code"/);
  assert.equal((await pairQr(pending.qrToken)).status, 403);
  assert.equal((await lan('/api/jobs', { headers: { Cookie: nextCookie } })).status, 401);
});
test('QR承認も接続元と試行回数を検証し、不正なQRから正しい番号へ切り替えない', async t => {
  const { owner, pairQr, lan, remoteBase } = await setup(t);
  const pairing = readPairing(await owner());
  const origins: Record<string, string>[] = [{}, { Origin: 'https://evil.example' }];
  for (const headers of origins) {
    const response = await lan('/lan/pair', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ qrToken: pairing.qrToken }).toString() });
    assert.equal(response.status, 403);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal((await lan('/lan/pair', { method: 'POST', headers: { Origin: remoteBase, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ qrToken: '', code: pairing.code }).toString() })).status, 403);
  assert.equal((await pairQr(pairing.qrToken)).status, 303);
  const limited = readPairing(await owner());
  const wrong = limited.qrToken === 'A'.repeat(43) ? 'B'.repeat(43) : 'A'.repeat(43);
  for (let index = 0; index < 5; index++) assert.equal((await pairQr(wrong)).status, 403);
  assert.equal((await pairQr(limited.qrToken)).status, 403);
  for (let index = 8; index < 20; index++) await pairQr(wrong);
  const throttled = await pairQr(wrong);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers['retry-after'], '60');
});
test('コードは単回使用で、承認後の画像・履歴とCSRF保護を維持する', async t => {
  const { store, code, pair, lan } = await setup(t);
  const value = await code(), response = await pair(value), cookie = response.headers['set-cookie']![0].split(';')[0];
  assert.equal(response.status, 303); assert.match(response.headers['set-cookie']![0], /HttpOnly; SameSite=Strict; Path=\//);
  assert.equal((await pair(value)).status, 403);
  const job = await store.create({ prompt: 'private image', size: 'square', style: 'auto', transparent: false });
  await store.update(job.id, { status: 'succeeded', image: { fileName: 'image.png', mime: 'image/png', bytes: 4 } });
  await writeFile(join(store.directory, job.id, 'image.png'), Buffer.from([137, 80, 78, 71]));
  const headers = { Cookie: cookie };
  assert.match((await lan('/api/jobs', { headers })).body, /private image/);
  assert.equal((await lan(`/api/jobs/${job.id}/image`, { headers })).status, 200);
  assert.match((await lan('/', { headers })).body, /\/assets\//);
  assert.equal((await lan('/api/jobs', { method: 'POST', headers, body: '{}' })).status, 403);
  const token = JSON.parse((await lan('/api/session', { headers })).body).token as string;
  assert.equal((await lan(`/api/jobs/${job.id}/favorite`, { method: 'PATCH', headers: { ...headers, 'X-Studio-Token': token, 'Content-Type': 'application/json' }, body: '{"favorite":true}' })).status, 200);
  assert.equal(store.get(job.id).favorite, true);
});
test('承認用フォームはOriginを保持し、nullや別Originのコード発行を拒否する', async t => {
  const { localBase } = await setup(t);
  const ownerPage = await fetch(`${localBase}/lan`);
  assert.equal(ownerPage.headers.get('referrer-policy'), 'same-origin');
  const page = await ownerPage.text();
  const token = page.match(/name="token" value="([^"]+)"/)![1];
  for (const origin of ['null', localBase.replace('127.0.0.1', 'localhost'), 'https://evil.example']) {
    const rejected = await fetch(`${localBase}/lan/code`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    assert.equal(rejected.status, 403);
    assert.match(await rejected.text(), /INVALID_ORIGIN/);
  }
  const response = await fetch(`${localBase}/lan/code`, {
    method: 'POST',
    headers: { Origin: localBase, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.match(await response.text(), /id="pairing-code">\d{8}/);
});
test('コード再発行・期限切れ・端末期限切れ・承認解除はアクセスを失効する', async t => {
  const { code, pair, cookie, lan, owner, advance } = await setup(t);
  const previous = await code(); await code(); assert.equal((await pair(previous)).status, 403);
  const expired = await code(); advance(5 * 60_000); assert.equal((await pair(expired)).status, 403);
  const first = await cookie(); advance(8 * 60 * 60_000); assert.equal((await lan('/api/jobs', { headers: { Cookie: first } })).status, 401);
  const second = await cookie(); await owner('revoke'); assert.equal((await lan('/api/jobs', { headers: { Cookie: second } })).status, 401);
  assert.equal((await lan('/api/jobs', { headers: { Cookie: 'studio-device=fake' } })).status, 401);
});
test('ホスト偽装・別サイト・LANからのコード発行を拒否する', async t => {
  const { lan, localBase, cookie } = await setup(t);
  assert.equal((await lan('/', { headers: { Host: 'localhost:4317' } })).status, 403);
  assert.equal((await lan('/lan/pair', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=00000000' })).status, 403);
  assert.equal((await lan('/lan/pair', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=00000000' })).status, 403);
  const session = await cookie();
  assert.equal((await lan('/api/jobs', { headers: { Cookie: session, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await lan('/lan/code', { method: 'POST', headers: { Cookie: session }, body: 'token=fake' })).status, 403);
  assert.equal((await fetch(`${localBase}/lan/code`, { method: 'POST', headers: { Origin: localBase, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=fake' })).status, 403);
});
test('コードの総当たりを制限し、巨大なフォームを拒否する', async t => {
  const { code, pair, lan, remoteBase } = await setup(t);
  const value = await code(), wrong = value === '00000000' ? '11111111' : '00000000';
  for (let index = 0; index < 5; index++) assert.equal((await pair(wrong)).status, 403);
  assert.equal((await pair(value)).status, 403);
  for (let index = 6; index < 20; index++) await pair(wrong);
  assert.equal((await pair(wrong)).status, 429);
  const other = await setup(t);
  assert.equal((await other.lan('/lan/pair', { method: 'POST', headers: { Origin: other.remoteBase, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(1100) })).status, 413);
  assert.equal((await lan('/lan/pair', { method: 'POST', headers: { Origin: remoteBase }, body: '{}' })).status, 429);
});
test('LANを有効にしない既定起動ではローカル画面だけを提供する', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-local-')); const store = new JobStore(directory); await store.initialize();
  const adapter: TestAdapter = { health: async () => ({ ready: true, message: 'Ready' }), generate: async () => { throw new Error('unused'); } };
  const manager = new JobManager(store, adapter);
  assert.throws(() => createApp({ store, manager, adapter, publicDirectory: resolve('public'), lanHost: '192.168.11.11' }));
  const server = createApp({ store, manager, adapter, publicDirectory: resolve('public') }); await listen(server);
  t.after(async () => { await manager.close(); await close(server); await rm(directory, { recursive: true, force: true }); });
  assert.match(await (await fetch(`http://127.0.0.1:${serverPort(server)}/lan`)).text(), /スマホ接続は無効/);
});
