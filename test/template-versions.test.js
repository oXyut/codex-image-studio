import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TemplateStore } from '../src/template-store.js';
import { prepareGeneration } from '../src/prompt-builder.js';
import { createApp } from '../src/http-app.js';

const initial = { name: '白い背景', body: '白い漆喰の壁', category: 'background', tags: ['白', '自然光'], favorite: false };
async function setup(t, legacy) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-template-versions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'templates.json');
  if (legacy) await writeFile(path, JSON.stringify({ version: 1, templates: legacy }));
  const store = new TemplateStore(path, { seed: false }); await store.initialize(); return store;
}

test('旧テンプレートの内容・ID・日付・archive状態を保持して一度だけ初版に移行する', async t => {
  const legacy = [
    { id: randomUUID(), ...initial, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', archivedAt: null },
    { id: randomUUID(), ...initial, name: '保存済み', favorite: true, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z', archivedAt: '2026-02-02T00:00:00.000Z' },
  ];
  const store = await setup(t, legacy);
  assert.deepEqual(store.all(), legacy.map(item => ({ ...item, version: 1 })));
  for (const item of legacy) { const versions = store.versions(item.id).versions; assert.equal(versions.length, 1); assert.equal(versions[0].createdAt, item.createdAt); assert.equal(versions[0].archivedAt, item.archivedAt); }
  const first = await readFile(store.path, 'utf8'); assert.equal(JSON.parse(first).version, 2);
  const reloaded = new TemplateStore(store.path, { seed: false }); await reloaded.initialize();
  assert.equal(await readFile(store.path, 'utf8'), first); assert.deepEqual(reloaded.all(), store.all());
});

test('変更履歴を増やし、revertで履歴を消さず管理fieldsを新しい版に復元する', async t => {
  const store = await setup(t); const created = await store.create(initial);
  const edited = await store.update(created.id, { name: '暗い背景', body: '暗い壁', category: 'style', tags: ['夜'], favorite: true, expectedVersion: 1 });
  assert.equal(edited.version, 2);
  const archived = await store.archive(created.id, false, { expectedVersion: 2 }); assert.equal(archived.version, 3);
  const unarchived = await store.archive(created.id, true, { expectedVersion: 3 }); assert.equal(unarchived.version, 4);
  const reverted = await store.revert(created.id, { version: 1, expectedVersion: 4 });
  assert.equal(reverted.version, 5); assert.equal(reverted.createdAt, created.createdAt);
  for (const key of Object.keys(initial)) assert.deepEqual(reverted[key], initial[key]);
  assert.equal(reverted.archivedAt, null);
  let versions = store.versions(created.id).versions;
  assert.deepEqual(versions.map(item => item.version), [5, 4, 3, 2, 1]);
  assert.deepEqual(versions.map(item => item.operation), ['revert', 'unarchive', 'archive', 'update', 'create']);
  assert.equal(versions[0].revertedFrom, 1); assert.equal(versions[2].body, '暗い壁');
  const archivedRevert = await store.revert(created.id, { version: 3, expectedVersion: 5 });
  assert.equal(archivedRevert.version, 6); assert.equal(archivedRevert.archivedAt, archived.archivedAt); assert.equal(store.list().length, 0);
  const reloaded = new TemplateStore(store.path, { seed: false }); await reloaded.initialize();
  assert.deepEqual(reloaded.get(created.id), archivedRevert); assert.deepEqual(reloaded.versions(created.id), store.versions(created.id));
});

test('意味が変わらない更新とarchive状態の再指定で版を増やさない', async t => {
  const store = await setup(t); const created = await store.create(initial);
  for (const change of [{}, { body: ` ${initial.body} ` }, { favorite: false }, { tags: ['#白', '白', '自然光'] }, { tags: ['自然光', '白'] }, { version: 999, expectedVersion: 1 }]) assert.deepEqual(await store.update(created.id, change), created);
  assert.deepEqual(await store.archive(created.id, true), created);
  const archived = await store.archive(created.id); assert.deepEqual(await store.archive(created.id), archived);
  assert.equal(store.versions(created.id).versions.length, 2);
});

test('楽観ロックはserialtransaction内で競合を検出し、古い編集・restore・revertを拒否する', async t => {
  const store = await setup(t); const created = await store.create(initial);
  const operations = await Promise.allSettled([
    store.update(created.id, { body: '変更A', expectedVersion: 1 }),
    store.update(created.id, { body: '変更B', expectedVersion: 1 }),
  ]);
  assert.equal(operations[0].status, 'fulfilled'); assert.equal(operations[1].reason.status, 409); assert.equal(operations[1].reason.code, 'VERSION_CONFLICT');
  for (const action of [() => store.update(created.id, { expectedVersion: 1 }), () => store.archive(created.id, false, { expectedVersion: 1 }), () => store.archive(created.id, true, { expectedVersion: 1 }), () => store.revert(created.id, { version: 1, expectedVersion: 1 })]) await assert.rejects(action, { code: 'VERSION_CONFLICT', status: 409 });
  assert.equal(store.versions(created.id).versions.length, 2);
  assert.equal(store.get(created.id).body, '変更A');
});

test('公開した配列・snapshotを変更しても保存済み現行版と過去版が変更されない', async t => {
  const store = await setup(t); const created = await store.create(initial);
  created.body = '外部の変更'; created.tags.push('外部');
  const current = store.get(created.id), all = store.all(), listed = store.list(), history = store.versions(created.id), version = store.getVersion(created.id, 1);
  current.tags.push('get'); all[0].body = 'all'; listed[0].tags.push('list'); history.versions[0].body = 'history'; version.tags.push('version');
  assert.equal(store.get(created.id).body, initial.body); assert.deepEqual(store.get(created.id).tags, initial.tags); assert.equal(store.getVersion(created.id, 1).body, initial.body); assert.deepEqual(store.getVersion(created.id, 1).tags, initial.tags);
});

test('不正な版指定と存在しない過去版を検証し、管理versionを任意に上書きできない', async t => {
  const store = await setup(t); const created = await store.create({ ...initial, version: 90 }); assert.equal(created.version, 1);
  for (const invalid of [0, -1, 1.5, '1', null]) {
    assert.throws(() => store.update(created.id, { expectedVersion: invalid }), { code: 'INVALID_TEMPLATE_VERSION', status: 400 });
    assert.throws(() => store.revert(created.id, { version: invalid }), { code: 'INVALID_TEMPLATE_VERSION', status: 400 });
  }
  await assert.rejects(store.revert(created.id, { version: 88 }), { code: 'TEMPLATE_VERSION_NOT_FOUND', status: 404 });
  assert.throws(() => store.update(created.id, null), { code: 'INVALID_TEMPLATE', status: 400 });
  const updated = await store.update(created.id, { body: '変更', version: 99 }); assert.equal(updated.version, 2);
  assert.equal(store.versions(created.id).versions.length, 2);
});

test('生成入力は選択版をsnapshotに残し、旧versionなし入力と過去版再生成を同じまま保持する', async t => {
  const store = await setup(t); const created = await store.create(initial); const jobs = { get() { throw new Error('unused'); } };
  const generated = prepareGeneration({ prompt: '人物', templateIds: [created.id] }, store, jobs);
  assert.equal(generated.layers[0].version, 1);
  await store.update(created.id, { body: '後から変更' }); await store.archive(created.id); await store.revert(created.id, { version: 1 });
  const retried = prepareGeneration({ ...generated, prompt: generated.basePrompt }, store, jobs); assert.deepEqual(retried.layers, generated.layers); assert.equal(retried.prompt, generated.prompt);
  const { version, ...oldLayer } = generated.layers[0];
  const legacy = prepareGeneration({ prompt: '人物', layers: [oldLayer] }, store, jobs); assert.equal(Object.hasOwn(legacy.layers[0], 'version'), false);
  assert.deepEqual(prepareGeneration({ ...legacy, prompt: legacy.basePrompt }, store, jobs).layers, legacy.layers);
  const selectedOldVersion = store.getVersion(created.id, 1); assert.equal(prepareGeneration({ prompt: '人物', layers: [selectedOldVersion] }, store, jobs).layers[0].version, 1);
  for (const version of [0, -1, 1.5, '1']) assert.throws(() => prepareGeneration({ prompt: '人物', layers: [{ ...oldLayer, version }] }, store, jobs), { code: 'INVALID_TEMPLATE_VERSION', status: 400 });
});

test('版を名乗る生成snapshotは保存履歴と照合し、偽造を拒否して本当の過去版を許可する', async t => {
  const store = await setup(t); const created = await store.create(initial); const jobs = { get() { throw new Error('unused'); } };
  await store.update(created.id, { body: '更新した壁', name: '新しい名前', category: 'style', tags: ['新規'], favorite: true });
  await store.archive(created.id);
  const past = store.getVersion(created.id, 1), archived = store.getVersion(created.id, 3);
  assert.equal(prepareGeneration({ prompt: '人物', layers: [past] }, store, jobs).layers[0].version, 1);
  assert.equal(prepareGeneration({ prompt: '人物', layers: [archived] }, store, jobs).layers[0].version, 3);
  for (const patch of [{ body: '別の内容' }, { name: '偽名' }, { category: 'color' }, { tags: ['別のタグ'] }, { favorite: true }]) assert.throws(() => prepareGeneration({ prompt: '人物', layers: [{ ...past, ...patch }] }, store, jobs), { code: 'TEMPLATE_VERSION_MISMATCH', status: 400 });
  assert.throws(() => prepareGeneration({ prompt: '人物', layers: [{ ...past, version: 900 }] }, store, jobs), { code: 'TEMPLATE_VERSION_NOT_FOUND', status: 404 });
  assert.throws(() => prepareGeneration({ prompt: '人物', layers: [{ ...past, id: randomUUID() }] }, store, jobs), { code: 'TEMPLATE_NOT_FOUND', status: 404 });
  const { version, ...legacy } = past;
  const unversioned = prepareGeneration({ prompt: '人物', layers: [{ ...legacy, body: '旧形式のsnapshot' }] }, store, jobs);
  assert.equal(unversioned.layers[0].body, '旧形式のsnapshot'); assert.equal(Object.hasOwn(unversioned.layers[0], 'version'), false);
  const reordered = prepareGeneration({ prompt: '人物', layers: [{ ...past, tags: [...past.tags].reverse() }] }, store, jobs);
  assert.equal(reordered.layers[0].version, 1);
});

async function setupHttp(t) {
  const templates = await setup(t);
  const server = createApp({ store: { list: () => [] }, manager: {}, adapter: {}, templates, publicDirectory: resolve('public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const request = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { request, templates };
}

test('HTTPの履歴・復元・archiveがcurrent versionとsnapshotを公開し、競合409を返す', async t => {
  const { request } = await setupHttp(t);
  const created = await (await request('/api/templates', 'POST', initial)).json(); assert.equal(created.version, 1);
  const path = `/api/templates/${created.id}`;
  const changed = await request(path, 'PATCH', { body: '夜の壁', expectedVersion: 1 }); assert.equal(changed.status, 200); assert.equal((await changed.json()).version, 2);
  const archived = await request(path, 'DELETE', { expectedVersion: 2 }); assert.equal(archived.status, 200); assert.equal((await archived.json()).version, 3);
  assert.equal((await request(`${path}/restore`, 'POST', { expectedVersion: 2 })).status, 409);
  assert.equal((await request(`${path}/restore`, 'POST', { expectedVersion: 3 })).status, 200);
  const history = await (await request(`${path}/versions`)).json(); assert.equal(history.templateId, created.id); assert.deepEqual(history.versions.map(item => item.version), [4, 3, 2, 1]); assert.equal(history.versions[1].body, '夜の壁');
  const reverted = await request(`${path}/revert`, 'POST', { version: 1, expectedVersion: 4 }); assert.equal(reverted.status, 200);
  const current = await reverted.json(); assert.equal(current.version, 5); assert.equal(current.body, initial.body);
  const stale = await request(path, 'PATCH', { favorite: true, expectedVersion: 4 }); assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'VERSION_CONFLICT');
  assert.equal((await request(`${path}/revert`, 'POST', { version: 2, expectedVersion: 4 })).status, 409);
  const after = await (await request(`${path}/versions`)).json(); assert.equal(after.versions.length, 5); assert.equal(after.versions[0].operation, 'revert'); assert.equal(after.versions[0].revertedFrom, 1);
});

test('HTTPの履歴・復元にもorigin/session保護とversion検証が適用される', async t => {
  const { request, templates } = await setupHttp(t); const created = await templates.create(initial); const path = `/api/templates/${created.id}`;
  assert.equal((await request(`${path}/versions`, 'GET', undefined, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await request(`${path}/revert`, 'POST', { version: 1 }, { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await request(`${path}/revert`, 'POST', { version: 1 }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await request(`${path}/revert`, 'POST', { version: '1' })).status, 400);
  assert.equal((await request(`${path}/revert`, 'POST', { version: 900 })).status, 404);
  assert.equal((await request(`/api/templates/${randomUUID()}/versions`)).status, 404);
  assert.equal(templates.versions(created.id).versions.length, 1);
});
