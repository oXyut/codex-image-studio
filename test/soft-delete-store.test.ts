import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Reference } from '../shared/types.js';
import { JobManager, JobStore } from '../src/job-store.js';
import { LineageStore } from '../src/lineage-store.js';
import { prepareGeneration } from '../src/prompt-builder.js';

function barrier() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-soft-delete-store-'));
  const jobs = new JobStore(join(directory, 'jobs')); await jobs.initialize();
  const lineage = new LineageStore(join(directory, 'lineage.json')); await lineage.initialize(jobs);
  const generated: string[] = [];
  const manager = new JobManager(jobs, { generate: async job => { generated.push(job.id); return { fileName: 'image.png' }; } }, { lineage });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const seed = async (prompt: string, references: Reference[] = []) => {
    const job = await jobs.create({ prompt, basePrompt: prompt, references, size: 'square', style: 'auto', transparent: false, layers: [] });
    await jobs.update(job.id, { status: 'succeeded', image: { fileName: 'image.png' } });
    await writeFile(join(jobs.directory, job.id, 'image.png'), Buffer.from('preserved original'));
    await lineage.record(jobs.get(job.id)); return jobs.get(job.id);
  };
  const remove = (id: string) => manager.softDelete(id, lineage.deletionPreview(id, jobs).planToken);
  return { directory, jobs, lineage, manager, generated, seed, remove };
}

test('親の削除が系譜保存より先に確定した単発生成は実行・公開せず、再起動時にも隠す', async t => {
  const app = await setup(t), root = await app.seed('root');
  const entered = barrier(), held = barrier(), record = app.lineage.record.bind(app.lineage);
  app.lineage.record = async (...args) => { entered.release(); await held.promise; return record(...args); };
  const staging = app.manager.enqueue(prepareGeneration({ prompt: 'child', references: [{ jobId: root.id, role: 'overall' }] }, null, app.jobs));
  await entered.promise;
  const child = app.jobs.list().find(job => job.id !== root.id);
  assert.equal(app.lineage.isVisible(child!.id), false);
  await app.remove(root.id); held.release();
  await assert.rejects(staging, { code: 'NODE_DELETED' });
  assert.deepEqual(app.generated, []); assert.equal(app.manager.queue.length, 0);
  assert.equal(app.lineage.isVisible(child!.id), false);
  const reloaded = new LineageStore(app.lineage.path); await reloaded.initialize(app.jobs);
  assert.equal(reloaded.isDeleted(child!.id), true); assert.equal(reloaded.activeSnapshot().commits.length, 0);
  assert.equal(reloaded.trash()[0].nodeCount, 2);
  const restoration = await reloaded.restore(reloaded.trash()[0].id);
  assert.deepEqual(restoration.restoredIds.sort(), [root.id, child!.id].sort());
  assert.equal(app.jobs.get(child!.id).status, 'failed'); // Restore never starts a rejected request.
});

test('バッチ系譜の途中で親を削除しても登録済み・未登録の子を実行せず、すべて非表示にする', async t => {
  const app = await setup(t), root = await app.seed('root');
  const entered = barrier(), held = barrier(), record = app.lineage.record.bind(app.lineage); let calls = 0;
  app.lineage.record = async (...args) => { if (++calls === 2) { entered.release(); await held.promise; } return record(...args); };
  const staging = app.manager.enqueueBatch(prepareGeneration({ prompt: 'batch child', references: [{ jobId: root.id, role: 'overall' }] }, null, app.jobs), 3);
  await entered.promise;
  assert.equal(app.jobs.list().length, 4); assert.equal(app.lineage.deletionPreview(root.id, app.jobs).count, 2);
  const deletion = await app.remove(root.id); held.release();
  await assert.rejects(staging, { code: 'NODE_DELETED' });
  assert.deepEqual(app.generated, []); assert.equal(app.manager.queue.length, 0);
  assert.ok(app.jobs.list().every(job => !app.lineage.isVisible(job.id)));
  const recovered = new LineageStore(app.lineage.path); await recovered.initialize(app.jobs);
  assert.ok(app.jobs.list().every(job => recovered.isDeleted(job.id)));
  assert.equal(recovered.trash()[0].nodeCount, 4);
  assert.equal((await recovered.restore(deletion.deletionId)).restoredIds.length, 4);
  assert.ok(app.jobs.list().filter(job => job.id !== root.id).every(job => ['failed', 'cancelled'].includes(job.status)));
});

test('削除処理中は生成を受け付けず、削除と競合した注釈や系譜追加は永続化順で拒否する', async t => {
  const app = await setup(t), root = await app.seed('root');
  const entered = barrier(), held = barrier();
  const removal = app.lineage.softDelete(root.id, app.lineage.deletionPreview(root.id, app.jobs).planToken,
    { cancel: async () => { entered.release(); await held.promise; } });
  await entered.promise;
  assert.throws(() => prepareGeneration({ prompt: 'child', references: [{ jobId: root.id, role: 'overall' }] }, null, app.jobs), { code: 'NODE_DELETED' });
  const annotation = app.lineage.annotate(root.id, { title: 'late edit' });
  const child = await app.jobs.create({ size: 'square', style: 'auto', transparent: false, prompt: 'late legacy child', references: [{ jobId: root.id, role: 'overall' }] });
  const record = app.lineage.record(child);
  held.release(); await removal;
  await assert.rejects(annotation, { code: 'NODE_DELETED' }); await assert.rejects(record, { code: 'NODE_DELETED' });
  assert.equal(app.lineage.get(root.id)!.title, 'root'); assert.equal(app.lineage.get(child.id), null);
});

test('子の削除グループを先に復元しても削除中の祖先から切り離して復活させない', async t => {
  const app = await setup(t), root = await app.seed('root');
  const child = await app.seed('child', [{ jobId: root.id, role: 'overall' }]);
  const leaf = await app.seed('leaf', [{ jobId: child.id, role: 'overall' }]);
  const childDeletion = await app.remove(child.id), rootDeletion = await app.remove(root.id);
  const restoredChild = await app.lineage.restore(childDeletion.deletionId);
  assert.deepEqual(restoredChild.restoredIds, []); assert.deepEqual(restoredChild.stillDeletedIds.sort(), [child.id, leaf.id].sort());
  assert.ok([root, child, leaf].every(job => app.lineage.isDeleted(job.id)));
  assert.equal(app.lineage.trash().length, 1);
  const restoredRoot = await app.lineage.restore(rootDeletion.deletionId);
  assert.deepEqual(restoredRoot.restoredIds.sort(), [root.id, child.id, leaf.id].sort());
  assert.equal(app.lineage.trash().length, 0);
});

test('削除のメタデータ保存に失敗した時は非表示を確定せず、原本と系譜を保持する', async t => {
  const app = await setup(t), root = await app.seed('root');
  const previousPath = app.lineage.path, originalState = app.lineage.snapshot();
  app.lineage.path = app.directory; // Renaming a file over this directory must fail.
  await assert.rejects(app.remove(root.id));
  app.lineage.path = previousPath;
  assert.equal(app.lineage.isDeleted(root.id), false); assert.deepEqual(app.lineage.snapshot(), originalState);
  assert.deepEqual(JSON.parse(await readFile(previousPath, 'utf8')), originalState);
  assert.equal(await readFile(await app.jobs.imagePath(root.id), 'utf8'), 'preserved original');
  assert.equal((await app.remove(root.id)).count, 1);
});

test('削除は複数の生成を先に全件abortしてから停止を待つ', async t => {
  const app = await setup(t), root = await app.seed('root');
  const ready = barrier(), workers = new Map();
  app.manager.adapter.generate = (job, { signal }) => new Promise((resolve, reject) => {
    workers.set(job.id, { signal, reject });
    // Neither worker will finish until both have been aborted.
    signal!.addEventListener('abort', () => {
      if ([...workers.values()].every(worker => worker.signal!.aborted)) for (const worker of workers.values()) worker.reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    }, { once: true });
    if (workers.size === 2) ready.release();
  });
  const batch = await app.manager.enqueueBatch(prepareGeneration({ prompt: 'parallel', references: [{ jobId: root.id, role: 'overall' }] }, null, app.jobs), 2);
  await ready.promise; await app.remove(root.id);
  assert.ok(batch.jobs.every(job => app.jobs.get(job.id).status === 'cancelled'));
  assert.ok([...workers.values()].every(worker => worker.signal!.aborted));
});

test('エラー一括削除の保存失敗では非表示を確定せず、原本と削除履歴を保持する', async t => {
  const app = await setup(t), failed = await app.seed('failed');
  await app.jobs.update(failed.id, { status: 'failed' });
  const plan = app.lineage.failedDeletionPreview(app.jobs), originalState = app.lineage.snapshot(), path = app.lineage.path;
  app.lineage.path = app.directory;
  await assert.rejects(app.lineage.softDeleteFailed(app.jobs, plan.planToken));
  app.lineage.path = path;
  assert.deepEqual(app.lineage.snapshot(), originalState); assert.equal(app.lineage.isDeleted(failed.id), false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), originalState);
  assert.equal(await readFile(join(app.jobs.directory, failed.id, 'image.png'), 'utf8'), 'preserved original');
  assert.equal((await app.lineage.softDeleteFailed(app.jobs, plan.planToken)).count, 1);
});

test('エラー一括削除と上流の削除が重なっても、片方の復元で他方の対象を復活させない', async t => {
  const app = await setup(t), root = await app.seed('root');
  const failed = await app.seed('failed', [{ jobId: root.id, role: 'overall' }]);
  const completed = await app.seed('completed', [{ jobId: failed.id, role: 'overall' }]);
  await app.jobs.update(failed.id, { status: 'failed' });
  const cleanup = await app.lineage.softDeleteFailed(app.jobs, app.lineage.failedDeletionPreview(app.jobs).planToken);
  assert.equal(app.lineage.isVisible(completed.id), true);
  const subtree = await app.remove(root.id);
  const restored = await app.lineage.restore(subtree.deletionId);
  assert.deepEqual(restored.restoredIds.sort(), [root.id, completed.id].sort()); assert.deepEqual(restored.stillDeletedIds, [failed.id]);
  assert.equal(app.lineage.trash()[0].nodeCount, 1);
  assert.deepEqual((await app.lineage.restore(cleanup.deletionId!)).restoredIds, [failed.id]);
  const secondCleanup = await app.lineage.softDeleteFailed(app.jobs, app.lineage.failedDeletionPreview(app.jobs).planToken);
  const secondSubtree = await app.remove(root.id);
  assert.deepEqual((await app.lineage.restore(secondCleanup.deletionId!)).restoredIds, []);
  assert.deepEqual((await app.lineage.restore(secondSubtree.deletionId)).restoredIds.sort(), [root.id, failed.id, completed.id].sort());
});
