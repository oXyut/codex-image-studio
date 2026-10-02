import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { JobStore, JobManager } from '../src/job-store.js';
import { LineageStore } from '../src/lineage-store.js';
import { TemplateStore } from '../src/template-store.js';
import { CodexAdapter } from '../src/codex-adapter.js';
import { createApp } from '../src/http-app.js';
import { prepareGeneration } from '../src/prompt-builder.js';
import { validateInput, validateBatchCount, sizes } from '../src/validation.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7cAAAAASUVORK5CYII=', 'base64');
const fakeBinary = resolve('test/fixtures/fake-codex.mjs');
const waitForAbort = (_, { signal }) => new Promise((resolve, reject) => {
  if (signal.aborted) reject(new Error('cancelled'));
  else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
});

async function setup(t, { generate, http = false, concurrency = 5 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-batch-'));
  const store = new JobStore(join(dir, 'jobs')); await store.initialize();
  const lineage = new LineageStore(join(dir, 'lineage.json')); await lineage.initialize(store);
  const templates = new TemplateStore(join(dir, 'templates.json'), { seed: false }); await templates.initialize();
  const adapter = { health: async () => ({ ready: true }), generate: generate || (async (_, { workspace }) => {
    await writeFile(join(workspace, '..', 'image.png'), png);
    return { fileName: 'image.png', mime: 'image/png', bytes: png.length };
  }) };
  const manager = new JobManager(store, adapter, { lineage, concurrency });
  let server, base, headers;
  if (http) {
    server = createApp({ store, manager, adapter, lineage, templates, publicDirectory: resolve('public') });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const { token } = await (await fetch(`${base}/api/session`)).json();
    headers = { 'Content-Type': 'application/json', 'X-Studio-Token': token };
  }
  t.after(async () => { await manager.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const post = (path, body, overrides = {}) => fetch(`${base}${path}`, { method: 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...overrides });
  const source = async (prompt = '元画像') => {
    const job = await store.create(prepareGeneration({ prompt }, templates, store));
    await store.update(job.id, { status: 'succeeded', image: { fileName: 'image.png', mime: 'image/png', bytes: png.length } });
    await writeFile(join(store.directory, job.id, 'image.png'), png); await lineage.record(store.get(job.id));
    return store.get(job.id);
  };
  return { dir, store, lineage, templates, adapter, manager, base, headers, post, source };
}

test('生成枚数は1〜10の整数だけを受け付け、追加のアスペクト比を検証する', () => {
  for (const count of [1, 5, 10]) assert.equal(validateBatchCount(count), count);
  for (const count of [undefined, null, 0, -1, 11, 1.2, '2', true, NaN]) assert.throws(() => validateBatchCount(count), { code: 'INVALID_BATCH_COUNT' });
  assert.equal(validateInput({ prompt: '海', size: 'widescreen' }).size, 'widescreen');
  assert.equal(validateInput({ prompt: '人物', size: 'vertical' }).size, 'vertical');
  assert.equal(sizes.widescreen, '1600×900'); assert.equal(sizes.vertical, '900×1600');
});

test('全バッチ枠を先に予約し、競合する受付を一部だけ通さない', async t => {
  const app = await setup(t, { generate: waitForAbort });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const create = app.store.create.bind(app.store); let calls = 0;
  app.store.create = async input => { if (++calls === 1) { entered(); await gate; } return create(input); };
  const first = app.manager.enqueueBatch(validateInput({ prompt: '六つの案' }), 6);
  await started;
  assert.equal(app.manager.queue.length, 6);
  await assert.rejects(app.manager.enqueueBatch(validateInput({ prompt: '五つの案' }), 5), { code: 'QUEUE_FULL' });
  assert.equal(calls, 1); release();
  const result = await first; assert.equal(result.jobs.length, 6); assert.equal(app.store.list().length, 6);
  assert.ok(app.manager.queue.length <= 10);
});

test('全入力と系譜を保存するまで一枚も実行しない', async t => {
  let calls = 0;
  const app = await setup(t, { generate: async () => { calls++; return { fileName: 'image.png' }; } });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const record = app.lineage.record.bind(app.lineage); let records = 0;
  app.lineage.record = async (...args) => { if (++records === 3) { entered(); await gate; } return record(...args); };
  const pending = app.manager.enqueueBatch(validateInput({ prompt: '比較用' }), 3);
  await started; assert.equal(app.store.list().length, 3); assert.equal(calls, 0); release();
  const batch = await pending;
  for (let n = 0; n < 100 && app.store.get(batch.jobs[2].id).status !== 'succeeded'; n++) await sleep(5);
  assert.equal(calls, 3);
});

test('保存途中にキャンセルしたバッチメンバーを実行開始へ戻さない', async t => {
  const generated = [];
  const app = await setup(t, { generate: async job => { generated.push(job.id); return { fileName: 'image.png' }; } });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const record = app.lineage.record.bind(app.lineage); let records = 0;
  app.lineage.record = async (...args) => { if (++records === 3) { entered(); await gate; } return record(...args); };
  const pending = app.manager.enqueueBatch(validateInput({ prompt: 'キャンセル比較' }), 3);
  await started;
  const cancelled = app.store.list().find(job => job.batch.index === 1);
  await app.manager.cancel(cancelled.id); release();
  const batch = await pending;
  for (let n = 0; n < 100 && app.store.get(batch.jobs[2].id).status !== 'succeeded'; n++) await sleep(5);
  assert.equal(batch.jobs[0].status, 'cancelled'); assert.equal(app.store.get(cancelled.id).status, 'cancelled');
  assert.ok(!generated.includes(cancelled.id)); assert.equal(generated.length, 2);
});

test('途中のジョブ保存に失敗したバッチを実行せず、予約枠を戻す', async t => {
  let calls = 0;
  const app = await setup(t, { generate: async () => { calls++; return {}; } });
  const create = app.store.create.bind(app.store); let saves = 0;
  app.store.create = input => ++saves === 2 ? Promise.reject(new Error('disk full')) : create(input);
  await assert.rejects(app.manager.enqueueBatch(validateInput({ prompt: '失敗させる' }), 3), /disk full/);
  assert.equal(calls, 0); assert.equal(app.manager.queue.length, 0);
  assert.equal(app.store.list()[0].status, 'failed'); assert.equal(app.store.list()[0].error.code, 'BATCH_SAVE_FAILED');
});

test('途中の系譜保存に失敗しても全バッチを停止し、再起動で兄弟関係を復元する', async t => {
  let calls = 0;
  const app = await setup(t, { generate: async () => { calls++; return {}; } });
  const source = await app.source(); const record = app.lineage.record.bind(app.lineage); let records = 0;
  app.lineage.record = (...args) => ++records === 2 ? Promise.reject(new Error('ledger failure')) : record(...args);
  const input = prepareGeneration({ prompt: '別案', references: [{ jobId: source.id, role: 'overall' }] }, app.templates, app.store);
  await assert.rejects(app.manager.enqueueBatch(input, 3), /ledger failure/);
  const jobs = app.store.list().filter(job => job.batch);
  assert.equal(calls, 0); assert.equal(app.manager.queue.length, 0); assert.equal(jobs.length, 3);
  assert.ok(jobs.every(job => job.status === 'failed' && job.error.code === 'BATCH_SAVE_FAILED'));
  const recovered = new LineageStore(join(app.dir, 'lineage.json')); await recovered.initialize(app.store);
  assert.equal(new Set(jobs.map(job => recovered.get(job.id).branchId)).size, 3);
  assert.ok(jobs.every(job => recovered.get(job.id).sourceJobId === source.id));
});

test('保存中の停止ではバッチを開始せず、未確定の予約が残らない', async t => {
  let calls = 0;
  const app = await setup(t, { generate: async () => { calls++; return {}; } });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const create = app.store.create.bind(app.store);
  app.store.create = async input => { entered(); await gate; return create(input); };
  const pending = app.manager.enqueueBatch(validateInput({ prompt: '停止' }), 2);
  await started; await app.manager.close(); release();
  await assert.rejects(pending, { code: 'SHUTTING_DOWN' });
  assert.equal(calls, 0); assert.equal(app.manager.queue.length, 0);
  assert.ok(app.store.list().every(job => job.status === 'failed'));
});

test('派生バッチの各案は同じ参照・プロンプトで別々の枝を持つ', async t => {
  const app = await setup(t, { http: true, generate: waitForAbort }); const source = await app.source();
  const template = await app.templates.create({ name: '白背景', category: 'background', body: '白い背景', tags: [] });
  const response = await app.post('/api/batches', { prompt: '青いカップ', templateIds: [template.id], references: [{ jobId: source.id, role: 'overall' }], count: 3, size: 'widescreen', batch: { id: 'forged' } });
  assert.equal(response.status, 202); const batch = await response.json(); assert.equal(batch.jobs.length, 3);
  assert.equal(new Set(batch.jobs.map(job => job.lineage.branchId)).size, 3);
  for (const [index, job] of batch.jobs.entries()) {
    assert.deepEqual(job.batch, { id: batch.batchId, index: index + 1, count: 3 });
    assert.deepEqual(job.references, [{ jobId: source.id, role: 'overall' }]);
    assert.deepEqual(job.lineage.parentIds, [source.id]); assert.equal(job.lineage.sourceJobId, source.id);
    assert.equal(job.lineage.operation, 'derive'); assert.equal(job.lineageIntent, undefined);
    assert.equal(job.prompt, batch.jobs[0].prompt); assert.deepEqual(job.layers, batch.jobs[0].layers);
  }
  await app.templates.update(template.id, { body: 'あとから変更' });
  assert.ok(batch.jobs.every(job => job.layers[0].body === '白い背景'));
  assert.equal(app.lineage.get(source.id).branchId, app.lineage.snapshot().branches.find(branch => branch.headJobId === source.id).id);
});

test('一枚のバッチは従来どおり最新ノードの枝を継続する', async t => {
  const app = await setup(t, { http: true, generate: waitForAbort }); const source = await app.source();
  const response = await app.post('/api/batches', { prompt: '一案', references: [{ jobId: source.id, role: 'overall' }], count: 1 });
  assert.equal(response.status, 202); const { jobs } = await response.json();
  assert.equal(jobs[0].lineage.branchId, app.lineage.get(source.id).branchId); assert.equal(jobs[0].batch.count, 1);
});

test('複数枚再生成は生成時のテンプレート版と入力を保持し、元画像を参照に追加しない', async t => {
  const app = await setup(t, { http: true, generate: waitForAbort }); const reference = await app.source();
  const template = await app.templates.create({ name: '壁', category: 'background', body: '白い壁', tags: ['室内'] });
  const response = await app.post('/api/jobs', { prompt: 'カップ', templateIds: [template.id], references: [{ jobId: reference.id, role: 'background' }], size: 'vertical', style: 'photo' });
  assert.equal(response.status, 202); const original = await response.json();
  await app.templates.update(template.id, { body: '黒い壁' }); await app.templates.archive(template.id);
  const retry = await app.post(`/api/jobs/${original.id}/retry-batch`, { count: 3 });
  assert.equal(retry.status, 202); const batch = await retry.json();
  assert.equal(new Set(batch.jobs.map(job => job.lineage.branchId)).size, 3);
  for (const job of batch.jobs) {
    assert.equal(job.prompt, original.prompt); assert.equal(job.basePrompt, original.basePrompt);
    assert.deepEqual(job.layers, original.layers); assert.deepEqual(job.references, original.references);
    assert.equal(job.size, 'vertical'); assert.equal(job.style, 'photo');
    assert.deepEqual(job.lineage.parentIds, [reference.id]); assert.equal(job.lineage.sourceJobId, original.id); assert.equal(job.lineage.operation, 'regenerate');
    assert.ok(!job.references.some(reference => reference.jobId === original.id));
  }
});

test('バッチAPIは不正な枚数・改変した再生成・外部サイトの要求を拒否する', async t => {
  const app = await setup(t, { http: true, generate: waitForAbort }); const source = await app.source();
  for (const count of [undefined, null, 0, 11, 1.5, '3', true]) {
    const response = await app.post('/api/batches', { prompt: '画像', count }); assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_BATCH_COUNT');
  }
  assert.equal((await app.post('/api/batches', { prompt: '画像', count: 2 }, { headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await app.post('/api/batches', { prompt: '画像', count: 2 }, { headers: { ...app.headers, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await app.post(`/api/jobs/${source.id}/retry-batch`, { count: 2, prompt: '改変' })).status, 400);
  assert.equal((await app.post(`/api/jobs/${source.id}/retry-batch`, { count: 0 })).status, 400);
  assert.equal(app.store.list().length, 1);
});

test('十枚まとめて受付でき、十一枚目の待機は拒否する', async t => {
  const app = await setup(t, { http: true, generate: waitForAbort, concurrency: 1 });
  const first = await app.post('/api/batches', { prompt: '十案', count: 10 }); assert.equal(first.status, 202);
  const batch = await first.json(); assert.equal(batch.jobs.length, 10);
  const extra = await app.post('/api/batches', { prompt: '追加二案', count: 2 }); assert.equal(extra.status, 429);
  assert.equal((await extra.json()).error.code, 'QUEUE_FULL'); assert.equal(app.store.list().length, 10);
});

test('並列実行枠と待機十件を別に数え、待機の追加バッチは全件まとめて受け付ける', async t => {
  const app = await setup(t, { http: true, generate: waitForAbort });
  const first = await app.post('/api/batches', { prompt: '十案', count: 10 }); assert.equal(first.status, 202);
  const batch = await first.json();
  for (let n = 0; n < 100 && app.store.list().filter(job => job.status === 'running').length < 5; n++) await sleep(5);
  assert.equal(app.manager.active.size, 5); assert.equal(app.manager.queue.length, 5);
  const second = await app.post('/api/batches', { prompt: 'さらに五案', count: 5 }); assert.equal(second.status, 202);
  const waiting = await second.json(); assert.equal(waiting.jobs.length, 5);
  assert.ok(waiting.jobs.every(job => job.status === 'queued'));
  assert.equal(app.manager.active.size, 5); assert.equal(app.manager.queue.length, 10);
  const rejected = await app.post('/api/batches', { prompt: '上限を超える一案', count: 1 }); assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).error.code, 'QUEUE_FULL'); assert.equal(app.store.list().length, 15);
  assert.equal(new Set(batch.jobs.map(job => job.batch.id)).size, 1);
  assert.notEqual(batch.batchId, waiting.batchId);
});

test('16:9と9:16を寸法と比率の両方でCodexに伝える', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-ratio-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const original = join(dir, 'reference.png'); await writeFile(original, png);
  for (const [size, ratio, dimensions] of [['widescreen', '16:9', '1600×900'], ['vertical', '9:16', '900×1600']]) {
    const workspace = join(dir, size, 'workspace');
    await new CodexAdapter({ binary: fakeBinary }).generate(validateInput({ prompt: 'REFERENCE_TOOL_CHECK', size }), { workspace, referenceImages: [{ path: original, role: 'overall' }] });
    const captured = JSON.parse(await readFile(join(workspace, 'captured-turn.json'), 'utf8'));
    assert.ok(captured.input[0].text.includes(`Requested dimensions: ${dimensions}`));
    assert.ok(captured.input[0].text.includes(`Requested aspect ratio: ${ratio}`));
  }
});
