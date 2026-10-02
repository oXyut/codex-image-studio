import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { GenerationInput, Generator, Job, LineageBranch, LineageCommit } from '../shared/types.js';
import { createApp } from '../src/http-app.js';
import { JobManager, JobStore } from '../src/job-store.js';
import { LineageStore } from '../src/lineage-store.js';
import { TemplateStore } from '../src/template-store.js';
import { AppError } from '../src/validation.js';
import {
  close,
  listen,
  readJson,
  serverPort,
  type LineageBody,
  type TestAdapter,
  type TestJob,
} from './helpers.js';
import { generationError } from '../src/generation-errors.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');
const inputs = (job: GenerationInput) => Object.fromEntries((['prompt', 'basePrompt', 'layers', 'references', 'size', 'style', 'transparent'] as const).map(key => [key, job[key]]));

async function setup(t: test.TestContext, { seed, generate }: { seed?: (store: JobStore) => Promise<void>; generate?: Generator['generate'] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-lineage-acceptance-'));
  const store = new JobStore(join(directory, 'jobs')); await store.initialize();
  await seed?.(store);
  const templates = new TemplateStore(join(directory, 'templates.json'), { seed: false }); await templates.initialize();
  const lineagePath = join(directory, 'lineage.json');
  const lineage = new LineageStore(lineagePath); await lineage.initialize(store);
  const calls: ReturnType<typeof inputs>[] = [];
  const adapter: TestAdapter = { health: async () => ({ ready: true, message: 'Ready' }), generate: async (job, options) => {
    calls.push(structuredClone(inputs(job)));
    if (generate) return generate(job, options);
    await writeFile(join(store.directory, job.id, 'image.png'), png);
    return { fileName: 'image.png', mime: 'image/png', bytes: png.length };
  } };
  const manager = new JobManager(store, adapter, { lineage, retryDelayMs: 0 });
  const server = createApp({ store, manager, adapter, templates, lineage, publicDirectory: resolve('public') });
  await listen(server);
  const base = `http://127.0.0.1:${serverPort(server)}`;
  const { token } = await readJson<{ token: string }>((await fetch(`${base}/api/session`)));
  t.after(async () => { await manager.close(); await close(server); await rm(directory, { recursive: true, force: true }); });
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': token };
  const request = (path: string, method = 'GET', data?: unknown, extraHeaders: Record<string, string> = {}) => fetch(`${base}${path}`, { method, headers: { ...headers, ...extraHeaders }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  async function create(input: unknown) {
    const response = await request('/api/jobs', 'POST', input);
    const job = await readJson<TestJob>(response);
    assert.equal(response.status, 202, JSON.stringify(job));
    await complete(job.id);
    return readJson<TestJob>((await request(`/api/jobs/${job.id}`)));
  }
  async function complete(id: string) {
    for (let n = 0; n < 200 && ['queued', 'running'].includes(store.get(id).status); n++) await sleep(5);
    assert.ok(!['queued', 'running'].includes(store.get(id).status), '生成は待機・実行状態から終了する');
  }
  const snapshot = async () => readJson<LineageBody>((await request('/api/lineage')));
  return { directory, store, lineagePath, lineage, templates, manager, calls, request, create, complete, snapshot };
}

async function seedImage(store: JobStore, input: Partial<GenerationInput> & { createdAt: string }, status = 'succeeded') {
  const job = await store.create({ prompt: 'legacy prompt', basePrompt: 'legacy prompt', layers: [], references: [], size: 'square', style: 'auto', transparent: false, ...input });
  if (status === 'succeeded') await writeFile(join(store.directory, job.id, 'image.png'), png);
  return store.update(job.id, { createdAt: input.createdAt ?? job.createdAt, status, image: status === 'succeeded' ? { fileName: 'image.png', mime: 'image/png', bytes: png.length } : null, finishedAt: new Date().toISOString() });
}

test('完成画像の再生成は入力を完全に保持し、同じ親を持つ別ブランチを作る', async t => {
  const app = await setup(t);
  const template = await app.templates.create({ name: '暖色', category: 'color', body: 'やわらかな暖色', tags: ['日常'], favorite: true });
  const reference = await app.create({ prompt: '赤いカップ' });
  const original = await app.create({ prompt: '青いカップにする', templateIds: [template.id], references: [{ jobId: reference.id, role: 'overall' }], size: 'portrait', style: 'photo', transparent: true, lineageContext: { sourceJobId: reference.id, operation: 'derive' } });
  await app.templates.update(template.id, { body: '後から変えた色味' }); await app.templates.archive(template.id);
  const siblings = [];
  for (let n = 0; n < 2; n++) {
    const response = await app.request(`/api/jobs/${original.id}/retry`, 'POST');
    assert.equal(response.status, 202); const job = await readJson<TestJob>(response); await app.complete(job.id);
    siblings.push(await readJson<TestJob>((await app.request(`/api/jobs/${job.id}`))));
  }
  for (const sibling of siblings) {
    assert.deepEqual(inputs(sibling), inputs(original));
    assert.equal(sibling.lineage.operation, 'regenerate');
    assert.equal(sibling.lineage.sourceJobId, original.id);
    assert.deepEqual(sibling.lineage.parentIds, [reference.id]);
    assert.notEqual(sibling.lineage.branchId, original.lineage.branchId);
    assert.ok(!sibling.lineage.parentIds.includes(original.id), '再生成元を参照画像の親として誤って追加しない');
  }
  assert.notEqual(siblings[0].lineage.branchId, siblings[1].lineage.branchId);
  assert.deepEqual(app.calls.slice(-2), [inputs(original), inputs(original)]);
});

test('最新画像からはブランチを継続し、古い画像・明示指定からは分岐する', async t => {
  const app = await setup(t);
  const root = await app.create({ prompt: 'カップ' });
  const derived = await app.create({ prompt: '青くする', references: [{ jobId: root.id, role: 'overall' }], lineageContext: { sourceJobId: root.id, operation: 'derive' } });
  assert.equal(derived.lineage.branchId, root.lineage.branchId);
  const continuation = await app.create({ prompt: '背景を白にする', references: [{ jobId: derived.id, role: 'background' }], lineageContext: { sourceJobId: derived.id, operation: 'derive' } });
  assert.equal(continuation.lineage.branchId, root.lineage.branchId);
  const fromOld = await app.create({ prompt: '赤くする', references: [{ jobId: root.id, role: 'overall' }], lineageContext: { sourceJobId: root.id, operation: 'derive' } });
  assert.notEqual(fromOld.lineage.branchId, root.lineage.branchId);
  const explicit = await app.create({ prompt: '黄色くする', references: [{ jobId: continuation.id, role: 'overall' }], lineageContext: { sourceJobId: continuation.id, operation: 'derive', newBranch: true } });
  assert.notEqual(explicit.lineage.branchId, continuation.lineage.branchId);
  const graph = await app.snapshot();
  assert.equal(graph.branches.find(branch => branch.id === root.lineage.branchId)!.headJobId, continuation.id);
  assert.equal(graph.branches.find(branch => branch.id === fromOld.lineage.branchId)!.headJobId, fromOld.id);
  assert.equal(graph.branches.find(branch => branch.id === explicit.lineage.branchId)!.headJobId, explicit.id);
});

test('複数参照の全親を保存し、入力編集元は参照親と区別する', async t => {
  const app = await setup(t);
  const subject = await app.create({ prompt: '人物' });
  const background = await app.create({ prompt: '庭' });
  const merged = await app.create({ prompt: '庭に立つ人物', references: [{ jobId: subject.id, role: 'person' }, { jobId: background.id, role: 'background' }], lineageContext: { sourceJobId: subject.id, operation: 'derive' } });
  assert.deepEqual(merged.lineage.parentIds, [subject.id, background.id]);
  const edited = await app.create({ prompt: '別の構図で人物を作る', lineageContext: { sourceJobId: merged.id, operation: 'edit' } });
  assert.equal(edited.lineage.operation, 'edit'); assert.equal(edited.lineage.sourceJobId, merged.id);
  assert.deepEqual(edited.lineage.parentIds, []);
  const retriedResponse = await app.request(`/api/jobs/${merged.id}/retry`, 'POST'); assert.equal(retriedResponse.status, 202);
  const retried = await readJson<TestJob>(retriedResponse); assert.deepEqual(retried.lineage.parentIds, [subject.id, background.id]);
});

test('旧履歴を欠損・削除せず移行し、再起動を繰り返しても系譜は増殖しない', async t => {
  let root!: Job, other!: Job, derived!: Job, failed!: Job;
  const createdAt = '2026-10-02T00:00:00.000Z';
  const app = await setup(t, { seed: async store => {
    root = await seedImage(store, { prompt: '旧・人物', createdAt });
    other = await seedImage(store, { prompt: '旧・背景', createdAt });
    derived = await seedImage(store, { prompt: '旧・合成', createdAt, references: [{ jobId: root.id, role: 'person' }, { jobId: other.id, role: 'background' }] });
    failed = await seedImage(store, { prompt: '旧・失敗', createdAt }, 'failed');
  } });
  const graph = await app.snapshot(); assert.equal(graph.version, 1); assert.equal(graph.commits.length, 4);
  assert.deepEqual(graph.commits.find(commit => commit.jobId === derived.id)!.parentIds, [root.id, other.id]);
  // Equal timestamps may retain insertion order before restart and filesystem order
  // after restart. Compare immutable records by ID, not their presentation order.
  const historySnapshot = (store: JobStore) => store.list().map(job => ({ id: job.id, ...inputs(job), status: job.status })).sort((a, b) => a.id.localeCompare(b.id));
  const before = historySnapshot(app.store);
  for (let n = 0; n < 2; n++) {
    const reloadedJobs = new JobStore(app.store.directory); await reloadedJobs.initialize();
    const reloaded = new LineageStore(app.lineagePath); await reloaded.initialize(reloadedJobs);
    assert.deepEqual(reloaded.activeSnapshot(), graph);
    assert.deepEqual(reloaded.snapshot().deletions, []);
    assert.deepEqual(historySnapshot(reloadedJobs), before);
  }
  const publicJobs = (await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs;
  assert.equal(publicJobs.length, 4); assert.ok(publicJobs.every(job => job.lineage?.jobId === job.id));
  assert.equal(publicJobs.find(job => job.id === failed.id)!.status, 'failed');
});

test('メモとブランチ名を独立保存し、生成時の入力スナップショットを変更しない', async t => {
  const app = await setup(t);
  const root = await app.create({ prompt: 'カップを正面から撮る', style: 'photo' });
  const before = structuredClone(inputs(root));
  const annotation = await app.request(`/api/lineage/jobs/${root.id}`, 'PATCH', { title: '正面案', notes: 'この色を基準にして次を作る。' });
  assert.equal(annotation.status, 200); assert.equal((await readJson<LineageCommit>(annotation)).title, '正面案');
  const renamed = await app.request(`/api/lineage/branches/${root.lineage.branchId}`, 'PATCH', { name: 'カップの色の検討' });
  assert.equal(renamed.status, 200); assert.equal((await readJson<LineageBranch>(renamed)).name, 'カップの色の検討');
  const current = await readJson<TestJob>((await app.request(`/api/jobs/${root.id}`)));
  assert.deepEqual(inputs(current), before); assert.equal(current.lineage.notes, 'この色を基準にして次を作る。');
  const reloadedJobs = new JobStore(app.store.directory); await reloadedJobs.initialize();
  const reloaded = new LineageStore(app.lineagePath); await reloaded.initialize(reloadedJobs);
  assert.equal(reloaded.get(root.id)!.title, '正面案'); assert.equal(reloaded.get(root.id)!.notes, 'この色を基準にして次を作る。');
  assert.equal(reloaded.snapshot().branches.find(branch => branch.id === root.lineage.branchId)!.name, 'カップの色の検討');
  const jobFile = JSON.parse(await readFile(join(app.store.directory, root.id, 'job.json'), 'utf8'));
  assert.deepEqual(inputs(jobFile), before);
});

test('系譜の変更はトークンと同一オリジンを要求し、改ざんされた文脈・入力を拒否する', async t => {
  const app = await setup(t);
  const root = await app.create({ prompt: 'カップ' });
  const endpoint = `/api/lineage/jobs/${root.id}`;
  assert.equal((await app.request(endpoint, 'PATCH', { title: '拒否される' }, { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await app.request(endpoint, 'PATCH', { title: '拒否される' }, { Origin: 'https://external.example' })).status, 403);
  assert.equal((await app.request('/api/lineage', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const annotation of [{ title: 'x'.repeat(101) }, { notes: 'x'.repeat(2001) }, { title: 3 }, { notes: [] }]) {
    assert.equal((await app.request(endpoint, 'PATCH', annotation)).status, 400, JSON.stringify(annotation));
  }
  for (const name of ['', 'x'.repeat(81), 3]) assert.equal((await app.request(`/api/lineage/branches/${root.lineage.branchId}`, 'PATCH', { name })).status, 400);
  assert.equal((await app.request(`/api/lineage/jobs/${randomUUID()}`, 'PATCH', { title: 'なし' })).status, 404);
  assert.equal((await app.request(`/api/lineage/branches/${randomUUID()}`, 'PATCH', { name: 'なし' })).status, 404);
  const refs = [{ jobId: root.id, role: 'overall' }];
  const contexts = [
    { sourceJobId: root.id, operation: 'regenerate' },
    { sourceJobId: root.id, operation: 'generate' },
    { sourceJobId: '../etc/passwd', operation: 'derive' },
    { sourceJobId: root.id, operation: 'derive', newBranch: 'yes' },
    { sourceJobId: root.id, operation: 'derive', branchId: randomUUID() },
  ];
  for (const lineageContext of contexts) {
    assert.equal((await app.request('/api/jobs', 'POST', { prompt: '派生', references: refs, lineageContext })).status, 400, JSON.stringify(lineageContext));
  }
  assert.equal((await app.request('/api/jobs', 'POST', { prompt: '参照なし', lineageContext: { sourceJobId: root.id, operation: 'derive' } })).status, 400);
  const unknownSource = await app.request('/api/jobs', 'POST', { prompt: '存在しない元', lineageContext: { sourceJobId: randomUUID(), operation: 'edit' } });
  assert.equal(unknownSource.status, 400, '存在しない編集元をクライアント入力エラーとして拒否する');
  const forged = await app.create({ prompt: '新規', lineage: { operation: 'regenerate', parentIds: [root.id], branchId: root.lineage.branchId } });
  assert.equal(forged.lineage.operation, 'generate'); assert.deepEqual(forged.lineage.parentIds, []); assert.notEqual(forged.lineage.branchId, root.lineage.branchId);
});

test('同時に同じ先端から生成すると一方が継続し、もう一方は自動で分岐する', async t => {
  const app = await setup(t);
  const root = await app.create({ prompt: '基準画像' });
  const results = await Promise.all(['青案', '赤案'].map(prompt => app.request('/api/jobs', 'POST', { prompt, references: [{ jobId: root.id, role: 'overall' }], lineageContext: { sourceJobId: root.id, operation: 'derive' } })));
  const jobs = [];
  for (const response of results) { assert.equal(response.status, 202); const job = await readJson<TestJob>(response); await app.complete(job.id); jobs.push(job); }
  assert.equal(jobs.filter(job => job.lineage.branchId === root.lineage.branchId).length, 1);
  assert.notEqual(jobs[0].lineage.branchId, jobs[1].lineage.branchId);
  const graph = await app.snapshot();
  for (const job of jobs) {
    assert.deepEqual(job.lineage.parentIds, [root.id]);
    assert.equal(graph.branches.find(branch => branch.id === job.lineage.branchId)!.headJobId, job.id);
  }
  const reloaded = new LineageStore(app.lineagePath); await reloaded.initialize(app.store);
  assert.deepEqual(reloaded.activeSnapshot(), graph);
  assert.deepEqual(reloaded.snapshot().deletions, []);
});

test('失敗した生成もメタデータを残し、入力編集と再生成から作業を続けられる', async t => {
  const app = await setup(t, { generate: async () => { const error = new AppError('content policy violation', 'CONTENT_REVIEW'); throw error; } });
  const failed = await app.create({ prompt: '保存される入力' }); assert.equal(failed.status, 'failed');
  assert.equal(failed.lineage.operation, 'generate'); assert.deepEqual(failed.lineage.parentIds, []);
  const edit = await app.create({ prompt: '編集した入力', lineageContext: { sourceJobId: failed.id, operation: 'edit' } });
  assert.equal(edit.lineage.sourceJobId, failed.id); assert.deepEqual(edit.lineage.parentIds, []);
  const retriedResponse = await app.request(`/api/jobs/${failed.id}/retry`, 'POST'); assert.equal(retriedResponse.status, 202);
  const retried = await readJson<TestJob>(retriedResponse); await app.complete(retried.id);
  assert.equal(retried.lineage.operation, 'regenerate'); assert.equal(retried.lineage.sourceJobId, failed.id); assert.equal(retried.prompt, failed.prompt);
  const graph = await app.snapshot(); assert.equal(graph.commits.length, 3); assert.equal(app.calls.length, 9, '各ジョブで初回と2回の再試行を行い、系譜のノードは増やさない');
  for (const job of [failed, edit, retried]) assert.equal(app.store.get(job.id).attempts, 3);
});

test('サイレント再試行の途中も終了後も履歴と系譜は1件のまま、再起動しても増えない', async t => {
  for (const succeeds of [true, false]) {
    let entered!: () => void, release!: () => void;
    const retryStarted = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let attempts = 0;
    const app = await setup(t, { generate: async (job, { signal, onProgress }) => {
      attempts++;
      if (attempts > 1) onProgress?.('再試行の内部メッセージ');
      if (attempts === 2) {
        signal?.addEventListener('abort', release, { once: true });
        entered(); await gate;
      }
      if (attempts < 3 || !succeeds) throw generationError('画像生成ツールの安全システムがリクエストを拒否したため、画像を生成できませんでした。');
      await writeFile(join(app.store.directory, job.id, 'image.png'), png);
      return { fileName: 'image.png', mime: 'image/png', bytes: png.length };
    } });
    const response = await app.request('/api/jobs', 'POST', { prompt: '保存される入力' });
    assert.equal(response.status, 202); const job = await readJson<TestJob>(response);
    await retryStarted;
    const running = await readJson<TestJob>(await app.request(`/api/jobs/${job.id}`));
    assert.equal(running.status, 'running'); assert.equal(running.error, null);
    assert.doesNotMatch(running.message, /拒否|再試行|リトライ|回目/);
    const before = await app.snapshot();
    assert.equal(before.commits.length, 1); assert.equal(before.branches.length, 1);
    release(); await app.complete(job.id);
    const result = await readJson<TestJob>(await app.request(`/api/jobs/${job.id}`));
    assert.equal(result.status, succeeds ? 'succeeded' : 'failed'); assert.equal(result.attempts, 3);
    if (succeeds) assert.equal(result.error, null);
    else assert.equal(result.error!.message, '3回のリトライ上限に到達しました。');
    assert.deepEqual(await app.snapshot(), before); assert.deepEqual(result.lineage, running.lineage);
    const history = await readJson<{ jobs: TestJob[] }>(await app.request('/api/jobs'));
    assert.deepEqual(history.jobs.map(item => item.id), [job.id]);
    assert.deepEqual(app.calls, Array.from({ length: 3 }, () => inputs(result)));
    const recovered = new JobStore(app.store.directory); await recovered.initialize();
    const lineage = new LineageStore(app.lineagePath); await lineage.initialize(recovered);
    assert.equal(recovered.list().length, 1); assert.equal(recovered.get(job.id).status, result.status);
    assert.deepEqual(lineage.activeSnapshot(), before);
  }
});

test('ジョブ保存後・系譜保存前の停止から再生成と入力編集の出発点を復元する', async t => {
  let original!: Job, regeneration!: Job, edited!: Job;
  const app = await setup(t, { seed: async store => {
    original = await seedImage(store, { prompt: '保存済みの原案', createdAt: '2026-10-02T00:00:03.000Z' });
    regeneration = await seedImage(store, { prompt: original.prompt, createdAt: '2026-10-02T00:00:02.000Z', lineageIntent: { sourceJobId: original.id, operation: 'regenerate', newBranch: true } }, 'queued');
    edited = await seedImage(store, { prompt: '編集された案', createdAt: '2026-10-02T00:00:01.000Z', lineageIntent: { sourceJobId: regeneration.id, operation: 'edit', newBranch: true } }, 'queued');
    // Read initial job files as a restarted process would; do not continue queued work.
    const restarted = new JobStore(store.directory); await restarted.initialize();
    store.jobs = restarted.jobs;
  } });
  const graph = await app.snapshot(); assert.equal(graph.commits.length, 3);
  const recoveredRegeneration = graph.commits.find(commit => commit.jobId === regeneration.id);
  assert.equal(recoveredRegeneration!.operation, 'regenerate'); assert.equal(recoveredRegeneration!.sourceJobId, original.id); assert.deepEqual(recoveredRegeneration!.parentIds, []);
  const recoveredEdit = graph.commits.find(commit => commit.jobId === edited.id);
  assert.equal(recoveredEdit!.operation, 'edit'); assert.equal(recoveredEdit!.sourceJobId, regeneration.id); assert.deepEqual(recoveredEdit!.parentIds, []);
  assert.notEqual(recoveredEdit!.branchId, recoveredRegeneration!.branchId);
  const publicJobs = (await readJson<{ jobs: TestJob[] }>((await app.request('/api/jobs')))).jobs;
  assert.ok(publicJobs.every(job => !Object.hasOwn(job, 'lineageIntent')), 'サーバー用の復元情報を公開APIに混ぜない');
  assert.equal(publicJobs.find(job => job.id === regeneration.id)!.status, 'failed');
  assert.equal(publicJobs.find(job => job.id === edited.id)!.status, 'failed'); assert.equal(app.calls.length, 0);
  const reloaded = new LineageStore(app.lineagePath); await reloaded.initialize(app.store); assert.deepEqual(reloaded.activeSnapshot(), graph);
  assert.deepEqual(reloaded.snapshot().deletions, []);
});
