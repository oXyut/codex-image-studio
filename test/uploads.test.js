import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { deflateSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { UploadStore, inspectUpload, MAX_UPLOAD_BYTES } from '../src/upload-store.js';
import { JobStore, JobManager } from '../src/job-store.js';
import { TemplateStore } from '../src/template-store.js';
import { LineageStore } from '../src/lineage-store.js';
import { prepareGeneration } from '../src/prompt-builder.js';
import { createApp } from '../src/http-app.js';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length); name.copy(output, 4); bytes.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, bytes])), output.length - 4); return output;
}
function png(width = 2, height = 3, { raw, compressed, extraChunks = [] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...extraChunks,
    chunk('IDAT', compressed ?? deflateSync(raw ?? Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDBooor5g/Wz//Z', 'base64');
const progressiveJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABgBdb/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAP/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
const webp = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+7tPf/mwK5rn3+//iQvxlT4yp/w/gAAA=', 'base64');
const alphaWebp = Buffer.from('UklGRl4AAABXRUJQVlA4WAoAAAAQAAAAAQAAAgAAQUxQSAcAAAAAe3t7e3t7AFZQOCAwAAAA0AEAnQEqAgADAAFAJiWgAnS6AfgAA7AA/u7T3/5sCua59/v/4kL8ZU+Mqf8P4AAA', 'base64');
const losslessWebp = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAEAdQlMKXonuBiOh/AAA=', 'base64');

async function setup(t, { ready = true, generate } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-uploads-'));
  const uploads = new UploadStore(join(directory, 'uploads')); await uploads.initialize();
  const store = new JobStore(join(directory, 'jobs')); await store.initialize();
  const templates = new TemplateStore(join(directory, 'templates.json'), { seed: false }); await templates.initialize();
  const lineage = new LineageStore(join(directory, 'lineage.json')); await lineage.initialize(store, uploads);
  const seen = [];
  const adapter = { health: async () => ({ ready, message: 'Codexが未接続です。' }), generate: generate || (async (job, { referenceImages, workspace }) => {
    seen.push({ job, references: await Promise.all(referenceImages.map(async item => ({ ...item, bytes: await readFile(item.path) }))) });
    const output = png(); await writeFile(join(workspace, '..', 'image.png'), output);
    return { fileName: 'image.png', mime: 'image/png', bytes: output.length };
  }) };
  const manager = new JobManager(store, adapter, { uploads, lineage });
  const server = createApp({ store, manager, adapter, templates, uploads, lineage, publicDirectory: resolve('public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': token };
  const post = (path, data, overrides = {}) => fetch(`${base}${path}`, { method: 'POST', headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), ...overrides });
  const upload = (bytes = png(), name = '光.png', mime = 'image/png', overrides = {}) => fetch(`${base}/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Studio-Token': token, 'Content-Type': mime }, body: bytes, ...overrides });
  t.after(async () => { await manager.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const finished = async id => {
    for (let n = 0; n < 200 && ['running', 'queued'].includes(store.get(id).status); n++) await sleep(5);
    assert.equal(store.get(id).status, 'succeeded'); return store.get(id);
  };
  return { directory, uploads, store, templates, lineage, adapter, manager, base, token, headers, post, upload, seen, finished };
}

test('PNG・JPEG・プログレッシブJPEG・WebPの実寸を読み、原本を加工しない', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-upload-formats-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new UploadStore(directory); await store.initialize();
  for (const [bytes, mime, extension] of [[png(), 'image/png', 'png'], [jpeg, 'image/jpeg', 'jpg'], [progressiveJpeg, 'image/jpeg', 'jpg'], [webp, 'image/webp', 'webp'], [alphaWebp, 'image/webp', 'webp'], [losslessWebp, 'image/webp', 'webp']]) {
    const item = await store.create(bytes, { mime, name: `写真.${extension}` });
    assert.equal(item.image.width, 2); assert.equal(item.image.height, 3); assert.equal(item.image.bytes, bytes.length);
    assert.deepEqual(await store.readImage(item.id), bytes);
    assert.equal((await stat(await store.imagePath(item.id))).mode & 0o777, 0o600);
  }
  const recovered = new UploadStore(directory); await recovered.initialize(); assert.deepEqual(recovered.list(), store.list());
});

test('MIME偽装、CRC不正、展開不正、途中で切れた画像、未知の形式を拒否する', () => {
  assert.throws(() => inspectUpload(png(), 'image/jpeg'), { code: 'UPLOAD_TYPE_MISMATCH' });
  assert.throws(() => inspectUpload(png(), 'image/svg+xml'), { code: 'UNSUPPORTED_UPLOAD_TYPE' });
  const corrupt = png(); corrupt[corrupt.length - 20] ^= 1;
  const filter = Buffer.alloc(27); filter[0] = 5;
  for (const bytes of [corrupt, png(2, 3, { compressed: Buffer.from([1, 2, 3]) }), png(2, 3, { raw: filter }), png(2, 3, { raw: Buffer.alloc(2) }), png().subarray(0, -1), Buffer.concat([png(), Buffer.from([0])])]) assert.throws(() => inspectUpload(bytes, 'image/png'), { code: 'INVALID_UPLOAD_IMAGE' });
  for (const bytes of [jpeg.subarray(0, -2), Buffer.from([255, 216, 255, 217]), jpeg.subarray(0, 300)]) assert.throws(() => inspectUpload(bytes, 'image/jpeg'), { code: 'INVALID_UPLOAD_IMAGE' });
  for (const bytes of [webp.subarray(0, -1), webp.subarray(0, 22)]) assert.throws(() => inspectUpload(bytes, 'image/webp'), { code: 'INVALID_UPLOAD_IMAGE' });
  assert.throws(() => inspectUpload(Buffer.from('<svg></svg>'), 'image/png'), { code: 'INVALID_UPLOAD_IMAGE' });
  assert.throws(() => inspectUpload(Buffer.alloc(0), 'image/png'), { code: 'INVALID_UPLOAD_IMAGE' });
});

test('巨大な寸法・展開量とアニメーションを受け付けない', () => {
  assert.throws(() => inspectUpload(png(16385, 1, { raw: Buffer.alloc(1) }), 'image/png'), { code: 'UPLOAD_DIMENSIONS_TOO_LARGE' });
  assert.throws(() => inspectUpload(png(10000, 10000, { raw: Buffer.alloc(1) }), 'image/png'), { code: 'UPLOAD_DIMENSIONS_TOO_LARGE' });
  assert.throws(() => inspectUpload(png(0, 1, { raw: Buffer.alloc(1) }), 'image/png'), { code: 'INVALID_UPLOAD_IMAGE' });
  assert.throws(() => inspectUpload(png(2, 3, { raw: Buffer.alloc(100000) }), 'image/png'), { code: 'INVALID_UPLOAD_IMAGE' });
  assert.throws(() => inspectUpload(Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'image/png'), { code: 'UPLOAD_TOO_LARGE' });
  assert.throws(() => inspectUpload(png(2, 3, { extraChunks: [chunk('acTL', Buffer.alloc(8))] }), 'image/png'), { code: 'ANIMATED_UPLOAD_IMAGE' });
  const animated = Buffer.from(alphaWebp); animated[20] |= 2;
  assert.throws(() => inspectUpload(animated, 'image/webp'), { code: 'ANIMATED_UPLOAD_IMAGE' });
});

test('保存先と画像のシンボリックリンクを拒否し、メタデータから任意パスを読まない', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-upload-links-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new UploadStore(join(directory, 'uploads')); await store.initialize();
  const item = await store.create(png(), { mime: 'image/png', name: '../../folder/光.png' }); assert.equal(item.name, '光.png');
  assert.throws(() => store.get('../outside'), { code: 'UPLOAD_NOT_FOUND' });
  const path = await store.imagePath(item.id); await rename(path, `${path}.original`); await symlink(`${path}.original`, path);
  await assert.rejects(store.imagePath(item.id), { code: 'INVALID_REFERENCE_IMAGE' });
  const recovered = new UploadStore(store.directory); await recovered.initialize(); assert.equal(recovered.list().length, 0);
  await rm(path); await rename(`${path}.original`, path);
  const metadata = { ...item, image: { ...item.image, fileName: '../../outside.png' } };
  await writeFile(join(store.directory, item.id, 'upload.json'), JSON.stringify(metadata));
  const invalid = new UploadStore(store.directory); await invalid.initialize(); assert.equal(invalid.list().length, 0);
  const link = join(directory, 'link'); await symlink(store.directory, link);
  await assert.rejects(new UploadStore(link).initialize(), { code: 'INVALID_UPLOAD_DIRECTORY' });
});

test('アップロード単体にはCodex認証を要求せず、公開情報と原本ダウンロードを返す', async t => {
  const app = await setup(t, { ready: false }); const bytes = png();
  const response = await app.upload(bytes, '窓辺の写真.png'); assert.equal(response.status, 201); const item = await response.json();
  assert.equal(item.kind, 'upload'); assert.equal(item.status, 'uploaded'); assert.equal(item.name, '窓辺の写真.png');
  assert.equal(item.image.width, 2); assert.equal(item.image.height, 3); assert.equal(item.image.fileName, undefined); assert.equal(item.image.path, undefined);
  assert.equal(item.lineage.operation, 'upload'); assert.deepEqual(item.lineage.parentIds, []); assert.equal(item.lineage.sourceJobId, null);
  const listed = await (await fetch(`${app.base}/api/uploads`)).json(); assert.deepEqual(listed.uploads, [item]);
  const metadata = await (await fetch(`${app.base}/api/lineage`)).json(); assert.deepEqual(metadata.uploads, [item]);
  const image = await fetch(`${app.base}${item.image.downloadUrl}`); assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png'); assert.match(image.headers.get('content-disposition'), /attachment; filename="reference-/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes); assert.equal(app.store.list().length, 0);
  const missing = await fetch(`${app.base}/api/uploads/${randomUUID()}/image`); assert.equal(missing.status, 404);
  assert.equal((await fetch(`${app.base}/api/uploads/..%2f..%2f.env/image`)).status, 404);
});

test('アップロードAPIはトークン・Origin・Hostを検証し、不正画像を保存しない', async t => {
  const app = await setup(t);
  assert.equal((await app.upload(png(), 'a.png', 'image/png', { headers: { 'Content-Type': 'image/png' } })).status, 403);
  assert.equal((await app.upload(png(), 'a.png', 'image/png', { headers: { 'Content-Type': 'image/png', 'X-Studio-Token': app.token, Origin: 'https://example.com' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${app.base}/api/uploads`, { method: 'POST', headers: { Host: 'evil.example', 'X-Studio-Token': app.token, 'Content-Type': 'image/png' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end(png());
  });
  assert.equal(hostStatus, 403);
  assert.equal((await app.upload(png(), 'a.svg', 'image/svg+xml')).status, 415);
  assert.equal((await app.upload(png(), 'a.jpg', 'image/jpeg')).status, 415);
  assert.equal((await app.upload(png().subarray(0, -4))).status, 400);
  const large = await app.upload(Buffer.alloc(MAX_UPLOAD_BYTES + 1)); assert.equal(large.status, 413); assert.equal((await large.json()).error.code, 'UPLOAD_TOO_LARGE');
  assert.equal((await app.upload(png(), 'x'.repeat(501))).status, 400);
  assert.equal(app.uploads.list().length, 0); assert.equal(app.lineage.snapshot().commits.length, 0);
});

test('アップロードのタイトル・メモを注釈APIで更新し、画像原本は保持する', async t => {
  const app = await setup(t); const item = await (await app.upload()).json();
  const response = await fetch(`${app.base}/api/lineage/uploads/${item.id}`, { method: 'PATCH', headers: app.headers, body: JSON.stringify({ title: '参照の起点', notes: '手持ちの写真' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).title, '参照の起点');
  const listed = await (await fetch(`${app.base}/api/uploads`)).json(); assert.equal(listed.uploads[0].lineage.notes, '手持ちの写真');
  assert.deepEqual(await app.uploads.readImage(item.id), png());
});

test('アップロードと生成画像を同時参照し、役割・原本・系譜を生成に渡す', async t => {
  const app = await setup(t); const uploaded = await (await app.upload()).json();
  const sourceResponse = await app.post('/api/jobs', { prompt: '生成済みの参照' }); const source = await sourceResponse.json(); await app.finished(source.id);
  const references = [{ uploadId: uploaded.id, role: 'person' }, { jobId: source.id, role: 'background' }];
  const response = await app.post('/api/jobs', { prompt: '手持ちの人物写真を背景に合わせる', references, lineageContext: { sourceJobId: uploaded.id, operation: 'derive' } });
  assert.equal(response.status, 202); const generated = await response.json(); await app.finished(generated.id);
  assert.deepEqual(generated.references, references); assert.deepEqual(generated.lineage.parentIds, [uploaded.id, source.id]);
  assert.equal(generated.lineage.sourceJobId, uploaded.id); assert.equal(generated.lineage.operation, 'derive');
  assert.equal(app.seen[1].references[0].role, 'person'); assert.deepEqual(app.seen[1].references[0].bytes, png());
  assert.deepEqual(app.seen[1].references[1].bytes, png()); assert.equal(app.seen[1].references[0].jobId, undefined);
  assert.deepEqual(app.store.get(generated.id).references, references);
  assert.equal(generated.lineageIntent, undefined); assert.equal(generated.references[0].path, undefined);
});

test('同じアップロードを起点にバッチの兄弟を作り、再生成でも同じ参照を保つ', async t => {
  const app = await setup(t); const uploaded = await (await app.upload()).json();
  const references = [{ uploadId: uploaded.id, role: 'overall' }];
  const response = await app.post('/api/batches', { prompt: '写真をもとに三つの別案', count: 3, references });
  assert.equal(response.status, 202); const batch = await response.json();
  assert.equal(new Set(batch.jobs.map(job => job.lineage.branchId)).size, 3);
  for (const item of batch.jobs) { await app.finished(item.id); assert.deepEqual(item.lineage.parentIds, [uploaded.id]); assert.equal(item.lineage.sourceJobId, uploaded.id); assert.deepEqual(item.references, references); }
  const retry = await app.post(`/api/jobs/${batch.jobs[0].id}/retry-batch`, { count: 2 }); assert.equal(retry.status, 202); const next = await retry.json();
  for (const item of next.jobs) { await app.finished(item.id); assert.equal(item.lineage.operation, 'regenerate'); assert.equal(item.lineage.sourceJobId, batch.jobs[0].id); assert.deepEqual(item.lineage.parentIds, [uploaded.id]); assert.deepEqual(item.references, references); }
  const single = await app.post(`/api/jobs/${batch.jobs[1].id}/retry`); assert.equal(single.status, 202); const one = await single.json(); await app.finished(one.id);
  assert.deepEqual(one.references, references); assert.deepEqual(one.lineage.parentIds, [uploaded.id]);
  assert.ok(app.seen.every(item => item.references.length === 1 && item.references[0].uploadId === uploaded.id && item.references[0].bytes.equals(png())));
});

test('参照の任意パス・種別二重指定・重複・上限超過・未知IDを拒否する', async t => {
  const app = await setup(t); const uploaded = await (await app.upload()).json();
  const invalid = [
    [{ uploadId: uploaded.id, jobId: uploaded.id, role: 'overall' }],
    [{ uploadId: uploaded.id, path: '/etc/passwd', role: 'overall' }],
    [{ uploadId: uploaded.id, role: 'unknown' }],
    [{ uploadId: uploaded.id, role: 'overall' }, { uploadId: uploaded.id, role: 'subject' }],
    Array.from({ length: 5 }, () => ({ uploadId: uploaded.id, role: 'overall' })),
    [{ uploadId: '../../outside', role: 'overall' }],
  ];
  for (const references of invalid) assert.equal((await app.post('/api/jobs', { prompt: '参照', references })).status, 400);
  const unknown = await app.post('/api/jobs', { prompt: '参照', references: [{ uploadId: randomUUID(), role: 'overall' }] }); assert.equal(unknown.status, 404); assert.equal((await unknown.json()).error.code, 'UPLOAD_NOT_FOUND');
  assert.equal((await app.post('/api/jobs', { prompt: '参照', references: [{ uploadId: uploaded.id, role: 'overall' }], lineageContext: { sourceJobId: randomUUID(), operation: 'derive' } })).status, 400);
  assert.equal(app.store.list().length, 0);
  assert.throws(() => prepareGeneration({ prompt: '参照', references: [{ uploadId: uploaded.id, role: 'overall' }] }, app.templates, app.store), { code: 'UPLOAD_NOT_FOUND' });
});

test('アップロードと系譜の保存の間に中断しても再起動で起点を回復する', async t => {
  const app = await setup(t); const item = await app.uploads.create(png(), { mime: 'image/png', name: '保存中断.png' });
  assert.equal(app.lineage.get(item.id), null);
  const recoveredUploads = new UploadStore(app.uploads.directory); await recoveredUploads.initialize();
  const recoveredLineage = new LineageStore(app.lineage.path); await recoveredLineage.initialize(app.store, recoveredUploads);
  assert.equal(recoveredLineage.get(item.id).operation, 'upload'); assert.deepEqual(await recoveredUploads.readImage(item.id), png());
  const before = await readFile(recoveredLineage.path, 'utf8'); await recoveredLineage.initialize(app.store, recoveredUploads); assert.equal(await readFile(recoveredLineage.path, 'utf8'), before);
});
