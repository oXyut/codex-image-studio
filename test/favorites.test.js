import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobStore, JobManager } from '../src/job-store.js';
import { LineageStore } from '../src/lineage-store.js';
import { createApp } from '../src/http-app.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-favorites-'));
  const store = new JobStore(join(directory, 'jobs')); await store.initialize();
  const lineage = new LineageStore(join(directory, 'lineage.json')); await lineage.initialize(store);
  const calls = [];
  const adapter = { health: async () => ({ ready: true }), generate: async job => { calls.push(job.id); return { fileName: 'image.png', mime: 'image/png', bytes: 4 }; } };
  const manager = new JobManager(store, adapter, { lineage });
  const server = createApp({ store, manager, adapter, lineage, publicDirectory: resolve('public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  t.after(async () => { await manager.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const request = (path, method = 'GET', input, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, ...headers },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  const create = async (status = 'succeeded') => {
    const job = await store.create({ prompt: '森の家', basePrompt: '森の家', size: 'square', style: 'auto', transparent: false, layers: [], references: [] });
    await lineage.record(job);
    return store.update(job.id, { status, ...(status === 'succeeded' ? { image: { fileName: 'image.png', mime: 'image/png', bytes: 4 } } : {}) });
  };
  return { store, lineage, calls, request, create };
}

test('完成画像のお気に入りを保存・解除し、入力や系譜・画像を変えず再起動後も保持する', async t => {
  const { store, lineage, calls, request, create } = await setup(t);
  const source = await create(), beforeLineage = structuredClone(lineage.snapshot());
  const response = await request(`/api/jobs/${source.id}/favorite`, 'PATCH', { favorite: true });
  assert.equal(response.status, 200); assert.equal((await response.json()).favorite, true);
  assert.deepEqual(store.get(source.id), { ...source, favorite: true });
  assert.deepEqual(lineage.snapshot(), beforeLineage); assert.deepEqual(calls, []);
  assert.equal((await (await request(`/api/jobs/${source.id}`)).json()).favorite, true);
  assert.equal((await (await request('/api/jobs')).json()).jobs[0].favorite, true);
  const recovered = new JobStore(store.directory); await recovered.initialize();
  assert.deepEqual(recovered.get(source.id), { ...source, favorite: true });
  assert.equal((await request(`/api/jobs/${source.id}/favorite`, 'PATCH', { favorite: true })).status, 200);
  const removed = await request(`/api/jobs/${source.id}/favorite`, 'PATCH', { favorite: false });
  assert.equal(removed.status, 200); assert.equal((await removed.json()).favorite, false);
  assert.deepEqual(JSON.parse(await readFile(join(store.directory, source.id, 'job.json'), 'utf8')), source);
});

test('既存履歴にお気に入りがなくても未登録として返し、新しい画像や再生成へは引き継がない', async t => {
  const { store, request, create } = await setup(t);
  const source = await create();
  const { favorite, ...legacy } = source;
  await store.save(legacy); store.jobs.set(source.id, legacy);
  assert.equal((await (await request('/api/jobs')).json()).jobs[0].favorite, false);
  const recovered = new JobStore(store.directory); await recovered.initialize();
  assert.equal(recovered.get(source.id).favorite ?? false, false);
  await request(`/api/jobs/${source.id}/favorite`, 'PATCH', { favorite: true });
  const retried = await request(`/api/jobs/${source.id}/retry`, 'POST');
  assert.equal(retried.status, 202); const result = await retried.json();
  assert.equal(result.favorite, false); assert.equal(result.prompt, source.prompt);
  assert.equal(store.get(source.id).favorite, true);
  const newJob = await store.create({ prompt: 'new', favorite: true });
  assert.equal(newJob.favorite, false);
});

test('お気に入りの更新にはローカルセッションと真偽値だけを受け付け、未完成・不明な画像を拒否する', async t => {
  const { store, request, create } = await setup(t);
  const source = await create(), path = `/api/jobs/${source.id}/favorite`;
  assert.equal((await request(path, 'PATCH', { favorite: true }, { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await request(path, 'PATCH', { favorite: true }, { Origin: 'https://external.example' })).status, 403);
  for (const input of [null, [], {}, { favorite: 'true' }, { favorite: 1 }, { favorite: null }, { favorite: true, prompt: 'changed' }]) {
    const response = await request(path, 'PATCH', input);
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_FAVORITE');
  }
  assert.deepEqual(store.get(source.id), source);
  for (const status of ['queued', 'running', 'failed', 'cancelled']) {
    const pending = await create(status);
    const response = await request(`/api/jobs/${pending.id}/favorite`, 'PATCH', { favorite: true });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'IMAGE_NOT_READY');
    assert.equal(store.get(pending.id).favorite, false);
  }
  assert.equal((await request(`/api/jobs/${randomUUID()}/favorite`, 'PATCH', { favorite: true })).status, 404);
});

test('ゴミ箱の画像はお気に入りを更新できず、復元と再読み込み後も登録を保持する', async t => {
  const { store, lineage, request, create } = await setup(t);
  const source = await create();
  await request(`/api/jobs/${source.id}/favorite`, 'PATCH', { favorite: true });
  const plan = await (await request(`/api/lineage/nodes/${source.id}/deletion-preview`)).json();
  const deleted = await request(`/api/lineage/nodes/${source.id}`, 'DELETE', { planToken: plan.planToken });
  assert.equal(deleted.status, 200); const deletion = await deleted.json();
  assert.equal((await request(`/api/jobs/${source.id}/favorite`, 'PATCH', { favorite: false })).status, 410);
  assert.deepEqual((await (await request('/api/jobs')).json()).jobs, []);
  assert.equal(store.get(source.id).favorite, true);
  assert.equal((await request(`/api/trash/${deletion.deletionId}/restore`, 'POST')).status, 200);
  assert.equal((await (await request('/api/jobs')).json()).jobs[0].favorite, true);
  const recovered = new JobStore(store.directory); await recovered.initialize();
  assert.equal(recovered.get(source.id).favorite, true); assert.equal(lineage.isVisible(source.id), true);
});

test('保存に失敗してもお気に入りの状態を変えず、後の操作で再保存できる', async t => {
  const { store, request, create } = await setup(t);
  const source = await create(), save = store.save.bind(store);
  store.save = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  assert.equal((await request(`/api/jobs/${source.id}/favorite`, 'PATCH', { favorite: true })).status, 500);
  assert.deepEqual(store.get(source.id), source);
  store.save = save;
  assert.equal((await request(`/api/jobs/${source.id}/favorite`, 'PATCH', { favorite: true })).status, 200);
  assert.equal(store.get(source.id).favorite, true);
});
