import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { GenerationInput, GenerationOptions, Generator, Job } from '../shared/types.js';
import { CodexAdapter } from '../src/codex-adapter.js';
import { generationError } from '../src/generation-errors.js';
import type { ManagerOptions } from '../src/job-store.js';
import { JobManager, JobStore } from '../src/job-store.js';
import { validateInput } from '../src/validation.js';

test('内容・利用枠・認証・通信・状態不明を区別する', () => {
  assert.equal(generationError('{"error":{"code":"content_policy_violation","message":"Rejected"}}').category, 'content');
  assert.equal(generationError({ type: 'usageLimitExceeded' }).category, 'usage');
  assert.equal(generationError(new Error('authentication token expired')).category, 'auth');
  assert.equal(generationError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).retryable, true);
  assert.equal(generationError({ message: 'backend error', httpStatusCode: 503 }).retryable, true);
  assert.equal(generationError(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })).retryable, false);
});
async function setup(t: test.TestContext, generate: Generator['generate'], options: ManagerOptions = {}) { const dir = await mkdtemp(join(tmpdir(), 'studio-fallback-')); const store = new JobStore(dir); await store.initialize(); const manager = new JobManager(store, { generate }, { retryDelayMs: 1, ...options }); t.after(async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); }); return { store, manager }; }
async function finish(store: JobStore, id: string) { for (let n = 0; n < 1000 && ['queued', 'running'].includes(store.get(id).status); n++) await delay(5); return store.get(id); }
test('一時的な失敗は、同じ入力を1回だけ自動で再試行する', async t => {
  const calls: GenerationInput[] = []; const { store, manager } = await setup(t, async input => { calls.push(structuredClone(input)); if (calls.length === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); return { fileName: 'image.png' }; });
  const input = { ...validateInput({ prompt: 'same intent' }), basePrompt: 'same intent', layers: [], references: [] }; const job = await manager.enqueue(input); const result = await finish(store, job.id);
  assert.equal(result.status, 'succeeded'); assert.equal(result.attempts, 2); assert.equal(calls.length, 2); for (const key of ['prompt', 'basePrompt', 'layers', 'references', 'size', 'style', 'transparent'] as const) assert.deepEqual(calls[0][key], calls[1][key]);
});
test('内容判定では同じ文章・要素・参照・設定で3回再試行し、拒否が続けば停止する', async t => {
  const calls: { input: Job; referenceImages: GenerationOptions["referenceImages"] }[] = []; const { store, manager } = await setup(t, async (input, { referenceImages }) => {
    calls.push({ input: structuredClone(input), referenceImages: structuredClone(referenceImages) });
    throw generationError({ code: 'content_policy_violation', message: 'Rejected' });
  });
  const reference = await store.create(validateInput({ prompt: 'reference' }));
  const referencePath = join(store.directory, reference.id, 'image.png');
  await writeFile(referencePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7cAAAAASUVORK5CYII=', 'base64'));
  await store.update(reference.id, { status: 'succeeded', image: { fileName: 'image.png' } });
  const input = { ...validateInput({ prompt: 'original description', size: 'portrait', style: 'photo', transparent: true }),
    basePrompt: 'original base', layers: [{ id: 'test-layer', name: 'layer', body: 'original layer', category: 'other', tags: [], favorite: false }], references: [{ jobId: reference.id, role: 'overall' }] };
  const job = await manager.enqueue(input); const result = await finish(store, job.id);
  assert.equal(calls.length, 4); assert.equal(result.attempts, 4); assert.equal(result.status, 'failed');
  assert.equal(result.error!.category, 'content'); assert.equal(result.error!.retryable, true); assert.match(result.error!.details!, /Rejected/);
  for (const [index, call] of calls.entries()) {
    for (const key of ['prompt', 'basePrompt', 'layers', 'references', 'size', 'style', 'transparent'] as const) assert.deepEqual(call.input[key], input[key]);
    assert.deepEqual(call.referenceImages, [{ ...input.references[0], path: referencePath }]);
    if (index) assert.ok(call.input.message.includes(`${index}/3回目`));
  }
  const persisted = JSON.parse(await readFile(join(store.directory, job.id, 'job.json'), 'utf8'));
  assert.equal(persisted.attempts, 4); assert.deepEqual(persisted.error, result.error);
});
test('内容拒否の3回目の再試行で成功したら、追加生成をせず完了する', async t => {
  let calls = 0; const { store, manager } = await setup(t, async () => {
    if (++calls <= 3) throw generationError({ code: 'content_policy_violation', message: 'Rejected' });
    return { fileName: 'image.png' };
  });
  const job = await manager.enqueue(validateInput({ prompt: 'cat' })); const result = await finish(store, job.id);
  assert.equal(calls, 4); assert.equal(result.attempts, 4); assert.equal(result.status, 'succeeded'); assert.equal(result.error, null);
});
test('内容拒否の後でも、利用枠・認証・タイムアウト・結果不明なら再試行を止める', async t => {
  for (const failure of [generationError({ type: 'usageLimitExceeded' }), generationError({ code: 'unauthorized' }),
    generationError(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
    Object.assign(generationError({ code: 'content_policy_violation' }), { autoRetryAllowed: false })]) {
    let calls = 0; const { store, manager } = await setup(t, async () => {
      if (++calls === 1) throw generationError({ code: 'content_policy_violation' });
      throw failure;
    });
    const job = await manager.enqueue(validateInput({ prompt: 'cat' })); const result = await finish(store, job.id);
    assert.equal(calls, 2); assert.equal(result.attempts, 2); assert.equal(result.status, 'failed'); assert.equal(result.error!.category, failure.category);
  }
});
test('内容拒否と一時障害が混在しても、既存の一時障害の上限と全体4回を守る', async t => {
  for (const categories of [['content', 'transient'], ['transient', 'content', 'content', 'content']]) {
    let calls = 0; const { store, manager } = await setup(t, async () => {
      const category = categories[Math.min(calls++, categories.length - 1)];
      throw generationError({ code: category === 'content' ? 'content_policy_violation' : 'internal_server_error' });
    });
    const job = await manager.enqueue(validateInput({ prompt: 'cat' })); const result = await finish(store, job.id);
    assert.equal(calls, categories.length); assert.equal(result.attempts, categories.length); assert.equal(result.status, 'failed');
  }
});
test('連続する一時障害でも2回で停止し、状態不明なら再生成しない', async t => {
  let calls = 0; const { store, manager } = await setup(t, async () => { calls++; throw generationError({ code: 'internal_server_error', message: 'temporary' }); });
  const job = await manager.enqueue(validateInput({ prompt: 'cat' })); const result = await finish(store, job.id); assert.equal(calls, 2); assert.equal(result.status, 'failed');
  let ambiguousCalls = 0; const other = await setup(t, async () => { ambiguousCalls++; throw Object.assign(generationError({ code: 'CLI_DISCONNECTED' }), { autoRetryAllowed: false }); }); const second = await other.manager.enqueue(validateInput({ prompt: 'cat' })); await finish(other.store, second.id); assert.equal(ambiguousCalls, 1);
});
test('再試行の待機中にもキャンセルできる', async t => {
  for (const failure of [generationError('temporarily unavailable'), generationError({ code: 'content_policy_violation' })]) {
    let calls = 0; const { store, manager } = await setup(t, async () => { calls++; throw failure; }, { retryDelayMs: 1000 }); const job = await manager.enqueue(validateInput({ prompt: 'cat' }));
    for (let n = 0; n < 100 && !store.get(job.id).message.includes('再試行'); n++) await delay(5);
    assert.ok(store.get(job.id).message.includes('再試行'));
    await manager.cancel(job.id); assert.equal((await finish(store, job.id)).status, 'cancelled'); assert.equal(calls, 1);
  }
});

test('公式CLI形式の内容拒否と最終説明による拒否を、初回を含め4回で停止する', async t => {
  const adapter = new CodexAdapter({ binary: resolve('dist/test/fixtures/fake-codex.js') });
  const { store, manager } = await setup(t, adapter.generate.bind(adapter));
  for (const prompt of ['CONTENT_FAILURE', 'EMPTY_TOOL_CONTENT_COMPLETED', 'EMPTY_TOOL_JAPANESE_CONTENT']) {
    const job = await manager.enqueue(validateInput({ prompt })); const result = await finish(store, job.id);
    assert.equal(result.status, 'failed', prompt); assert.equal(result.attempts, 4, prompt);
    assert.equal(result.error!.category, 'content', prompt); assert.equal(result.prompt, prompt);
  }
});

test('4件の同時失敗でも具体的な理由を保存し、入力変更や重複再試行をしない', async t => {
  const adapter = new CodexAdapter({ binary: resolve('dist/test/fixtures/fake-codex.js') });
  const { store, manager } = await setup(t, adapter.generate.bind(adapter), { concurrency: 4 });
  const input = validateInput({ prompt: 'EMPTY_TOOL_ITEMS_ONLY', size: 'auto' });
  const batch = await manager.enqueueBatch(input, 4);
  for (const job of batch.jobs) {
    const result = await finish(store, job.id);
    assert.equal(result.status, 'failed'); assert.equal(result.attempts, 1); assert.equal(result.prompt, input.prompt); assert.equal(result.size, 'auto');
    assert.match(result.error!.details!, /diagnostic-42/); assert.doesNotMatch(result.error!.details!, /private-token|private-key/);
    const persisted = JSON.parse(await readFile(join(store.directory, job.id, 'job.json'), 'utf8'));
    assert.deepEqual(persisted.error, result.error);
  }
});
