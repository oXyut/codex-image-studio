import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LineageStore } from '../src/lineage-store.js';
import { JobStore, JobManager } from '../src/job-store.js';
import { prepareGeneration } from '../src/prompt-builder.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-lineage-'));
  const jobs = new JobStore(join(directory, 'jobs'));
  await jobs.initialize();
  const lineage = new LineageStore(join(directory, 'lineage.json'));
  await lineage.initialize(jobs);
  t.after(async () => { await jobs.manager?.close(); await rm(directory, { recursive: true, force: true }); });
  return { jobs, lineage };
}

async function seed(jobs, lineage, prompt, references = [], options = {}) {
  const job = await jobs.create({ prompt, basePrompt: prompt, layers: [], references, size: 'square', style: 'auto', transparent: false });
  await jobs.update(job.id, { status: 'succeeded', image: { fileName: 'image.png' } });
  await lineage.record(job, options);
  return jobs.get(job.id);
}

test('最新の画像を参照すると同じブランチを進め、古い画像や明示指定では分岐する', async t => {
  const { jobs, lineage } = await setup(t);
  const root = await seed(jobs, lineage, 'root');
  const child = await seed(jobs, lineage, 'child', [{ jobId: root.id, role: 'overall' }]);
  const sibling = await seed(jobs, lineage, 'sibling', [{ jobId: root.id, role: 'color' }]);
  const explicit = await seed(jobs, lineage, 'explicit', [{ jobId: child.id, role: 'composition' }],
    { context: { sourceJobId: child.id, operation: 'derive', newBranch: true } });
  assert.equal(lineage.get(root.id).branchId, lineage.get(child.id).branchId);
  assert.notEqual(lineage.get(root.id).branchId, lineage.get(sibling.id).branchId);
  assert.notEqual(lineage.get(child.id).branchId, lineage.get(explicit.id).branchId);
  assert.deepEqual(lineage.get(child.id).parentIds, [root.id]);
  assert.equal(lineage.get(child.id).operation, 'derive');
  assert.equal(lineage.snapshot().branches.find(branch => branch.id === lineage.get(root.id).branchId).headJobId, child.id);
});

test('再生成は元の参照とレシピを保った別ブランチで、元の完成画像を新たな参照にしない', async t => {
  const { jobs, lineage } = await setup(t);
  const root = await seed(jobs, lineage, 'red cup');
  const second = await seed(jobs, lineage, 'blue cup', [{ jobId: root.id, role: 'overall' }]);
  const alternative = await seed(jobs, lineage, second.prompt, second.references, { regenerateFrom: second.id });
  const metadata = lineage.get(alternative.id);
  assert.equal(metadata.operation, 'regenerate');
  assert.equal(metadata.sourceJobId, second.id);
  assert.deepEqual(metadata.parentIds, [root.id]);
  assert.equal(metadata.recipeHash, lineage.get(second.id).recipeHash);
  assert.notEqual(metadata.branchId, lineage.get(second.id).branchId);
  const rootAlternative = await seed(jobs, lineage, root.prompt, [], { regenerateFrom: root.id });
  assert.deepEqual(lineage.get(rootAlternative.id).parentIds, []);
});

test('レシピ編集の出発点と実際に参照した複数画像を区別して保持する', async t => {
  const { jobs, lineage } = await setup(t);
  const source = await seed(jobs, lineage, 'source');
  const ref1 = await seed(jobs, lineage, 'face');
  const ref2 = await seed(jobs, lineage, 'background');
  const edited = await seed(jobs, lineage, 'edited', [{ jobId: ref1.id, role: 'face' }, { jobId: ref2.id, role: 'background' }],
    { context: { sourceJobId: source.id, operation: 'edit', newBranch: false } });
  assert.equal(lineage.get(edited.id).sourceJobId, source.id);
  assert.deepEqual(lineage.get(edited.id).parentIds, [ref1.id, ref2.id]);
  assert.equal(lineage.get(edited.id).operation, 'edit');
  assert.notEqual(lineage.get(edited.id).branchId, lineage.get(source.id).branchId);
});

test('旧履歴を参照順に移行し、不明な参照を消さず、再起動で重複しない', async t => {
  const { jobs, lineage } = await setup(t);
  const root = await jobs.create({ prompt: 'old root', references: [] });
  const child = await jobs.create({ prompt: 'old child', references: [{ jobId: root.id, role: 'overall' }] });
  const absentId = randomUUID();
  const orphan = await jobs.create({ prompt: 'old missing reference', references: [{ jobId: absentId, role: 'overall' }] });
  await jobs.update(root.id, { createdAt: '2020-01-02T00:00:00.000Z' });
  await jobs.update(child.id, { createdAt: '2020-01-01T00:00:00.000Z' });
  await lineage.initialize(jobs);
  const first = lineage.snapshot();
  assert.equal(first.commits.length, 3);
  assert.equal(lineage.get(child.id).branchId, lineage.get(root.id).branchId);
  assert.deepEqual(lineage.get(orphan.id).parentIds, [absentId]);
  assert.equal(lineage.get(orphan.id).sourceJobId, null);
  const reloaded = new LineageStore(lineage.path);
  await reloaded.initialize(jobs); await reloaded.initialize(jobs);
  assert.deepEqual(reloaded.snapshot(), first);
  const secondPath = new LineageStore(`${lineage.path}.copy`);
  await secondPath.initialize(jobs);
  assert.deepEqual(secondPath.snapshot(), first);
});

test('同時分岐・注釈更新・ブランチ名変更を原子的に保存し、祖先情報を変更させない', async t => {
  const { jobs, lineage } = await setup(t);
  const root = await seed(jobs, lineage, 'root');
  const alternatives = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const job = await jobs.create({ prompt: `alternative ${index}`, references: [{ jobId: root.id, role: 'overall' }] });
    return lineage.record(job, { regenerateFrom: root.id });
  }));
  assert.equal(new Set(alternatives.map(commit => commit.branchId)).size, 12);
  const original = lineage.get(root.id);
  await Promise.all([
    lineage.annotate(root.id, { title: 'カップの出発点' }),
    lineage.annotate(root.id, { notes: '釉薬の色を比較する' }),
    lineage.renameBranch(original.branchId, { name: 'カップ研究' })
  ]);
  assert.deepEqual(lineage.get(root.id), { ...original, title: 'カップの出発点', notes: '釉薬の色を比較する' });
  await assert.rejects(lineage.annotate(root.id, { parentIds: [] }), { code: 'INVALID_LINEAGE_ANNOTATION' });
  await assert.rejects(lineage.annotate(root.id, { title: 'x'.repeat(101) }), { code: 'INVALID_LINEAGE_ANNOTATION' });
  await assert.rejects(lineage.renameBranch(original.branchId, { name: 'x'.repeat(81) }));
  await assert.rejects(lineage.annotate(randomUUID(), { title: 'missing' }), { code: 'LINEAGE_NOT_FOUND' });
  assert.deepEqual(JSON.parse(await readFile(lineage.path, 'utf8')), lineage.snapshot());
  const snapshot = lineage.snapshot(); snapshot.commits[0].parentIds.push(randomUUID());
  assert.deepEqual(lineage.get(root.id).parentIds, []);
});

test('生成元の偽造、参照にない派生元、未定義の操作を受け付けない', async t => {
  const { jobs, lineage } = await setup(t);
  const source = await seed(jobs, lineage, 'source');
  const recipe = { prompt: 'new', references: [{ jobId: source.id, role: 'overall' }] };
  const valid = prepareGeneration({ ...recipe, lineageContext: { sourceJobId: source.id, operation: 'derive' } }, null, jobs);
  assert.deepEqual(valid.lineageContext, { sourceJobId: source.id, operation: 'derive', newBranch: false });
  const badContexts = [null, { sourceJobId: randomUUID(), operation: 'derive' }, { sourceJobId: source.id, operation: 'regenerate' },
    { sourceJobId: source.id, operation: 'derive', parentIds: [] }, { sourceJobId: source.id, operation: 'edit', newBranch: 'true' }];
  for (const lineageContext of badContexts) assert.throws(() => prepareGeneration({ ...recipe, lineageContext }, null, jobs), { code: 'INVALID_LINEAGE_CONTEXT' });
  assert.throws(() => prepareGeneration({ prompt: 'new', lineageContext: { sourceJobId: source.id, operation: 'derive' } }, null, jobs), { code: 'INVALID_LINEAGE_CONTEXT' });
  assert.equal(prepareGeneration({ prompt: 'edit', lineageContext: { sourceJobId: source.id, operation: 'edit' } }, null, jobs).lineageContext.operation, 'edit');
});

test('系譜の永続化前には生成を開始せず、保存失敗時にも実行しない', async t => {
  const { jobs, lineage } = await setup(t);
  let generateCount = 0;
  const adapter = { generate: async job => { generateCount++; assert.ok(lineage.get(job.id)); return { fileName: 'image.png' }; } };
  const manager = new JobManager(jobs, adapter, { lineage }); jobs.manager = manager;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const originalRecord = lineage.record.bind(lineage);
  lineage.record = async (...args) => { await barrier; return originalRecord(...args); };
  const pending = manager.enqueue(prepareGeneration({ prompt: 'first' }, null, jobs));
  // Await disk creation, then inspect the adapter while the metadata write is held.
  while (!jobs.list().length) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(generateCount, 0);
  release(); await pending;
  await Promise.all([...manager.active.values()].map(job => job.promise));
  assert.equal(generateCount, 1);
  lineage.record = async () => { throw new Error('disk full'); };
  await assert.rejects(manager.enqueue(prepareGeneration({ prompt: 'blocked' }, null, jobs)), /disk full/);
  assert.equal(generateCount, 1);
  assert.equal(jobs.list().find(job => job.prompt === 'blocked').error.code, 'LINEAGE_SAVE_FAILED');
});

test('ジョブ保存と系譜保存の間で停止しても、編集元・再生成元と参照を正確に復元する', async t => {
  const { jobs, lineage } = await setup(t);
  const source = await jobs.create({ prompt: 'source recipe', references: [] });
  const edited = await jobs.create({ prompt: 'edited without reference', references: [],
    lineageIntent: { sourceJobId: source.id, operation: 'edit', newBranch: true } });
  const repeated = await jobs.create({ prompt: 'source recipe', references: [],
    lineageIntent: { sourceJobId: source.id, operation: 'regenerate', newBranch: true } });
  // The source can have a later legacy timestamp; its creation intent still wins.
  await jobs.update(source.id, { createdAt: '2030-01-01T00:00:00.000Z' });
  const reloadedJobs = new JobStore(jobs.directory); await reloadedJobs.initialize();
  const recovered = new LineageStore(lineage.path); await recovered.initialize(reloadedJobs);
  assert.equal(reloadedJobs.get(repeated.id).status, 'failed');
  for (const [job, operation] of [[edited, 'edit'], [repeated, 'regenerate']]) {
    const commit = recovered.get(job.id);
    assert.equal(commit.sourceJobId, source.id); assert.equal(commit.operation, operation);
    assert.deepEqual(commit.parentIds, []);
    assert.notEqual(commit.branchId, recovered.get(source.id).branchId);
  }
  const before = recovered.snapshot(); await recovered.initialize(reloadedJobs);
  assert.deepEqual(recovered.snapshot(), before);
});

test('メタデータの保存失敗後もサーバー生成の再生成意図を保持し、クライアントの意図は破棄する', async t => {
  const { jobs, lineage } = await setup(t);
  const source = await seed(jobs, lineage, 'same recipe');
  const manager = new JobManager(jobs, { generate: async () => { throw new Error('must not execute'); } }, { lineage }); jobs.manager = manager;
  lineage.record = async () => { throw new Error('write interrupted'); };
  const input = prepareGeneration({ prompt: source.prompt, lineageIntent: { sourceJobId: randomUUID(), operation: 'edit' } }, null, jobs);
  assert.equal(Object.hasOwn(input, 'lineageIntent'), false);
  await assert.rejects(manager.enqueue(input, { regenerateFrom: source.id }), /write interrupted/);
  const saved = jobs.list().find(job => job.id !== source.id);
  assert.deepEqual(saved.lineageIntent, { sourceJobId: source.id, operation: 'regenerate', newBranch: true });
  assert.equal(saved.error.code, 'LINEAGE_SAVE_FAILED');
  const recovered = new LineageStore(lineage.path); await recovered.initialize(jobs);
  assert.equal(recovered.get(saved.id).operation, 'regenerate');
  assert.equal(recovered.get(saved.id).sourceJobId, source.id);
  assert.deepEqual(recovered.get(saved.id).parentIds, []);
});
