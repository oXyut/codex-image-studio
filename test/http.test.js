import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { JobStore, JobManager } from '../src/job-store.js';
import { createApp } from '../src/http-app.js';
import { TemplateStore } from '../src/template-store.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-http-')); const store = new JobStore(dir); await store.initialize();
  const adapter = { health: async () => ({ ready: true }), generate: async (_, { workspace }) => { await writeFile(join(workspace, '..', 'image.png'), Buffer.from([137,80,78,71])); return { fileName: 'image.png', mime: 'image/png', bytes: 4 }; } };
  const templates = new TemplateStore(join(dir, 'templates.json'), { seed: false }); await templates.initialize();
  const manager = new JobManager(store, adapter); const server = createApp({ store, manager, adapter, templates, publicDirectory: resolve('public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await manager.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/session`)).json();
  return { base, token, store, templates };
}
test('ローカル画面を配信し、外部サイトからの生成要求を拒否する', async t => {
  const { base, token } = await setup(t);
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Codex Image Studio/); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"prompt":"cat"}' })).status, 403);
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, Origin: 'https://example.com' }, body: '{"prompt":"cat"}' })).status, 403);
  const status = await new Promise((resolve, reject) => { const req = httpRequest(`${base}/api/jobs`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(status, 403);
});
test('画面から読み込むすべてのJavaScriptモジュールを配信する', async t => {
  const { base } = await setup(t);
  const html = await (await fetch(base)).text();
  const pending = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => new URL(match[1], base));
  const visited = new Set();
  while (pending.length) {
    const url = pending.pop();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    const response = await fetch(url);
    assert.equal(response.status, 200, `モジュールを配信できません: ${url.pathname}`);
    assert.match(response.headers.get('content-type'), /javascript/);
    const source = await response.text();
    for (const match of source.matchAll(/import\s+[^;]+?from\s+['"]([^'"]+)['"]/g)) pending.push(new URL(match[1], url));
  }
  assert.ok(visited.has(`${base}/canvas-options.js`));
});
test('入力エラーとパストラバーサルを拒否する', async t => {
  const { base, token } = await setup(t);
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': token };
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: '{"prompt":""}' })).status, 400);
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: '{bad' })).status, 400);
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'x'.repeat(65000) }) })).status, 413);
  assert.equal((await fetch(`${base}/..%2f..%2f.env`)).status, 404);
});
test('テンプレートAPIで保存・検索・編集・アーカイブ・復元する', async t => {
  const { base, token } = await setup(t); const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': token };
  const input = { name: 'iPhone写真', category: 'camera', body: '自然な日常スナップ。', tags: ['日常'], favorite: true };
  assert.equal((await fetch(`${base}/api/templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  const created = await fetch(`${base}/api/templates`, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(created.status, 201); const template = await created.json();
  const search = await (await fetch(`${base}/api/templates?q=%23日常&category=camera&favorite=1`)).json(); assert.equal(search.templates.length, 1);
  const edited = await (await fetch(`${base}/api/templates/${template.id}`, { method: 'PATCH', headers, body: '{"body":"更新した本文"}' })).json(); assert.equal(edited.body, '更新した本文');
  await fetch(`${base}/api/templates/${template.id}`, { method: 'DELETE', headers }); assert.equal((await (await fetch(`${base}/api/templates`)).json()).templates.length, 0);
  assert.equal((await (await fetch(`${base}/api/templates?archived=1`)).json()).templates.length, 1);
  await fetch(`${base}/api/templates/${template.id}/restore`, { method: 'POST', headers }); assert.equal((await (await fetch(`${base}/api/templates`)).json()).templates.length, 1);
});
test('テンプレートの内容と参照を履歴・再試行に保持し、直接の画像パスを受け付けない', async t => {
  const { base, token, store, templates } = await setup(t); const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': token };
  const template = await templates.create({ name: '白背景', category: 'background', body: '明るい白い背景', tags: [] });
  const source = await store.create({ prompt: 'original', size: 'square', style: 'auto', transparent: false }); await store.update(source.id, { status: 'succeeded', image: { fileName: 'image.png', mime: 'image/png', bytes: 4 } }); await writeFile(join(store.directory, source.id, 'image.png'), Buffer.from([137,80,78,71]));
  const response = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ prompt: '', templateIds: [template.id], references: [{ jobId: source.id, role: 'background' }] }) }); assert.equal(response.status, 202); const job = await response.json();
  assert.equal(job.prompt, '【背景】\n明るい白い背景'); assert.equal(job.basePrompt, ''); assert.equal(job.references[0].jobId, source.id);
  await templates.update(template.id, { body: '後で変更された内容' }); await templates.archive(template.id);
  const retry = await (await fetch(`${base}/api/jobs/${job.id}/retry`, { method: 'POST', headers })).json(); assert.equal(retry.prompt, job.prompt); assert.deepEqual(retry.references, job.references); assert.deepEqual(retry.layers, job.layers);
  const invalid = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'cat', references: [{ path: '/etc/passwd', role: 'overall' }] }) }); assert.equal(invalid.status, 400);
});
test('画像生成を受け付け、履歴とダウンロードを返す', async t => {
  const { base, token, store } = await setup(t);
  const response = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: JSON.stringify({ prompt: 'a cat' }) });
  assert.equal(response.status, 202); const job = await response.json();
  for (let n = 0; n < 100 && ['running', 'queued'].includes(store.get(job.id).status); n++) await sleep(5);
  assert.equal(store.get(job.id).status, 'succeeded');
  const image = await fetch(`${base}/api/jobs/${job.id}/image?download=1`); assert.equal(image.status, 200); assert.match(image.headers.get('content-disposition'), /attachment/);
  const history = await (await fetch(`${base}/api/jobs`)).json(); assert.equal(history.jobs.length, 1); assert.equal(history.jobs[0].image.fileName, undefined);
});
