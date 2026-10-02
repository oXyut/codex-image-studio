import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { JobStore, JobManager } from '../src/job-store.js';
import { validateInput } from '../src/validation.js';

async function setup(t) { const dir = await mkdtemp(join(tmpdir(), 'studio-jobs-')); const store = new JobStore(dir); t.after(async () => { await store.testManager?.close(); await rm(dir, { recursive: true, force: true }); }); await store.initialize(); return store; }
async function waitFor(predicate, message = '状態が変わりませんでした。') { for (let n = 0; n < 300; n++) { if (predicate()) return; await sleep(5); } assert.fail(message); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function controlledAdapter() {
  const started = [], pending = new Map(); let concurrent = 0, peak = 0;
  return { started, pending, get peak() { return peak; }, generate: async (job, { signal, onProgress }) => {
    started.push(job.id); concurrent++; peak = Math.max(peak, concurrent);
    try {
      return await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        pending.set(job.id, { progress: onProgress, finish: () => { signal.removeEventListener('abort', abort); resolve({ fileName: 'image.png' }); } });
      });
    } finally { concurrent--; pending.delete(job.id); }
  } };
}
test('履歴を保存し、再起動時の未完了生成を中断扱いにする', async t => {
  const store = await setup(t); const job = await store.create(validateInput({ prompt: 'cat' }));
  await store.update(job.id, { status: 'running' });
  const recovered = new JobStore(store.directory); await recovered.initialize();
  assert.equal(recovered.get(job.id).status, 'failed'); assert.equal(recovered.get(job.id).error.code, 'SERVER_RESTARTED');
});
test('同時生成数を1に設定すれば順番に実行し、待機中の生成をキャンセルする', async t => {
  const store = await setup(t); let concurrent = 0, peak = 0;
  const adapter = { generate: async () => { concurrent++; peak = Math.max(peak, concurrent); await sleep(30); concurrent--; return { fileName: 'image.png' }; } };
  const manager = new JobManager(store, adapter, { concurrency: 1 }); store.testManager = manager;
  const first = await manager.enqueue(validateInput({ prompt: 'first' }));
  const cancelled = await manager.enqueue(validateInput({ prompt: 'second' }));
  const last = await manager.enqueue(validateInput({ prompt: 'third' }));
  await manager.cancel(cancelled.id);
  for (let n = 0; n < 100 && store.get(last.id).status !== 'succeeded'; n++) await sleep(5);
  assert.equal(peak, 1); assert.equal(store.get(first.id).status, 'succeeded'); assert.equal(store.get(cancelled.id).status, 'cancelled'); assert.equal(store.get(last.id).status, 'succeeded');
});
test('キュー上限は同時に追加されても超えない', async t => {
  const store = await setup(t);
  const manager = new JobManager(store, { generate: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stop')), { once: true })) });
  store.testManager = manager;
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => manager.enqueue(validateInput({ prompt: 'cat' }))));
  assert.ok(results.filter(r => r.status === 'fulfilled').length <= 10 + manager.concurrency);
  assert.ok(manager.queue.length <= 10); assert.ok(manager.active.size <= manager.concurrency);
  assert.ok(results.some(r => r.status === 'rejected' && r.reason.code === 'QUEUE_FULL'));
});

test('既定では5件を同時生成し、6件目は空きが出てから開始する', async t => {
  const store = await setup(t); const adapter = controlledAdapter();
  const manager = new JobManager(store, adapter); store.testManager = manager;
  const batch = await manager.enqueueBatch(validateInput({ prompt: 'six alternatives' }), 6);
  await waitFor(() => adapter.started.length === 5);
  assert.equal(manager.concurrency, 5); assert.equal(manager.active.size, 5); assert.equal(adapter.peak, 5);
  assert.equal(store.get(batch.jobs[5].id).status, 'queued');
  adapter.pending.get(batch.jobs[1].id).finish();
  await waitFor(() => adapter.started.length === 6);
  assert.equal(store.get(batch.jobs[1].id).status, 'succeeded'); assert.equal(adapter.peak, 5);
  for (const pending of adapter.pending.values()) pending.finish();
  await waitFor(() => batch.jobs.every(job => store.get(job.id).status === 'succeeded'));
});

test('設定した並列上限を守り、一件のキャンセルはほかの生成を止めない', async t => {
  const store = await setup(t); const adapter = controlledAdapter();
  const manager = new JobManager(store, adapter, { concurrency: 2 }); store.testManager = manager;
  const batch = await manager.enqueueBatch(validateInput({ prompt: 'four alternatives' }), 4);
  await waitFor(() => adapter.started.length === 2);
  await manager.cancel(batch.jobs[0].id);
  await waitFor(() => adapter.started.length === 3);
  assert.equal(store.get(batch.jobs[0].id).status, 'cancelled');
  assert.equal(store.get(batch.jobs[1].id).status, 'running');
  assert.equal(adapter.pending.has(batch.jobs[1].id), true);
  await manager.cancel(batch.jobs[3].id);
  for (const pending of adapter.pending.values()) pending.finish();
  await waitFor(() => [1, 2].every(index => store.get(batch.jobs[index].id).status === 'succeeded'));
  assert.equal(adapter.peak, 2); assert.equal(adapter.started.includes(batch.jobs[3].id), false);
  assert.equal(store.get(batch.jobs[3].id).status, 'cancelled');
});

test('停止では並列実行中の全件と待機中の全件をキャンセルし、残りを開始しない', async t => {
  const store = await setup(t); const adapter = controlledAdapter();
  const manager = new JobManager(store, adapter, { concurrency: 3 }); store.testManager = manager;
  const batch = await manager.enqueueBatch(validateInput({ prompt: 'five alternatives' }), 5);
  await waitFor(() => adapter.started.length === 3);
  await manager.close();
  assert.equal(adapter.started.length, 3); assert.equal(manager.active.size, 0); assert.equal(manager.queue.length, 0);
  for (const job of batch.jobs) {
    assert.equal(store.get(job.id).status, 'cancelled');
    assert.equal(JSON.parse(await readFile(join(store.directory, job.id, 'job.json'), 'utf8')).status, 'cancelled');
  }
  await assert.rejects(manager.enqueue(validateInput({ prompt: 'after close' })), { code: 'SHUTTING_DOWN' });
});

test('同じ画像の進捗・結果の同時保存でフィールドを失わず、一時ファイルも競合しない', async t => {
  const store = await setup(t); const job = await store.create(validateInput({ prompt: 'write ordering' }));
  const save = store.save.bind(store), firstWrite = deferred(), release = deferred(); let writes = 0;
  store.save = async value => { if (value.id === job.id && ++writes === 1) { firstWrite.resolve(); await release.promise; } return save(value); };
  const progress = store.update(job.id, { message: 'rendering' }); await firstWrite.promise;
  const completion = store.update(job.id, { status: 'succeeded', image: { fileName: 'image.png' } });
  release.resolve(); await Promise.all([progress, completion]);
  const persisted = JSON.parse(await readFile(join(store.directory, job.id, 'job.json'), 'utf8'));
  assert.equal(persisted.message, 'rendering'); assert.equal(persisted.status, 'succeeded');
  assert.deepEqual(persisted.image, { fileName: 'image.png' }); assert.deepEqual(store.get(job.id), persisted);
});

test('ある画像の遅い進捗保存が別の画像の完了を待たせず、終了後の進捗も無視する', async t => {
  const store = await setup(t); const adapter = controlledAdapter();
  const manager = new JobManager(store, adapter, { concurrency: 2 }); store.testManager = manager;
  const batch = await manager.enqueueBatch(validateInput({ prompt: 'independent progress' }), 2);
  await waitFor(() => adapter.started.length === 2);
  const blocked = batch.jobs[0].id, independent = batch.jobs[1].id;
  const save = store.save.bind(store), entered = deferred(), release = deferred();
  store.save = async value => { if (value.id === blocked && value.message === 'slow progress') { entered.resolve(); await release.promise; } return save(value); };
  const blockedProgress = adapter.pending.get(blocked).progress;
  blockedProgress('slow progress'); await entered.promise;
  adapter.pending.get(independent).finish();
  await waitFor(() => store.get(independent).status === 'succeeded', '別の画像が遅い進捗保存を待っています。');
  assert.equal(store.get(blocked).status, 'running');
  release.resolve(); adapter.pending.get(blocked).finish();
  await waitFor(() => store.get(blocked).status === 'succeeded');
  blockedProgress('late message'); await sleep(10);
  assert.equal(store.get(blocked).message, '画像が完成しました。');
});

test('一時エラーの再試行も同じ並列枠を使い、他の画像の入力・進捗を混ぜない', async t => {
  const store = await setup(t), releaseRetry = deferred();
  const attempts = new Map(); let concurrent = 0, peak = 0;
  const adapter = { generate: async (job, { onProgress, signal }) => {
    concurrent++; peak = Math.max(peak, concurrent);
    const attempt = (attempts.get(job.prompt) ?? 0) + 1; attempts.set(job.prompt, attempt);
    try {
      onProgress(`${job.prompt}:${attempt}`);
      if (job.prompt === 'retry' && attempt === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      if (job.prompt === 'retry') {
        let abort;
        const cancellation = new Promise((resolve, reject) => {
          abort = () => reject(new Error('cancelled'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        try { await Promise.race([releaseRetry.promise, cancellation]); }
        finally { signal.removeEventListener('abort', abort); }
      }
      return { fileName: 'image.png', prompt: job.prompt };
    } finally { concurrent--; }
  } };
  const manager = new JobManager(store, adapter, { concurrency: 2, retryDelayMs: 1 }); store.testManager = manager;
  const retry = await manager.enqueue(validateInput({ prompt: 'retry' }));
  const other = await manager.enqueue(validateInput({ prompt: 'other' }));
  await waitFor(() => store.get(other.id).status === 'succeeded' && attempts.get('retry') === 2 && store.get(retry.id).message === 'retry:2');
  assert.equal(store.get(retry.id).status, 'running'); assert.equal(store.get(retry.id).message, 'retry:2');
  releaseRetry.resolve(); await waitFor(() => store.get(retry.id).status === 'succeeded');
  assert.equal(store.get(retry.id).attempts, 2); assert.equal(store.get(other.id).attempts, 1);
  assert.equal(store.get(retry.id).image.prompt, 'retry'); assert.equal(store.get(other.id).image.prompt, 'other');
  assert.ok(peak <= 2);
});

test('並列数には1〜10の整数だけを受け付ける', async t => {
  const store = await setup(t);
  for (const concurrency of [0, -1, 11, 1.5, '5', null, NaN]) assert.throws(() => new JobManager(store, {}, { concurrency }), { code: 'INVALID_GENERATION_CONCURRENCY' });
  for (const concurrency of [1, 5, 10]) assert.equal(new JobManager(store, {}, { concurrency }).concurrency, concurrency);
});
