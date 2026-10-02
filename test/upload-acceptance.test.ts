import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildLineageGraph, filterLineageGraph } from '../shared/lineage-utils.js';
import { CodexAdapter } from '../src/codex-adapter.js';
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
  type BatchBody,
  type LineageBody,
  type TestJob,
  type TestUpload,
} from './helpers.js';

function validPng() {
  const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7cAAAAASUVORK5CYII=', 'base64');
  for (let offset = 8; offset < buffer.length;) {
    const size = buffer.readUInt32BE(offset); let crc = 0xffffffff;
    for (const byte of buffer.subarray(offset + 4, offset + 8 + size)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    buffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, offset + 8 + size); offset += 12 + size;
  }
  return buffer;
}

test('アップロードから版付きテンプレートで生成・まとめ再生成し、元画像と系譜を再起動後も保持する', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-upload-acceptance-'));
  const uploads = new UploadStore(join(dir, 'uploads')); await uploads.initialize();
  const store = new JobStore(join(dir, 'jobs')); await store.initialize();
  const templates = new TemplateStore(join(dir, 'templates.json'), { seed: false }); await templates.initialize();
  const lineage = new LineageStore(join(dir, 'lineage.json')); await lineage.initialize(store, uploads);
  const adapter = new CodexAdapter({ binary: resolve('dist/test/fixtures/fake-codex.js'), timeoutMs: 5000 });
  const manager = new JobManager(store, adapter, { lineage, uploads });
  const server = createApp({ store, templates, uploads, lineage, manager, adapter, publicDirectory: resolve('public') });
  await listen(server);
  const base = `http://127.0.0.1:${serverPort(server)}`;
  t.after(async () => { await manager.close(); await close(server); await rm(dir, { recursive: true, force: true }); });
  const { token } = await readJson<{ token: string }>((await fetch(`${base}/api/session`)));
  const originalBytes = validPng();
  const response = await fetch(`${base}/api/uploads?name=${encodeURIComponent('持ち込みの参照.png')}`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Studio-Token': token }, body: originalBytes });
  assert.equal(response.status, 201); const upload = await readJson<TestUpload>(response);
  assert.equal(upload.kind, 'upload'); assert.equal(upload.lineage.operation, 'upload');
  assert.equal(upload.image.fileName, undefined); assert.equal(upload.path, undefined);
  assert.deepEqual(Buffer.from(await (await fetch(base + upload.image.url)).arrayBuffer()), originalBytes);
  const layer = await templates.create({ name: '朝の光', category: 'lighting', body: '淡い自然光。', tags: ['朝'] });
  await templates.update(layer.id, { body: '暖かな夕方の光。' });
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': token };
  const generation = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ prompt: '青いカップにする', layers: [layer], references: [{ uploadId: upload.id, role: 'composition' }], lineageContext: { sourceJobId: upload.id, operation: 'derive' }, size: 'vertical', style: 'photo' }) });
  assert.equal(generation.status, 202); const first = await readJson<TestJob>(generation);
  async function finished(id: string) {
    for (let attempt = 0; attempt < 1000 && ['queued', 'running'].includes(store.get(id).status); attempt++) await delay(5);
    assert.equal(store.get(id).status, 'succeeded', JSON.stringify(store.get(id).error));
    assert.deepEqual(await readFile(join(store.workspace(id), 'reference-1.png')), originalBytes);
    return store.get(id);
  }
  await finished(first.id);
  assert.equal(lineage.get(first.id)!.branchId, lineage.get(upload.id)!.branchId);
  const retry = await fetch(`${base}/api/jobs/${first.id}/retry-batch`, { method: 'POST', headers, body: '{"count":2}' });
  assert.equal(retry.status, 202); const batch = await readJson<BatchBody>(retry);
  assert.equal(batch.jobs.length, 2); assert.notEqual(batch.jobs[0].lineage.branchId, batch.jobs[1].lineage.branchId);
  for (const item of batch.jobs) {
    const saved = await finished(item.id);
    assert.deepEqual(saved.references, [{ uploadId: upload.id, role: 'composition' }]);
    assert.deepEqual(saved.layers, store.get(first.id).layers); assert.equal(saved.layers![0].version, 1);
    assert.equal(saved.layers![0].body, '淡い自然光。'); assert.equal(saved.size, 'vertical');
    assert.deepEqual(lineage.get(item.id)!.parentIds, [upload.id]);
    assert.equal(lineage.get(item.id)!.sourceJobId, first.id); assert.equal(lineage.get(item.id)!.operation, 'regenerate');
  }
  const before = await readFile(join(dir, 'lineage.json'));
  const recoveredUploads = new UploadStore(join(dir, 'uploads')); await recoveredUploads.initialize();
  const recoveredJobs = new JobStore(join(dir, 'jobs')); await recoveredJobs.initialize();
  const recoveredLineage = new LineageStore(join(dir, 'lineage.json')); await recoveredLineage.initialize(recoveredJobs, recoveredUploads);
  assert.deepEqual(await readFile(join(dir, 'lineage.json')), before);
  assert.deepEqual(await recoveredUploads.readImage(upload.id), originalBytes);
  assert.equal(recoveredJobs.list().length, 3); assert.equal(recoveredUploads.list().length, 1);
  const snapshot = await readJson<LineageBody>((await fetch(`${base}/api/lineage`)));
  const graph = buildLineageGraph(snapshot, recoveredJobs.list());
  assert.equal(graph.nodeMap.get(upload.id)!.job.kind, 'upload');
  const filtered = filterLineageGraph(graph, { branchId: lineage.get(batch.jobs[0].id)!.branchId });
  assert.ok(filtered.visibleIds.has(upload.id)); assert.ok(filtered.visibleIds.has(first.id));
  assert.equal(graph.missingEdges.length, 0);
});
