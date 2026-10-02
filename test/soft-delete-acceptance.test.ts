import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { GenerationInput } from '../shared/types.js';
import { createApp } from '../src/http-app.js';
import { JobManager, JobStore } from '../src/job-store.js';
import { LineageStore } from '../src/lineage-store.js';
import { TemplateStore } from '../src/template-store.js';
import { UploadStore } from '../src/upload-store.js';
import {
  close,
  listen,
  readJson,
  serverPort,
  type DeleteBody,
  type DeletionPlan,
  type ErrorBody,
  type FailedPlan,
  type LineageBody,
  type RestoreBody,
  type TestAdapter,
  type TestJob,
  type TestUpload,
  type TrashBody,
} from './helpers.js';

function validPng() {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7cAAAAASUVORK5CYII=', 'base64');
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset); let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, offset + 8 + length); offset += 12 + length;
  }
  return bytes;
}
const png = validPng();
const ids = (values: { id?: string; jobId?: string }[]) => values.map(value => value.id ?? value.jobId).sort();
const recipe = (job: GenerationInput) => Object.fromEntries((['prompt', 'basePrompt', 'layers', 'references', 'size', 'style', 'transparent', 'lineageIntent'] as const).map(key => [key, job[key]]));
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 400; attempt++) { if (predicate()) return; await delay(5); }
  assert.fail('処理状態が期待値になりませんでした。');
}

async function setup(t: test.TestContext, { concurrency = 5 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-soft-delete-acceptance-'));
  const app = { directory, calls: [], pending: new Map(), failures: new Set<string>() } as unknown as {
    directory: string; calls: { id: string; prompt: string }[]; pending: Map<string, { finish: () => void; signal?: AbortSignal }>; failures: Set<string>;
    store: JobStore; uploads: UploadStore; templates: TemplateStore; lineage: LineageStore; manager: JobManager; server: import('node:http').Server;
    base: string; token: string;
    request: (path: string, method?: string, data?: unknown, extraHeaders?: Record<string, string>) => Promise<Response>;
    enqueue: (input: Record<string, unknown>) => Promise<TestJob>;
    create: (input: Record<string, unknown>) => Promise<TestJob>;
    fail: (input: { prompt: string }) => Promise<TestJob>;
    previewFailed: () => Promise<FailedPlan>; upload: (name: string) => Promise<TestUpload>;
    preview: (id: string) => Promise<DeletionPlan>; delete: (id: string) => Promise<DeleteBody>; reopen: () => Promise<void>;
  };
  async function start() {
    app.store = new JobStore(join(directory, 'jobs')); await app.store.initialize();
    app.uploads = new UploadStore(join(directory, 'uploads')); await app.uploads.initialize();
    app.templates = new TemplateStore(join(directory, 'templates.json'), { seed: false }); await app.templates.initialize();
    app.lineage = new LineageStore(join(directory, 'lineage.json')); await app.lineage.initialize(app.store, app.uploads);
    const adapter: TestAdapter = { health: async () => ({ ready: true, message: 'Ready' }), generate: async (job, { signal }) => {
      app.calls.push({ id: job.id, prompt: job.prompt });
      if (app.failures.delete(job.prompt)) throw Object.assign(new Error('利用上限'), { code: 'IMAGE_USAGE_LIMIT' });
      if (job.prompt.startsWith('SLOW')) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
          app.pending.set(job.id, { finish: resolve, signal });
          signal!.addEventListener('abort', abort, { once: true });
          if (signal!.aborted) abort();
        });
      }
      await writeFile(join(app.store.directory, job.id, 'image.png'), png);
      return { fileName: 'image.png', mime: 'image/png', bytes: png.length };
    } };
    app.manager = new JobManager(app.store, adapter, { lineage: app.lineage, uploads: app.uploads, concurrency });
    app.server = createApp({ store: app.store, manager: app.manager, adapter, templates: app.templates, lineage: app.lineage, uploads: app.uploads, publicDirectory: resolve('public') });
    await listen(app.server);
    app.base = `http://127.0.0.1:${serverPort(app.server)}`;
    app.token = (await readJson<{ token: string }>((await fetch(`${app.base}/api/session`)))).token;
  }
  async function stop() { await app.manager.close(); await close(app.server); }
  app.request = (path, method = 'GET', data, extraHeaders = {}) => fetch(`${app.base}${path}`, { method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': app.token, ...extraHeaders },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  app.enqueue = async input => {
    const response = await app.request('/api/jobs', 'POST', input); const value = await readJson<TestJob>(response);
    assert.equal(response.status, 202, JSON.stringify(value)); return value;
  };
  app.create = async input => { const job = await app.enqueue(input); await waitFor(() => app.store.get(job.id).status === 'succeeded'); return job; };
  app.fail = async input => { app.failures.add(input.prompt); const job = await app.enqueue(input); await waitFor(() => app.store.get(job.id).status === 'failed'); return job; };
  app.previewFailed = async () => {
    const response = await app.request('/api/jobs/failed/deletion-preview'); assert.equal(response.status, 200); return readJson<FailedPlan>(response);
  };
  app.upload = async name => {
    const response = await fetch(`${app.base}/api/uploads?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Studio-Token': app.token }, body: png,
    });
    assert.equal(response.status, 201); return readJson<TestUpload>(response);
  };
  app.preview = async id => {
    const response = await app.request(`/api/lineage/nodes/${id}/deletion-preview`);
    assert.equal(response.status, 200); return readJson<DeletionPlan>(response);
  };
  app.delete = async id => {
    const preview = await app.preview(id);
    const response = await app.request(`/api/lineage/nodes/${id}`, 'DELETE', { planToken: preview.planToken });
    const value = await readJson<DeleteBody>(response); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  app.reopen = async () => { await stop(); await start(); };
  await start();
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return app;
}

test('上流の論理削除は複数参照・別案・再生成をすべて辿り、原本と無関係な画像を保持して再起動後も復元できる', async t => {
  const app = await setup(t);
  const upload = await app.upload('参照の原本.png');
  const background = await app.create({ prompt: '独立した背景' });
  const subject = await app.create({ prompt: '人物を生成', references: [{ uploadId: upload.id, role: 'person' }] });
  const sibling = await app.create({ prompt: '起点からの別枝', references: [{ uploadId: upload.id, role: 'overall' }] });
  const merged = await app.create({ prompt: '人物と背景を合成', references: [{ jobId: subject.id, role: 'person' }, { jobId: background.id, role: 'background' }] });
  const edited = await app.create({ prompt: '参照を使わず入力を編集', lineageContext: { sourceJobId: merged.id, operation: 'edit' } });
  const retryResponse = await app.request(`/api/jobs/${edited.id}/retry`, 'POST'); assert.equal(retryResponse.status, 202);
  const retry = await readJson<TestJob>(retryResponse); await waitFor(() => app.store.get(retry.id).status === 'succeeded');
  const leaf = await app.create({ prompt: '再生成からの派生', references: [{ jobId: retry.id, role: 'overall' }] });
  const expected = [subject.id, merged.id, edited.id, retry.id, leaf.id].sort();
  const before = new Map(app.store.list().map(job => [job.id, recipe(job)]));
  const preview = await app.preview(subject.id);
  assert.deepEqual(ids(preview.nodes), expected); assert.equal(preview.count, 5); assert.equal(preview.uploadCount, 0); assert.equal(preview.activeCount, 0);
  assert.equal((await app.request(`/api/lineage/nodes/${subject.id}`, 'DELETE', { planToken: preview.planToken }, { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await app.request(`/api/lineage/nodes/${subject.id}`, 'DELETE', { planToken: preview.planToken }, { Origin: 'https://external.example' })).status, 403);
  const deletion = await app.delete(subject.id); assert.deepEqual([...deletion.deletedIds].sort(), expected);
  assert.deepEqual(ids((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs), [background.id, sibling.id].sort());
  assert.deepEqual(ids((await readJson<{ uploads: TestUpload[] }>((await app.request('/api/uploads')))).uploads), [upload.id]);
  const graph = await readJson<LineageBody>((await app.request('/api/lineage')));
  assert.deepEqual(ids(graph.commits), [upload.id, background.id, sibling.id].sort());
  for (const id of expected) {
    for (const path of [`/api/jobs/${id}`, `/api/jobs/${id}/image`, `/api/jobs/${id}/image?download=1`]) assert.ok([404, 410].includes((await app.request(path)).status));
    assert.ok([404, 410].includes((await app.request(`/api/jobs/${id}/retry`, 'POST')).status));
    assert.deepEqual(await readFile(join(app.store.directory, id, 'image.png')), png);
    assert.deepEqual(recipe(JSON.parse(await readFile(join(app.store.directory, id, 'job.json'), 'utf8'))), before.get(id));
  }
  const callsBefore = app.calls.length;
  for (const input of [{ prompt: 'deleted ref', references: [{ jobId: subject.id, role: 'overall' }] },
    { prompt: 'deleted source', lineageContext: { sourceJobId: subject.id, operation: 'edit' } }]) {
    const response = await app.request('/api/jobs', 'POST', input); assert.ok(response.status >= 400 && response.status < 500);
  }
  assert.equal(app.calls.length, callsBefore);
  await app.reopen();
  assert.deepEqual(ids((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs), [background.id, sibling.id].sort());
  const trash = await readJson<TrashBody>((await app.request('/api/trash'))); assert.equal(trash.deletions.length, 1);
  assert.equal(trash.deletions[0].id, deletion.deletionId); assert.equal(trash.deletions[0].nodeCount, 5);
  const restoreResponse = await app.request(`/api/trash/${deletion.deletionId}/restore`, 'POST');
  assert.equal(restoreResponse.status, 200); const restoration = await readJson<RestoreBody>(restoreResponse);
  assert.deepEqual([...restoration.restoredIds].sort(), expected); assert.deepEqual(restoration.stillDeletedIds, []);
  assert.equal((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs.length, before.size);
  assert.equal((await readJson<TrashBody>((await app.request('/api/trash')))).deletions.length, 0);
  assert.deepEqual(await app.uploads.readImage(upload.id), png);
});

test('アップロード起点の削除後に復元しても、先に消した子の削除グループを勝手に復元しない', async t => {
  const app = await setup(t);
  const root = await app.upload('アップロード起点.png');
  const child = await app.create({ prompt: 'child', references: [{ uploadId: root.id, role: 'person' }] });
  const leaf = await app.create({ prompt: 'leaf', references: [{ jobId: child.id, role: 'overall' }] });
  const sibling = await app.create({ prompt: 'sibling', references: [{ uploadId: root.id, role: 'overall' }] });
  const childDelete = await app.delete(child.id);
  const preview = await app.preview(root.id);
  assert.deepEqual(ids(preview.nodes), [root.id, sibling.id].sort()); assert.equal(preview.alreadyDeletedCount, 2);
  const rootDelete = await app.delete(root.id);
  assert.equal((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs.length, 0);
  assert.equal((await readJson<{ uploads: TestUpload[] }>((await app.request('/api/uploads')))).uploads.length, 0);
  assert.ok([404, 410].includes((await app.request(root.image.url)).status));
  const restoredRootResponse = await app.request(`/api/trash/${rootDelete.deletionId}/restore`, 'POST'); assert.equal(restoredRootResponse.status, 200);
  const restoredRoot = await readJson<RestoreBody>(restoredRootResponse);
  assert.deepEqual([...restoredRoot.restoredIds].sort(), [root.id, sibling.id].sort());
  assert.deepEqual([...restoredRoot.stillDeletedIds].sort(), [child.id, leaf.id].sort());
  assert.deepEqual(ids((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs), [sibling.id]);
  const restoredChildResponse = await app.request(`/api/trash/${childDelete.deletionId}/restore`, 'POST'); assert.equal(restoredChildResponse.status, 200);
  assert.deepEqual([...(await readJson<RestoreBody>(restoredChildResponse)).restoredIds].sort(), [child.id, leaf.id].sort());
  assert.equal((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs.length, 3);
  assert.deepEqual(await app.uploads.readImage(root.id), png);
});

test('削除の確認後に新しい下流ができた場合は削除せず、対象を再確認させる', async t => {
  const app = await setup(t);
  const root = await app.create({ prompt: 'root' });
  const preview = await app.preview(root.id);
  const child = await app.create({ prompt: 'new child', references: [{ jobId: root.id, role: 'overall' }] });
  const response = await app.request(`/api/lineage/nodes/${root.id}`, 'DELETE', { planToken: preview.planToken });
  assert.equal(response.status, 409); assert.equal((await readJson<ErrorBody>(response)).error.code, 'DELETE_PLAN_CHANGED');
  assert.deepEqual(ids((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs), [root.id, child.id].sort());
  assert.equal((await readJson<TrashBody>((await app.request('/api/trash')))).deletions.length, 0);
  const refreshed = await app.preview(root.id); assert.equal(refreshed.count, 2);
  await app.delete(root.id); assert.equal((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs.length, 0);
});

test('削除は下流の実行中・待機中だけ停止し、無関係な並列処理を継続する', async t => {
  const app = await setup(t, { concurrency: 2 });
  const root = await app.create({ prompt: 'root' });
  const running = await app.enqueue({ prompt: 'SLOW affected', references: [{ jobId: root.id, role: 'overall' }] });
  const independent = await app.enqueue({ prompt: 'SLOW independent' });
  await waitFor(() => app.pending.has(running.id) && app.pending.has(independent.id));
  const queued = await app.enqueue({ prompt: 'SLOW queued child', references: [{ jobId: root.id, role: 'overall' }] });
  const sourceChild = await app.enqueue({ prompt: 'SLOW input child', lineageContext: { sourceJobId: running.id, operation: 'edit' } });
  const preview = await app.preview(root.id); assert.equal(preview.count, 4); assert.equal(preview.activeCount, 3);
  const deletion = await app.delete(root.id);
  assert.deepEqual([...deletion.deletedIds].sort(), [root.id, running.id, queued.id, sourceChild.id].sort());
  for (const job of [running, queued, sourceChild]) assert.equal(app.store.get(job.id).status, 'cancelled');
  assert.ok(app.pending.get(running.id)!.signal!.aborted); assert.equal(app.pending.get(independent.id)!.signal!.aborted, false);
  assert.equal(app.store.get(independent.id).status, 'running');
  assert.ok(!app.calls.some(call => call.id === queued.id || call.id === sourceChild.id));
  app.pending.get(independent.id)!.finish(); await waitFor(() => app.store.get(independent.id).status === 'succeeded');
  assert.deepEqual(ids((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs), [independent.id]);
});

test('エラーの一括削除は失敗だけを対象にし、完成・生成中・待機中の再生成とキャンセル・アップロードを保持する', async t => {
  const app = await setup(t, { concurrency: 1 });
  const upload = await app.upload('残す参照.png');
  const failed = await app.fail({ prompt: '失敗した入力' });
  const queuedOrigin = await app.fail({ prompt: 'SLOW 失敗した入力' });
  const completedResponse = await app.request(`/api/jobs/${failed.id}/retry`, 'POST');
  assert.equal(completedResponse.status, 202);
  const completed = await readJson<TestJob>(completedResponse); await waitFor(() => app.store.get(completed.id).status === 'succeeded');
  const cancelled = await app.enqueue({ prompt: 'SLOW キャンセル' });
  await app.request(`/api/jobs/${cancelled.id}/cancel`, 'POST');
  const running = await app.enqueue({ prompt: 'SLOW 実行中の別案', lineageContext: { sourceJobId: failed.id, operation: 'edit' } });
  await waitFor(() => app.pending.has(running.id));
  const queuedResponse = await app.request(`/api/jobs/${queuedOrigin.id}/retry`, 'POST');
  assert.equal(queuedResponse.status, 202); const queued = await readJson<TestJob>(queuedResponse);
  assert.equal(app.store.get(queued.id).status, 'queued');
  const preview = await app.previewFailed(), failedIds = [failed.id, queuedOrigin.id].sort();
  assert.deepEqual(ids(preview.nodes), failedIds); assert.equal(preview.count, 2);
  assert.equal((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs.length, 6); // Preview never deletes.
  const response = await app.request('/api/jobs/failed', 'DELETE', { planToken: preview.planToken });
  assert.equal(response.status, 200); const deletion = await readJson<DeleteBody>(response);
  assert.deepEqual(deletion.deletedIds.sort(), failedIds);
  assert.deepEqual(ids((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs), [completed.id, running.id, queued.id, cancelled.id].sort());
  assert.equal(app.store.get(running.id).status, 'running'); assert.equal(app.pending.get(running.id)!.signal!.aborted, false);
  assert.equal(app.store.get(queued.id).status, 'queued'); assert.equal(app.store.get(cancelled.id).status, 'cancelled');
  assert.deepEqual(ids((await readJson<{ uploads: TestUpload[] }>((await app.request('/api/uploads')))).uploads), [upload.id]);
  app.pending.get(running.id)!.finish(); await waitFor(() => app.pending.has(queued.id));
  app.pending.get(queued.id)!.finish(); await waitFor(() => app.store.get(queued.id).status === 'succeeded');
  assert.equal(app.store.get(running.id).status, 'succeeded');
  const callsBefore = app.calls.length;
  await app.reopen();
  assert.deepEqual(ids((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs), [completed.id, running.id, queued.id, cancelled.id].sort());
  const trash = (await readJson<TrashBody>((await app.request('/api/trash')))).deletions;
  assert.equal(trash.length, 1); assert.equal(trash[0].nodeCount, 2);
  const restoredResponse = await app.request(`/api/trash/${deletion.deletionId}/restore`, 'POST');
  assert.equal(restoredResponse.status, 200); assert.deepEqual((await readJson<RestoreBody>(restoredResponse)).restoredIds.sort(), failedIds);
  assert.equal((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs.length, 6);
  assert.ok(failedIds.every(id => app.store.get(id).status === 'failed'));
  assert.equal(app.calls.length, callsBefore); // Restore does not regenerate or clean up automatically.
});

test('エラー一括削除の確認後に対象が増えた場合は一件も削除せず、再確認を要求する', async t => {
  const app = await setup(t), first = await app.fail({ prompt: '最初の失敗' });
  const preview = await app.previewFailed(), second = await app.fail({ prompt: '確認後の失敗' });
  const response = await app.request('/api/jobs/failed', 'DELETE', { planToken: preview.planToken });
  assert.equal(response.status, 409); assert.equal((await readJson<ErrorBody>(response)).error.code, 'DELETE_PLAN_CHANGED');
  assert.deepEqual(ids((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs), [first.id, second.id].sort());
  assert.equal(app.lineage.trash().length, 0);
  const refreshed = await app.previewFailed();
  assert.equal((await app.request('/api/jobs/failed', 'DELETE', { planToken: refreshed.planToken })).status, 200);
});

test('エラー一括削除はセッションと確認トークンを要求し、対象ゼロでは削除グループを作らない', async t => {
  const app = await setup(t); await app.fail({ prompt: '認証付きで削除' });
  const preview = await app.previewFailed();
  assert.equal((await app.request('/api/jobs/failed', 'DELETE', { planToken: preview.planToken }, { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await app.request('/api/jobs/failed', 'DELETE', { planToken: preview.planToken }, { Origin: 'https://external.example' })).status, 403);
  for (const input of [{}, { planToken: 'invalid' }, { planToken: preview.planToken, ids: [] }, []])
    assert.equal((await app.request('/api/jobs/failed', 'DELETE', input)).status, 400);
  assert.equal((await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs.length, 1);
  assert.equal((await app.request('/api/jobs/failed', 'DELETE', { planToken: preview.planToken })).status, 200);
  const empty = await app.previewFailed(); assert.equal(empty.count, 0);
  const response = await app.request('/api/jobs/failed', 'DELETE', { planToken: empty.planToken });
  assert.equal(response.status, 200); assert.equal((await readJson<DeleteBody>(response)).count, 0); assert.equal(app.lineage.trash().length, 1);
});
