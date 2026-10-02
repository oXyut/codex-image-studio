import { mkdir, readdir, readFile, rename, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, safeMessage, validateBatchCount } from './validation.js';
import { generationError, publicFailure } from './generation-errors.js';
import { setTimeout as delay } from 'node:timers/promises';

const maxContentAttempts = 3;
const contentRetryLimitMessage = '3回のリトライ上限に到達しました。';

export class JobStore {
  constructor(directory) { this.directory = directory; this.jobs = new Map(); this.writes = new Map(); }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        const job = JSON.parse(await readFile(join(this.directory, entry.name, 'job.json'), 'utf8'));
        if (job.id !== entry.name) continue;
        this.jobs.set(job.id, job);
        if (['running', 'queued'].includes(job.status)) await this.update(job.id, { status: 'failed', error: { code: 'SERVER_RESTARTED', message: 'サーバーが停止したため生成を中断しました。再試行できます。' }, finishedAt: new Date().toISOString() });
      } catch (e) { if (e.code !== 'ENOENT') console.warn(`履歴 ${entry.name} を読み込めませんでした。`); }
    }
  }
  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { const job = this.jobs.get(id); if (!job) throw new AppError('画像が見つかりません。', 'NOT_FOUND', 404); return job; }
  workspace(id) { this.get(id); return join(this.directory, id, 'workspace'); }
  async imagePath(id) {
    this.lineage?.assertActive(id);
    const job = this.get(id);
    if (job.status !== 'succeeded' || !job.image || !/^image\.(png|jpg|webp)$/.test(job.image.fileName)) throw new AppError('参照する画像が見つかりません。', 'REFERENCE_NOT_FOUND', 400);
    const path = join(this.directory, id, job.image.fileName);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 30 * 1024 * 1024) throw new AppError('参照画像のファイルを確認してください。', 'INVALID_REFERENCE_IMAGE', 400);
    return path;
  }
  async create(input) {
    const job = { id: randomUUID(), ...input, favorite: false, status: 'queued', attempts: 0, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, message: '生成の空きを待っています。', error: null, image: null };
    await this.save(job); this.jobs.set(job.id, job); return job;
  }
  async setFavorite(id, favorite) {
    if (typeof favorite !== 'boolean') throw new AppError('お気に入りの状態を指定してください。', 'INVALID_FAVORITE', 400);
    this.lineage?.assertActive(id);
    const job = this.get(id);
    if (job.status !== 'succeeded' || !job.image || !/^image\.(png|jpg|webp)$/.test(job.image.fileName)) throw new AppError('完成した画像をお気に入りに選んでください。', 'IMAGE_NOT_READY', 400);
    return this.update(id, { favorite });
  }
  update(id, changes) {
    // Resolve the current value only when this job's preceding write finishes.
    // Progress, cancellation and completion must not overwrite each other's
    // fields or race over the same temporary file; unrelated jobs stay parallel.
    const write = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const job = { ...this.get(id), ...changes };
      await this.save(job); this.jobs.set(id, job); return job;
    });
    this.writes.set(id, write);
    const cleanup = () => { if (this.writes.get(id) === write) this.writes.delete(id); };
    write.then(cleanup, cleanup);
    return write;
  }
  async save(job) {
    const directory = join(this.directory, job.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'job.json.tmp'), JSON.stringify(job, null, 2), { mode: 0o600 });
    await rename(join(directory, 'job.json.tmp'), join(directory, 'job.json'));
  }
}

export class JobManager {
  constructor(store, adapter, { retryDelayMs = 1500, concurrency = 5, lineage, uploads } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new AppError('同時生成数は1〜10の整数で指定してください。', 'INVALID_GENERATION_CONCURRENCY', 400);
    this.store = store; this.adapter = adapter; this.queue = []; this.active = new Map(); this.closed = false;
    this.concurrency = concurrency;
    this.retryDelayMs = retryDelayMs;
    this.lineage = lineage;
    this.uploads = uploads;
    if (lineage) { this.store.lineage = lineage; if (uploads) uploads.lineage = lineage; }
    this.cancelledIds = new Set();
  }
  async enqueue(input, { regenerateFrom } = {}) {
    return (await this.stage(input, { regenerateFrom, count: 1 }))[0];
  }
  async enqueueBatch(input, count, { regenerateFrom } = {}) {
    validateBatchCount(count);
    const batchId = randomUUID();
    const jobs = await this.stage(input, { regenerateFrom, count, batchId });
    return { batchId, jobs };
  }
  async stage(input, { regenerateFrom, count, batchId }) {
    if (this.closed) throw new AppError('サーバーが停止しています。', 'SHUTTING_DOWN', 503);
    if (this.queue.length + count > 10) throw new AppError('待機中の生成が多すぎます。枚数を減らすか、完了してからお試しください。', 'QUEUE_FULL', 429);
    // Reserve the whole group synchronously. No member becomes runnable until
    // every recipe and ancestry record has been persisted.
    const reservations = Array.from({ length: count }, () => ({ pending: true }));
    this.queue.push(...reservations);
    const created = [];
    let savingLineage = false;
    try {
      const { lineageContext: suppliedContext, lineageIntent: _untrustedIntent, batch: _untrustedBatch, ...recipe } = structuredClone(input);
      const lineageContext = suppliedContext ? { ...suppliedContext, newBranch: count > 1 || Boolean(suppliedContext.newBranch) } :
        count > 1 && recipe.references?.length ? { sourceJobId: recipe.references[0].jobId ?? recipe.references[0].uploadId, operation: 'derive', newBranch: true } : undefined;
      const lineageIntent = regenerateFrom ? { sourceJobId: regenerateFrom, operation: 'regenerate', newBranch: true } :
        lineageContext ? { ...lineageContext } : recipe.references?.length ?
          { sourceJobId: recipe.references[0].jobId ?? recipe.references[0].uploadId, operation: 'derive', newBranch: false } :
          { sourceJobId: null, operation: 'generate', newBranch: false };
      for (const id of [...(recipe.references ?? []).map(reference => reference.jobId ?? reference.uploadId), lineageIntent.sourceJobId].filter(Boolean)) this.lineage?.assertActive(id);
      for (let index = 1; index <= count; index++) {
        if (this.closed) throw new AppError('サーバーが停止しています。', 'SHUTTING_DOWN', 503);
        created.push(await this.store.create({ ...structuredClone(recipe), ...(this.lineage ? { lineageIntent: { ...lineageIntent } } : {}),
          ...(batchId ? { batch: { id: batchId, index, count } } : {}) }));
      }
      savingLineage = true;
      for (const job of created) await this.lineage?.record(job, { context: lineageContext, regenerateFrom });
      if (this.closed) throw new AppError('サーバーが停止しています。', 'SHUTTING_DOWN', 503);
      for (const job of created) this.assertRunnable(this.store.get(job.id));
      for (const [index, reservation] of reservations.entries()) {
        const job = this.store.get(created[index].id);
        if (job.status === 'queued' && !this.cancelledIds.has(job.id)) this.queue[this.queue.indexOf(reservation)] = job.id;
      }
      this.drain(); return created.map(job => this.store.get(job.id));
    } catch (error) {
      const failedCode = batchId ? 'BATCH_SAVE_FAILED' : savingLineage ? 'LINEAGE_SAVE_FAILED' : 'JOB_SAVE_FAILED';
      for (const job of created) {
        if (this.cancelledIds.has(job.id) || this.store.get(job.id).status === 'cancelled') continue;
        try { await this.store.update(job.id, { status: 'failed', error: { code: failedCode, message: '生成の管理情報を保存できなかったため、生成を開始しませんでした。' },
          finishedAt: new Date().toISOString(), message: '生成を開始しませんでした。' }); }
        catch { /* The queue remains blocked even if the diagnostic write fails. */ }
      }
      throw error;
    } finally {
      const pending = new Set(reservations);
      this.queue = this.queue.filter(item => !pending.has(item));
    }
  }
  async cancel(id) {
    const job = this.store.get(id);
    if (!['queued', 'running'].includes(job.status)) return job;
    const active = this.active.get(id);
    if (active) { active.controller.abort(); await active.promise; return this.store.get(id); }
    // Remember cancellation before its disk write, including jobs whose batch
    // is still being staged and has not published queue IDs yet.
    this.cancelledIds.add(id);
    this.queue = this.queue.filter(x => x !== id);
    return this.store.update(id, { status: 'cancelled', message: '生成をキャンセルしました。', finishedAt: new Date().toISOString() });
  }
  async cancelMany(ids) {
    const selected = new Set(ids), active = [], queued = [];
    this.queue = this.queue.filter(item => !selected.has(item));
    for (const id of selected) {
      const job = this.store.get(id);
      if (!['queued', 'running'].includes(job.status)) continue;
      this.cancelledIds.add(id);
      const worker = this.active.get(id);
      if (worker) { worker.controller.abort(); active.push(worker); }
      else queued.push(id);
    }
    await Promise.all([...active.map(worker => worker.promise), ...queued.map(id => this.store.update(id,
      { status: 'cancelled', message: '画像の削除により生成をキャンセルしました。', finishedAt: new Date().toISOString() }))]);
  }
  async softDelete(rootId, planToken) {
    if (!this.lineage) throw new AppError('画像の系譜が見つかりません。', 'LINEAGE_NOT_FOUND', 404);
    return this.lineage.softDelete(rootId, planToken, { cancel: ids => this.cancelMany(ids) });
  }
  assertRunnable(job) {
    for (const id of [job.id, ...(job.references ?? []).map(reference => reference.jobId ?? reference.uploadId), job.lineageIntent?.sourceJobId].filter(Boolean)) this.lineage?.assertActive(id);
  }
  drain() {
    if (this.closed) return;
    while (this.active.size < this.concurrency) {
      const index = this.queue.findIndex(x => typeof x === 'string');
      if (index < 0) return;
      const id = this.queue.splice(index, 1)[0];
      if (this.cancelledIds.has(id) || this.store.get(id).status !== 'queued') continue;
      try { this.assertRunnable(this.store.get(id)); }
      catch (error) {
        if (error.code !== 'NODE_DELETED') throw error;
        this.cancelledIds.add(id);
        void this.store.update(id, { status: 'cancelled', message: '画像の削除により生成をキャンセルしました。', finishedAt: new Date().toISOString() })
          .catch(failure => console.error('削除による停止の保存に失敗しました:', failure.code || failure.name));
        continue;
      }
      const controller = new AbortController();
      const active = { id, controller, promise: null };
      this.active.set(id, active);
      active.promise = this.run(id, controller)
        .catch(error => console.error('ジョブの保存に失敗しました:', error.code || error.name))
        .finally(() => { this.active.delete(id); this.drain(); });
    }
  }
  async run(id, controller) {
    let progressWrites = Promise.resolve();
    try {
      this.assertRunnable(this.store.get(id));
      await this.store.update(id, { status: 'running', startedAt: new Date().toISOString(), message: 'Codexに接続しています。' });
      this.assertRunnable(this.store.get(id));
      const referenceImages = await Promise.all((this.store.get(id).references ?? []).map(async reference => {
        if (reference.uploadId && !this.uploads) throw new AppError('アップロード画像が見つかりません。', 'UPLOAD_NOT_FOUND', 404);
        return { ...reference, path: await (reference.uploadId ? this.uploads.imagePath(reference.uploadId) : this.store.imagePath(reference.jobId)) };
      }));
      let image, silentContentRetry = false;
      for (let attempt = 1; attempt <= maxContentAttempts; attempt++) {
        await this.store.update(id, { attempts: attempt });
        this.assertRunnable(this.store.get(id));
        if (controller.signal.aborted) throw new AppError('生成をキャンセルしました。', 'CANCELLED');
        try {
          let acceptingProgress = true;
          try {
            image = await this.adapter.generate(this.store.get(id), { workspace: this.store.workspace(id), signal: controller.signal, referenceImages,
              onProgress: message => {
                if (!acceptingProgress || silentContentRetry) return;
                progressWrites = progressWrites.then(() => this.store.update(id, { message: safeMessage(message) })).catch(() => {});
              } });
          } finally { acceptingProgress = false; }
          break;
        } catch (error) {
          const failure = generationError(error);
          const maxAttempts = failure.category === 'content' ? maxContentAttempts : 2;
          if (failure.category === 'content' && attempt >= maxAttempts && failure.autoRetryAllowed) failure.message = contentRetryLimitMessage;
          if (attempt >= maxAttempts || !failure.retryable || !failure.autoRetryAllowed || controller.signal.aborted) throw failure;
          await progressWrites;
          silentContentRetry ||= failure.category === 'content';
          const message = silentContentRetry
            ? '画像を生成しています。数分かかることがあります。'
            : '一時的なエラーのため、同じ入力で1回だけ再試行します。';
          await this.store.update(id, { message });
          await delay(this.retryDelayMs, undefined, { signal: controller.signal });
        }
      }
      await progressWrites;
      if (controller.signal.aborted) throw new AppError('生成をキャンセルしました。', 'CANCELLED');
      await this.store.update(id, { status: 'succeeded', image, message: '画像が完成しました。', finishedAt: new Date().toISOString() });
    } catch (error) {
      await progressWrites;
      const cancelled = controller.signal.aborted || error.code === 'CANCELLED' || error.code === 'NODE_DELETED';
      const failure = cancelled ? null : publicFailure(error);
      await this.store.update(id, { status: cancelled ? 'cancelled' : 'failed', message: cancelled ? '生成をキャンセルしました。' : failure.message,
        error: failure, finishedAt: new Date().toISOString() });
    }
  }
  async close() {
    this.closed = true;
    const active = [...this.active.values()];
    for (const job of active) job.controller.abort();
    const queued = this.queue.filter(id => typeof id === 'string');
    this.queue = [];
    await Promise.all([
      ...queued.map(id => this.store.update(id, { status: 'cancelled', message: 'サーバー停止によりキャンセルしました。', finishedAt: new Date().toISOString() })),
      ...active.map(job => job.promise),
    ]);
  }
}
