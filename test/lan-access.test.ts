import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http-app.js';
import { JobManager, JobStore } from '../src/job-store.js';
import { LanAccess, validateLanHost } from '../src/lan-access.js';
import { close, listen, serverPort, type TestAdapter } from './helpers.js';

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
  async function cookie() { const response = await pair(await code()); assert.equal(response.status, 303); return response.headers['set-cookie']![0].split(';')[0]; }
  return { store, localBase, remoteBase, lan, owner, code, pair, cookie, advance: (ms: number) => { now += ms; } };
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
