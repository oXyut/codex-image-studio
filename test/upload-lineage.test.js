import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LineageStore } from '../src/lineage-store.js';
import { JobStore } from '../src/job-store.js';
import { buildLineageGraph, filterLineageGraph, layoutLineageGraph, lineageTitle } from '../public/lineage-utils.js';

const upload = (name = 'reference.png', changes = {}) => ({ id: randomUUID(), kind: 'upload', status: 'uploaded', name,
  createdAt: '2026-10-02T00:00:00.000Z', image: { url: '/api/uploads/reference/image', mime: 'image/png', bytes: 1500, width: 300, height: 200 }, ...changes });

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-upload-lineage-'));
  const jobs = new JobStore(join(directory, 'jobs')); await jobs.initialize();
  const lineage = new LineageStore(join(directory, 'lineage.json')); await lineage.initialize(jobs);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { jobs, lineage };
}

async function generation(jobs, lineage, prompt, references, options = {}) {
  const job = await jobs.create({ prompt, basePrompt: prompt, size: 'square', style: 'auto', transparent: false, layers: [], references });
  await lineage.record(job, options); return job;
}

test('アップロードは生成ジョブを作らず、独立した参照の起点として保存・注釈管理する', async t => {
  const { jobs, lineage } = await setup(t);
  const original = upload('  顔の参照.png  ');
  const commit = await lineage.recordUpload(original);
  assert.equal(jobs.list().length, 0);
  assert.equal(commit.operation, 'upload'); assert.equal(commit.title, '顔の参照.png');
  assert.equal(commit.sourceJobId, null); assert.deepEqual(commit.parentIds, []);
  assert.equal(lineage.snapshot().branches[0].headJobId, original.id);
  await lineage.recordUpload(original);
  assert.equal(lineage.snapshot().commits.length, 1); assert.equal(lineage.snapshot().branches.length, 1);
  await lineage.annotate(original.id, { title: '人物の出発点', notes: '髪型を引き継ぐ' });
  const next = new LineageStore(lineage.path); await next.initialize(jobs, [original]);
  assert.deepEqual(next.get(original.id), { ...commit, title: '人物の出発点', notes: '髪型を引き継ぐ' });
  assert.deepEqual(JSON.parse(await readFile(lineage.path, 'utf8')), next.snapshot());
});

test('アップロードから最初の生成は同じ枝を進め、同じ起点の別案は分岐する', async t => {
  const { jobs, lineage } = await setup(t); const original = upload(); await lineage.recordUpload(original);
  const first = await generation(jobs, lineage, '朝の光', [{ uploadId: original.id, role: 'overall' }]);
  const second = await generation(jobs, lineage, '夕方の光', [{ uploadId: original.id, role: 'color' }]);
  const next = await generation(jobs, lineage, '構図を寄せる', [{ jobId: first.id, role: 'composition' }]);
  assert.equal(lineage.get(first.id).branchId, lineage.get(original.id).branchId);
  assert.notEqual(lineage.get(second.id).branchId, lineage.get(original.id).branchId);
  assert.equal(lineage.get(next.id).branchId, lineage.get(first.id).branchId);
  assert.deepEqual(lineage.get(first.id).parentIds, [original.id]);
  assert.equal(lineage.get(first.id).sourceJobId, original.id); assert.equal(lineage.get(first.id).operation, 'derive');
  assert.equal(lineage.get(second.id).sourceJobId, original.id);
  assert.equal(lineage.snapshot().branches.find(branch => branch.id === lineage.get(original.id).branchId).headJobId, next.id);
});

test('複数のアップロードと生成画像を参照しても、実際の親と再生成元を区別する', async t => {
  const { jobs, lineage } = await setup(t); const face = upload('face.png'), background = upload('garden.jpg');
  await lineage.recordUpload(face); await lineage.recordUpload(background);
  const generated = await generation(jobs, lineage, '既存の画像', []);
  const references = [{ uploadId: face.id, role: 'face' }, { uploadId: background.id, role: 'background' }, { jobId: generated.id, role: 'color' }];
  const merged = await generation(jobs, lineage, '人物と庭を組み合わせる', references);
  assert.deepEqual(lineage.get(merged.id).parentIds, [face.id, background.id, generated.id]);
  const retried = await generation(jobs, lineage, merged.prompt, references, { regenerateFrom: merged.id });
  assert.deepEqual(lineage.get(retried.id).parentIds, [face.id, background.id, generated.id]);
  assert.equal(lineage.get(retried.id).sourceJobId, merged.id); assert.equal(lineage.get(retried.id).operation, 'regenerate');
  assert.notEqual(lineage.get(retried.id).branchId, lineage.get(merged.id).branchId);
  assert.equal(lineage.get(retried.id).recipeHash, lineage.get(merged.id).recipeHash);
});

test('まとめ生成の別案はアップロードを共通の親として、互いを親にしない', async t => {
  const { jobs, lineage } = await setup(t); const original = upload(); await lineage.recordUpload(original);
  const siblings = [];
  for (let index = 0; index < 3; index++) siblings.push(await generation(jobs, lineage, '同じ入力の別案', [{ uploadId: original.id, role: 'overall' }],
    { context: { sourceJobId: original.id, operation: 'derive', newBranch: true } }));
  assert.equal(new Set(siblings.map(job => lineage.get(job.id).branchId)).size, 3);
  for (const job of siblings) {
    assert.deepEqual(lineage.get(job.id).parentIds, [original.id]); assert.equal(lineage.get(job.id).sourceJobId, original.id);
    assert.notEqual(lineage.get(job.id).branchId, lineage.get(original.id).branchId);
  }
  assert.equal(lineage.snapshot().branches.find(branch => branch.id === lineage.get(original.id).branchId).headJobId, original.id);
});

test('アップロード保存と系統保存の間で停止しても起点を先に復元し、再起動で重複しない', async t => {
  const { jobs, lineage } = await setup(t); const original = upload('late-clock.png', { createdAt: '2030-01-01T00:00:00.000Z' });
  const first = await jobs.create({ prompt: '早い時計の生成', references: [{ uploadId: original.id, role: 'overall' }],
    lineageIntent: { sourceJobId: original.id, operation: 'derive', newBranch: false } });
  await jobs.update(first.id, { createdAt: '2020-01-01T00:00:00.000Z' });
  const recovered = new LineageStore(lineage.path); await recovered.initialize(jobs, { list: () => [original] });
  assert.equal(recovered.snapshot().commits[0].jobId, original.id);
  assert.equal(recovered.get(first.id).branchId, recovered.get(original.id).branchId);
  assert.deepEqual(recovered.get(first.id).parentIds, [original.id]);
  const before = recovered.snapshot(); await recovered.initialize(jobs, [original]); assert.deepEqual(recovered.snapshot(), before);
  const separateRecovery = new LineageStore(`${lineage.path}.copy`); await separateRecovery.initialize(jobs, [original]);
  assert.deepEqual(separateRecovery.snapshot(), before, '回復した起点と枝のIDは決定的である');
});

test('系統図はアップロードを別種のノードにし、検索・枝絞り込みにも起点を残す', () => {
  const face = upload('人物参考.png'), garden = upload('庭の参考.jpg');
  const childId = randomUUID(), branchId = randomUUID();
  const jobs = [{ id: childId, status: 'succeeded', prompt: '庭に立つ人物', createdAt: '2026-10-02T00:01:00.000Z', references: [{ uploadId: face.id, role: 'face' }, { uploadId: garden.id, role: 'background' }] }];
  const graph = buildLineageGraph({ uploads: [face, garden], branches: [{ id: branchId, name: '庭で撮影' }],
    commits: [{ jobId: childId, branchId, parentIds: [face.id, garden.id], sourceJobId: face.id, operation: 'derive', title: '庭の候補', notes: '' }] }, jobs);
  assert.equal(graph.nodes.filter(value => value.kind === 'generation').length, 1);
  assert.equal(graph.nodes.filter(value => value.kind === 'upload').length, 2);
  assert.equal(graph.nodeMap.get(face.id).operation, 'upload'); assert.equal(graph.nodeMap.get(face.id).job.status, 'uploaded');
  assert.equal(lineageTitle(graph.nodeMap.get(face.id)), face.name);
  assert.deepEqual(graph.nodeMap.get(childId).parents, [face.id, garden.id]);
  assert.equal(graph.missingEdges.length, 0); assert.equal(graph.components.length, 1);
  const filtered = filterLineageGraph(graph, { branchId, query: '庭の候補' });
  assert.deepEqual([...filtered.matchIds], [childId]); assert.equal(filtered.visibleIds.size, 3);
  const layout = layoutLineageGraph(graph, filtered);
  assert.ok(layout.positions.get(face.id).x < layout.positions.get(childId).x);
  assert.ok(layout.positions.get(garden.id).x < layout.positions.get(childId).x);
  assert.notEqual(layout.positions.get(face.id).y, layout.positions.get(garden.id).y);
  const fileSearch = filterLineageGraph(graph, { query: '人物参考.png アップロード' });
  assert.deepEqual([...fileSearch.matchIds], [face.id]);
});
