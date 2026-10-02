import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { generationError } from '../src/generation-errors.js';
import { JobStore, JobManager } from '../src/job-store.js';
import { validateInput } from '../src/validation.js';
import { CodexAdapter } from '../src/codex-adapter.js';

test('内容・利用枠・認証・通信・状態不明を区別する', () => {
  assert.equal(generationError('{"error":{"code":"content_policy_violation","message":"Rejected"}}').category, 'content');
  assert.equal(generationError({ type: 'usageLimitExceeded' }).category, 'usage');
  assert.equal(generationError(new Error('authentication token expired')).category, 'auth');
  assert.equal(generationError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).retryable, true);
  assert.equal(generationError({ message: 'backend error', httpStatusCode: 503 }).retryable, true);
  assert.equal(generationError(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })).retryable, false);
});
async function setup(t, generate, options = {}) { const dir = await mkdtemp(join(tmpdir(), 'studio-fallback-')); const store = new JobStore(dir); await store.initialize(); const manager = new JobManager(store, { generate }, { retryDelayMs: 1, ...options }); t.after(async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); }); return { store, manager }; }
async function finish(store, id) { for (let n = 0; n < 200 && ['queued', 'running'].includes(store.get(id).status); n++) await delay(5); return store.get(id); }
test('一時的な失敗のみ、同じ入力を1回だけ自動で再試行する', async t => {
  const calls = []; const { store, manager } = await setup(t, async input => { calls.push(structuredClone(input)); if (calls.length === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); return { fileName: 'image.png' }; });
  const input = { ...validateInput({ prompt: 'same intent' }), basePrompt: 'same intent', layers: [], references: [] }; const job = await manager.enqueue(input); const result = await finish(store, job.id);
  assert.equal(result.status, 'succeeded'); assert.equal(result.attempts, 2); assert.equal(calls.length, 2); for (const key of ['prompt', 'basePrompt', 'layers', 'references', 'size', 'style', 'transparent']) assert.deepEqual(calls[0][key], calls[1][key]);
});
test('内容判定では書き換えも再試行もせず、入力を保持する', async t => {
  let calls = 0; const { store, manager } = await setup(t, async () => { calls++; throw generationError({ code: 'content_policy_violation', message: 'Rejected' }); });
  const input = { ...validateInput({ prompt: 'original description' }), layers: [{ body: 'original layer' }], references: [] }; const job = await manager.enqueue(input); const result = await finish(store, job.id);
  assert.equal(calls, 1); assert.equal(result.status, 'failed'); assert.equal(result.error.category, 'content'); assert.equal(result.error.retryable, false); assert.equal(result.prompt, input.prompt); assert.deepEqual(result.layers, input.layers);
});
test('連続する一時障害でも2回で停止し、状態不明なら再生成しない', async t => {
  let calls = 0; const { store, manager } = await setup(t, async () => { calls++; throw generationError({ code: 'internal_server_error', message: 'temporary' }); });
  const job = await manager.enqueue(validateInput({ prompt: 'cat' })); const result = await finish(store, job.id); assert.equal(calls, 2); assert.equal(result.status, 'failed');
  let ambiguousCalls = 0; const other = await setup(t, async () => { ambiguousCalls++; throw Object.assign(generationError({ code: 'CLI_DISCONNECTED' }), { autoRetryAllowed: false }); }); const second = await other.manager.enqueue(validateInput({ prompt: 'cat' })); await finish(other.store, second.id); assert.equal(ambiguousCalls, 1);
});
test('再試行の待機中にもキャンセルできる', async t => {
  let calls = 0; const { store, manager } = await setup(t, async () => { calls++; throw generationError('temporarily unavailable'); }, { retryDelayMs: 1000 }); const job = await manager.enqueue(validateInput({ prompt: 'cat' }));
  for (let n = 0; n < 100 && !store.get(job.id).message.includes('再試行'); n++) await delay(5);
  await manager.cancel(job.id); assert.equal((await finish(store, job.id)).status, 'cancelled'); assert.equal(calls, 1);
});

test('4件の同時失敗でも具体的な理由を保存し、入力変更や重複再試行をしない', async t => {
  const adapter = new CodexAdapter({ binary: resolve('test/fixtures/fake-codex.mjs') });
  const { store, manager } = await setup(t, adapter.generate.bind(adapter), { concurrency: 4 });
  const input = validateInput({ prompt: 'EMPTY_TOOL_ITEMS_ONLY', size: 'auto' });
  const batch = await manager.enqueueBatch(input, 4);
  for (const job of batch.jobs) {
    const result = await finish(store, job.id);
    assert.equal(result.status, 'failed'); assert.equal(result.attempts, 1); assert.equal(result.prompt, input.prompt); assert.equal(result.size, 'auto');
    assert.match(result.error.details, /diagnostic-42/); assert.doesNotMatch(result.error.details, /private-token|private-key/);
    const persisted = JSON.parse(await readFile(join(store.directory, job.id, 'job.json'), 'utf8'));
    assert.deepEqual(persisted.error, result.error);
  }
});
