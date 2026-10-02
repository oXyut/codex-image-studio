import assert from 'node:assert/strict';
import test from 'node:test';
import { groupGenerationHistory } from '../shared/batch-groups.js';

const job = (id: string, batch?: string | null, index = 1, changes: { batch?: import("../shared/types.js").Batch } = {}) => ({ id, createdAt: '2026-10-02T01:00:00.000Z', status: 'succeeded', ...(batch ? { batch: { id: batch, index, count: 5 } } : {}), ...changes });

test('同じ時刻・参照元の別受付を混ぜず、完了順が前後したバッチを番号順にまとめる', () => {
  const jobs = [job('b3', 'batch-b', 3), job('a5', 'batch-a', 5), job('one'), job('b1', 'batch-b', 1), job('a1', 'batch-a', 1), job('two')];
  const groups = groupGenerationHistory(jobs);
  assert.deepEqual(groups.map(group => [group.kind, group.id, group.jobs.map(value => value.id)]), [['batch', 'batch-b', ['b1', 'b3']], ['batch', 'batch-a', ['a1', 'a5']], ['single', 'one', ['one', 'two']]]);
  assert.deepEqual(jobs.map(value => value.id), ['b3', 'a5', 'one', 'b1', 'a1', 'two']);
});

test('検索や状態絞り込みで一部だけ表示しても、全件数・削除件数・未受付を混同しない', () => {
  const all = [job('a1', 'a', 1), job('a3', 'a', 3), job('a4', 'a', 4), job('a5', 'a', 5)].map(value => ({ ...value, batch: { ...value.batch, deletedCount: 1 } }));
  const [group] = groupGenerationHistory([all[1]], all);
  assert.ok(group.kind === "batch");
  assert.equal(group.jobs.length, 1);
  assert.equal(group.total, 5);
  assert.equal(group.retained, 4);
  assert.equal(group.deleted, 1);
  assert.equal(group.missing, 0);
  const [partial] = groupGenerationHistory([all[1]], all.slice(0, 3));
  assert.ok(partial.kind === "batch");
  assert.equal(partial.missing, 1);
});

test('単独生成と1件受付を同時作成グループとして扱わず、空の履歴も表示できる', () => {
  assert.deepEqual(groupGenerationHistory([]), []);
  const groups = groupGenerationHistory([job('one'), job('single-request', null, 1, { batch: { id: 'count-one', index: 1, count: 1 } })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'single');
  assert.equal(groups[0].jobs.length, 2);
});
