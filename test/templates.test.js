import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TemplateStore, validateTemplate } from '../src/template-store.js';
import { prepareGeneration } from '../src/prompt-builder.js';
import { composePrompt } from '../public/prompt-utils.js';

async function setup(t) { const dir = await mkdtemp(join(tmpdir(), 'studio-templates-')); t.after(() => rm(dir, { recursive: true, force: true })); const store = new TemplateStore(join(dir, 'templates.json'), { seed: false }); await store.initialize(); return store; }
const input = { name: 'iPhoneの日常', body: '自然光のスナップ写真', category: 'camera', tags: ['#日常', '日常'], favorite: true };
test('テンプレートを検証し、タグを整える', () => {
  assert.deepEqual(validateTemplate(input).tags, ['日常']);
  for (const change of [{ name: '' }, { body: 'x'.repeat(2001) }, { category: '__proto__' }, { tags: ['x'.repeat(41)] }, { favorite: 'yes' }]) assert.throws(() => validateTemplate({ ...input, ...change }));
});
test('分類・タグ・複数語・全角表記で検索し、お気に入りで絞る', async t => {
  const store = await setup(t); const item = await store.create(input); await store.create({ ...input, name: '別の背景', category: 'background', tags: ['公園'], favorite: false });
  assert.equal(store.list({ query: 'ｉＰｈｏｎｅ #日常', category: 'camera', favorite: true })[0].id, item.id);
  assert.equal(store.list({ query: '公園', category: 'background' }).length, 1); assert.equal(store.list({ query: '存在しない' }).length, 0);
});
test('同時保存・編集・アーカイブ・復元を再起動後も保持する', async t => {
  const store = await setup(t); const saved = await Promise.all(Array.from({ length: 12 }, (_, index) => store.create({ ...input, name: `要素${index}` })));
  await store.update(saved[0].id, { name: '更新された要素', body: '変更後' }); await store.archive(saved[0].id);
  const loaded = new TemplateStore(store.path); await loaded.initialize(); assert.equal(loaded.all().length, 12); assert.equal(loaded.list().length, 11); assert.equal(loaded.list({ archived: true })[0].name, '更新された要素');
  await loaded.archive(saved[0].id, true); assert.equal(loaded.list().length, 12);
});
test('要素を順序通り合成し、後から編集されたテンプレートの影響を受けない', async t => {
  const store = await setup(t); const first = await store.create(input); const second = await store.create({ ...input, name: '服装', body: '白いシャツ', category: 'clothing' }); const jobs = { get: () => { throw new Error('No reference'); } };
  const result = prepareGeneration({ prompt: '人物', templateIds: [second.id, first.id] }, store, jobs);
  assert.equal(result.prompt, '人物\n\n【服装】\n白いシャツ\n\n【撮影】\n自然光のスナップ写真');
  await store.update(first.id, { body: '新しい本文' }); await store.archive(second.id);
  const reused = prepareGeneration({ ...result, prompt: result.basePrompt }, store, jobs); assert.equal(reused.prompt, result.prompt);
  assert.equal(composePrompt('', [second]), '【服装】\n白いシャツ'); assert.equal(prepareGeneration({ prompt: '', layers: [second] }, store, jobs).basePrompt, '');
  assert.throws(() => prepareGeneration({ prompt: 'cat', layers: [first, first] }, store, jobs), { code: 'DUPLICATE_LAYER' });
  assert.throws(() => prepareGeneration({ prompt: 'x'.repeat(4000), layers: Array.from({ length: 6 }, () => ({ ...first, id: randomUUID(), body: 'x'.repeat(2000) })) }, store, jobs), { code: 'PROMPT_TOO_LONG' });
});
test('参照は完成した画像だけで、役割・重複・枚数を検証する', () => {
  const id = randomUUID(); const jobs = { get: () => ({ id, status: 'succeeded', image: { fileName: 'image.png' } }) }; const ref = { jobId: id, role: 'face' };
  assert.deepEqual(prepareGeneration({ prompt: 'portrait', references: [ref] }, null, jobs).references, [ref]);
  assert.throws(() => prepareGeneration({ prompt: 'cat', references: [ref, ref] }, null, jobs), { code: 'DUPLICATE_REFERENCE' });
  assert.throws(() => prepareGeneration({ prompt: 'cat', references: [{ ...ref, role: 'arbitrary' }] }, null, jobs), { code: 'INVALID_REFERENCES' });
  assert.throws(() => prepareGeneration({ prompt: 'cat', references: [ref] }, null, { get: () => ({ id, status: 'failed' }) }), { code: 'INVALID_REFERENCE_IMAGE' });
  assert.throws(() => prepareGeneration({ prompt: 'cat', references: [ref] }, null, { get: () => ({ id, status: 'succeeded', image: { fileName: '../../secret.png' } }) }), { code: 'INVALID_REFERENCE_IMAGE' });
});
