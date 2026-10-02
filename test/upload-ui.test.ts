import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { normalizeReferences, referenceSourceId, uploadFileType } from '../shared/studio-features.js';

test('参照の下書きはアップロードと生成画像を混在して保持し、サーバーに送るIDと役割だけを復元する', () => {
  const uploadId = randomUUID(), jobId = randomUUID();
  const references = normalizeReferences([{ uploadId, role: 'face', name: '手元の人物写真.jpg' }, { jobId, role: 'background', image: { url: '/images/example.png' } }]);
  assert.deepEqual(references, [{ uploadId, role: 'face' }, { jobId, role: 'background' }]);
  assert.deepEqual(references.map(referenceSourceId), [uploadId, jobId]);
  assert.deepEqual(normalizeReferences(JSON.parse(JSON.stringify(references))), references);
});

test('不正・曖昧・重複した下書きの参照を取り除き、混在する参照を4枚までに制限する', () => {
  const id = randomUUID(), jobs = Array.from({ length: 5 }, () => ({ jobId: randomUUID(), role: 'overall' }));
  const invalid = [null, {}, { jobId: '../image.png', role: 'overall' }, { jobId: id, uploadId: randomUUID(), role: 'overall' }, { uploadId: id, role: 'arbitrary' }];
  assert.deepEqual(normalizeReferences(invalid), []);
  assert.deepEqual(normalizeReferences([{ uploadId: id, role: 'face' }, { jobId: id, role: 'background' }, ...jobs]), [{ uploadId: id, role: 'face' }, ...jobs.slice(0, 3)]);
  assert.deepEqual(normalizeReferences({ references: jobs }), []);
});

test('アップロードはブラウザーのMIMEと、MIME未設定時の拡張子からPNG・JPEG・WebPを選ぶ', () => {
  assert.equal(uploadFileType({ name: 'photo.png', size: 1, type: 'image/png' }), 'image/png');
  assert.equal(uploadFileType({ name: 'PHOTO.JPG', size: 1, type: '' }), 'image/jpeg');
  assert.equal(uploadFileType({ name: 'photo.JPEG', size: 1, type: 'application/octet-stream' }), 'image/jpeg');
  assert.equal(uploadFileType({ name: 'photo.webp', size: 10 * 1024 * 1024, type: '' }), 'image/webp');
});

test('空ファイル、上限を超える画像、未対応形式は送信前に断る', () => {
  for (const file of [{ name: 'empty.png', size: 0, type: 'image/png' }, { name: 'large.png', size: 10 * 1024 * 1024 + 1, type: 'image/png' }, { name: 'drawing.svg', size: 10, type: 'image/svg+xml' }, { name: 'fake.png', size: 10, type: 'text/plain' }, { name: 'arbitrary.__proto__', size: 10, type: '' }]) assert.throws(() => uploadFileType(file));
});
