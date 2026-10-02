import test from 'node:test';
import assert from 'node:assert/strict';
import { batchVisibility } from '../public/deletion-ui.js';
import { reconcileDraftSources } from '../public/studio-features.js';

test('まとめ生成から削除した件数を、受付に失敗した件数から分ける', () => {
  const jobs = [1, 3, 4].map(index => ({ id: `job-${index}`, batch: { id: 'batch', index, count: 5, deletedCount: 2 } }));
  assert.deepEqual(batchVisibility(jobs), { total: 5, deleted: 2, missing: 0 });
  assert.deepEqual(batchVisibility(jobs.slice(0, 2)), { total: 5, deleted: 2, missing: 1 });
  assert.deepEqual(batchVisibility(jobs.map(job => ({ ...job, batch: { ...job.batch, deletedCount: 0 } }))), { total: 5, deleted: 0, missing: 2 });
});

test('下流まで削除したとき、選択した参照と入力引継ぎを外し、無関係の参照は保持する', () => {
  const draft = { references: [{ uploadId: 'origin', role: 'person' }, { jobId: 'child', role: 'face' }, { jobId: 'unrelated', role: 'background' }], lineageContext: { sourceJobId: 'child', operation: 'edit', newBranch: true } };
  assert.deepEqual(reconcileDraftSources(draft, { removedIds: new Set(['origin', 'child']) }), { references: [{ jobId: 'unrelated', role: 'background' }], lineageContext: null });
});

test('初期読み込みの途中では未取得のアップロード参照を消さず、両一覧取得後は削除済みの起点を外す', () => {
  const draft = { references: [{ uploadId: 'origin', role: 'person' }, { jobId: 'deleted', role: 'face' }], lineageContext: { sourceJobId: 'origin', operation: 'derive' } };
  assert.deepEqual(reconcileDraftSources(draft, { jobsLoaded: true, jobs: [] }), { references: [{ uploadId: 'origin', role: 'person' }], lineageContext: draft.lineageContext });
  assert.deepEqual(reconcileDraftSources(draft, { jobsLoaded: true, uploadsLoaded: true }), { references: [], lineageContext: null });
  assert.deepEqual(reconcileDraftSources(draft, { jobsLoaded: true, uploadsLoaded: true, uploads: [{ id: 'origin' }] }), { references: [{ uploadId: 'origin', role: 'person' }], lineageContext: draft.lineageContext });
});

test('参照を追加せずに入力を引き継いだ下書きも、元ノードが消えたら生成元を解除する', () => {
  const draft = { references: [], lineageContext: { sourceJobId: 'deleted', operation: 'edit', newBranch: true } };
  assert.deepEqual(reconcileDraftSources(draft, { jobsLoaded: true, uploadsLoaded: true, jobs: [{ id: 'another' }] }), { references: [], lineageContext: null });
});
