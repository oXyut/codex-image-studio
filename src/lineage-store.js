import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './validation.js';

const idPattern = /^[a-f0-9-]{36}$/;
const generationOperations = new Set(['generate', 'derive', 'edit', 'regenerate']);
const operations = new Set([...generationOperations, 'upload']);
const clone = value => structuredClone(value);
const missing = () => new AppError('画像の系譜が見つかりません。', 'LINEAGE_NOT_FOUND', 404);

function parentIds(job) {
  return [...new Set((Array.isArray(job.references) ? job.references : []).map(reference => reference?.jobId ?? reference?.uploadId)
    .filter(id => typeof id === 'string' && idPattern.test(id) && id !== job.id))];
}

function recipeHash(job) {
  return createHash('sha256').update(JSON.stringify({ prompt: job.prompt, size: job.size, style: job.style,
    transparent: job.transparent, references: job.references ?? [] })).digest('hex');
}

function titleFor(job) {
  return (job.basePrompt || job.prompt || '画像の生成').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function savedIntent(job) {
  const intent = job.lineageIntent;
  if (!intent || typeof intent !== 'object' || !generationOperations.has(intent.operation) || typeof intent.newBranch !== 'boolean' ||
    (intent.sourceJobId !== null && (typeof intent.sourceJobId !== 'string' || !idPattern.test(intent.sourceJobId) || intent.sourceJobId === job.id))) return null;
  if (intent.operation !== 'generate' && !intent.sourceJobId) return null;
  if (intent.operation === 'generate' && (intent.sourceJobId !== null || parentIds(job).length)) return null;
  if (intent.operation === 'derive' && !parentIds(job).includes(intent.sourceJobId)) return null;
  return intent;
}

function deterministicBranchId(jobId) {
  const hash = createHash('sha256').update(`codex-image-studio:lineage:${jobId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function checkedText(value, field, max, allowEmpty) {
  if (typeof value !== 'string' || value.trim().length > max || (!allowEmpty && !value.trim())) {
    throw new AppError(`${field}は${allowEmpty ? '0' : '1'}〜${max}文字で入力してください。`, 'INVALID_LINEAGE_ANNOTATION', 400);
  }
  return value.trim();
}

function checkState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.commits) || !Array.isArray(state.branches)) throw new Error('系譜データの形式を確認してください。');
  const branchIds = new Set();
  for (const branch of state.branches) {
    if (!branch || !idPattern.test(branch.id) || branchIds.has(branch.id) || typeof branch.name !== 'string' || !branch.name.trim() || branch.name.length > 80 ||
      (branch.headJobId !== null && !idPattern.test(branch.headJobId)) || typeof branch.createdAt !== 'string' || typeof branch.updatedAt !== 'string') throw new Error('系譜のブランチデータを確認してください。');
    branchIds.add(branch.id);
  }
  const jobIds = new Set();
  for (const commit of state.commits) {
    if (!commit || !idPattern.test(commit.jobId) || jobIds.has(commit.jobId) || !branchIds.has(commit.branchId) || !operations.has(commit.operation) ||
      !Array.isArray(commit.parentIds) || commit.parentIds.some(id => !idPattern.test(id) || id === commit.jobId) || new Set(commit.parentIds).size !== commit.parentIds.length ||
      (commit.sourceJobId !== null && !idPattern.test(commit.sourceJobId)) || typeof commit.title !== 'string' || commit.title.length > 100 || typeof commit.notes !== 'string' || commit.notes.length > 2000 || typeof commit.createdAt !== 'string') throw new Error('系譜の画像データを確認してください。');
    if (commit.operation === 'upload' && (commit.parentIds.length || commit.sourceJobId !== null)) throw new Error('アップロードした参照の起点を確認してください。');
    jobIds.add(commit.jobId);
  }
  if (state.deletions !== undefined) {
    if (!Array.isArray(state.deletions)) throw new Error('削除履歴の形式を確認してください。');
    const deletionIds = new Set();
    for (const deletion of state.deletions) {
      if (!deletion || !idPattern.test(deletion.id) || deletionIds.has(deletion.id) || !jobIds.has(deletion.rootId) ||
        typeof deletion.title !== 'string' || typeof deletion.deletedAt !== 'string' ||
        (deletion.scope !== undefined && deletion.scope !== 'nodes') ||
        (deletion.restoredAt !== null && typeof deletion.restoredAt !== 'string') ||
        !Array.isArray(deletion.nodeIds) || !deletion.nodeIds.includes(deletion.rootId) ||
        deletion.nodeIds.some(id => !jobIds.has(id)) || new Set(deletion.nodeIds).size !== deletion.nodeIds.length) throw new Error('削除履歴のデータを確認してください。');
      deletionIds.add(deletion.id);
    }
  }
}

// Both actual image references and recipe-origin links are downstream edges.
// A visited set also makes old cyclic metadata safe to inspect and delete.
function descendants(state, roots) {
  const children = new Map();
  for (const commit of state.commits) for (const parentId of new Set([...commit.parentIds, commit.sourceJobId].filter(Boolean))) {
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(commit.jobId);
  }
  const selected = new Set(roots), pending = [...selected];
  for (let index = 0; index < pending.length; index++) for (const childId of children.get(pending[index]) ?? []) {
    if (!selected.has(childId)) { selected.add(childId); pending.push(childId); }
  }
  return selected;
}

function deletedIds(state) {
  const active = (state.deletions ?? []).filter(deletion => !deletion.restoredAt);
  const hidden = descendants(state, active.filter(deletion => deletion.scope !== 'nodes').flatMap(deletion => deletion.nodeIds));
  for (const deletion of active) if (deletion.scope === 'nodes') for (const id of deletion.nodeIds) hidden.add(id);
  return hidden;
}

function expandDeletionGroups(state) {
  for (const deletion of state.deletions ?? []) {
    if (deletion.restoredAt) continue;
    if (deletion.scope !== 'nodes') deletion.nodeIds = [...descendants(state, deletion.nodeIds)].sort();
    deletion.uploadCount = deletion.nodeIds.filter(id => state.commits.find(commit => commit.jobId === id)?.operation === 'upload').length;
    deletion.jobCount = deletion.nodeIds.length - deletion.uploadCount;
  }
}

const deleted = () => new AppError('この画像は削除済みです。ゴミ箱から復元してからお試しください。', 'NODE_DELETED', 410);

/** Metadata lives separately from image jobs. Serial writes keep branch heads consistent. */
export class LineageStore {
  constructor(path) { this.path = path; this.state = { version: 1, commits: [], branches: [], deletions: [] }; this.writes = Promise.resolve(); this.pendingDeletionIds = new Set(); }
  async initialize(jobs, uploads = []) {
    let needsSave = false;
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      checkState(state);
      if (state.deletions === undefined) { state.deletions = []; needsSave = true; }
      if (state.deletions.some(deletion => !deletion.restoredAt)) needsSave = true;
      this.state = state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      needsSave = true;
    }
    // An upload can survive a crash before its lineage metadata is written. Recover
    // these roots first so every generated reference can inherit the correct branch.
    const uploadedImages = (Array.isArray(uploads) ? uploads : uploads.list()).filter(upload => !this.get(upload.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const pending = jobs.list().filter(job => !this.get(job.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    // Visit known references first even when a legacy history has inconsistent dates.
    const pendingById = new Map(pending.map(job => [job.id, job]));
    const visiting = new Set();
    const visited = new Set();
    const ordered = [];
    const visit = job => {
      if (visited.has(job.id) || visiting.has(job.id)) return;
      visiting.add(job.id);
      for (const id of parentIds(job)) if (pendingById.has(id)) visit(pendingById.get(id));
      const sourceJobId = savedIntent(job)?.sourceJobId;
      if (pendingById.has(sourceJobId)) visit(pendingById.get(sourceJobId));
      visiting.delete(job.id); visited.add(job.id); ordered.push(job);
    };
    pending.forEach(visit);
    if (uploadedImages.length || ordered.length || needsSave) await this.mutate(state => {
      for (const upload of uploadedImages) this.addUpload(state, upload);
      for (const job of ordered) this.addCommit(state, job, { migration: true });
      expandDeletionGroups(state);
      return state;
    });
    return this.snapshot();
  }
  snapshot() { return clone(this.state); }
  get(jobId) { return clone(this.state.commits.find(commit => commit.jobId === jobId) ?? null); }
  hiddenIds() {
    if (this.cachedDeletionState !== this.state) { this.cachedDeletionState = this.state; this.cachedDeletedIds = deletedIds(this.state); }
    return this.cachedDeletedIds;
  }
  isDeleted(jobId) { return this.pendingDeletionIds.has(jobId) || this.hiddenIds().has(jobId); }
  assertActive(jobId) { if (this.isDeleted(jobId)) throw deleted(); }
  isVisible(jobId) { return Boolean(this.get(jobId)) && !this.isDeleted(jobId); }
  activeSnapshot() {
    const hidden = new Set(this.hiddenIds());
    for (const id of this.pendingDeletionIds) hidden.add(id);
    const commits = this.state.commits.filter(commit => !hidden.has(commit.jobId));
    const branches = this.state.branches.filter(branch => commits.some(commit => commit.branchId === branch.id)).map(branch => {
      const members = commits.filter(commit => commit.branchId === branch.id);
      const head = members.find(commit => commit.jobId === branch.headJobId) ?? members.at(-1);
      return { ...branch, headJobId: head.jobId };
    });
    return clone({ version: this.state.version, commits, branches });
  }
  async mutate(change) {
    const write = this.writes.then(async () => {
      const next = clone(this.state);
      const result = await change(next);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(`${this.path}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      this.state = next;
      return clone(result);
    });
    this.writes = write.catch(() => {});
    return write;
  }
  addCommit(state, job, { context, regenerateFrom, migration = false } = {}) {
    const existing = state.commits.find(commit => commit.jobId === job.id);
    if (existing) return existing;
    const parents = parentIds(job);
    const intent = savedIntent(job);
    const inferredSource = parents.find(id => state.commits.some(commit => commit.jobId === id)) ?? null;
    const sourceJobId = regenerateFrom ?? context?.sourceJobId ?? intent?.sourceJobId ?? inferredSource;
    const source = state.commits.find(commit => commit.jobId === sourceJobId);
    if (!migration && sourceJobId && !source) throw missing();
    if (!migration) {
      const hidden = deletedIds(state);
      if ([...parents, sourceJobId].filter(Boolean).some(id => hidden.has(id) || this.pendingDeletionIds.has(id))) throw deleted();
    }
    const operation = regenerateFrom ? 'regenerate' : context?.operation ?? intent?.operation ?? (parents.length ? 'derive' : 'generate');
    let branch = state.branches.find(candidate => candidate.id === source?.branchId);
    if (!branch || operation === 'edit' || operation === 'regenerate' || context?.newBranch || intent?.newBranch || branch.headJobId !== sourceJobId) {
      const createdAt = job.createdAt;
      branch = { id: migration ? deterministicBranchId(job.id) : randomUUID(), name: `ブランチ ${state.branches.length + 1}`,
        headJobId: null, createdAt, updatedAt: createdAt };
      state.branches.push(branch);
    }
    const commit = { jobId: job.id, branchId: branch.id, parentIds: parents, sourceJobId, operation,
      title: titleFor(job), notes: '', createdAt: job.createdAt, recipeHash: recipeHash(job) };
    state.commits.push(commit); branch.headJobId = job.id; branch.updatedAt = branch.updatedAt > job.createdAt ? branch.updatedAt : job.createdAt;
    return commit;
  }
  async record(job, options = {}) { return this.mutate(state => this.addCommit(state, job, options)); }
  addUpload(state, upload) {
    const existing = state.commits.find(commit => commit.jobId === upload.id);
    if (existing) return existing;
    const createdAt = upload.createdAt;
    const branch = { id: deterministicBranchId(upload.id), name: `参照の起点 ${state.branches.length + 1}`,
      headJobId: upload.id, createdAt, updatedAt: createdAt };
    const commit = { jobId: upload.id, branchId: branch.id, parentIds: [], sourceJobId: null, operation: 'upload',
      title: (upload.name || 'アップロードした画像').replace(/\s+/g, ' ').trim().slice(0, 100), notes: '', createdAt };
    state.branches.push(branch); state.commits.push(commit); return commit;
  }
  async recordUpload(upload) { return this.mutate(state => this.addUpload(state, upload)); }
  failedDeletionPreview(jobs, state = this.state) {
    const hidden = deletedIds(state), commits = new Map(state.commits.map(commit => [commit.jobId, commit]));
    const nodes = jobs.list().filter(job => job.status === 'failed' && commits.has(job.id) &&
      commits.get(job.id).operation !== 'upload' && !hidden.has(job.id) && !this.pendingDeletionIds.has(job.id))
      .map(job => ({ id: job.id, title: commits.get(job.id).title, status: job.status })).sort((a, b) => a.id.localeCompare(b.id));
    const planToken = createHash('sha256').update(JSON.stringify({ scope: 'failed', nodeIds: nodes.map(node => node.id) })).digest('hex');
    return { planToken, nodes, count: nodes.length };
  }
  async softDeleteFailed(jobs, planToken) {
    if (typeof planToken !== 'string' || !/^[a-f0-9]{64}$/.test(planToken)) throw new AppError('削除する画像を確認してからお試しください。', 'INVALID_DELETE_PLAN', 400);
    const pending = new Set();
    try {
      return await this.mutate(state => {
        const plan = this.failedDeletionPreview(jobs, state);
        if (plan.planToken !== planToken) throw new AppError('削除対象が変わりました。対象をもう一度確認してください。', 'DELETE_PLAN_CHANGED', 409);
        if (!plan.count) return { deletionId: null, deletedIds: [], count: 0 };
        const nodeIds = plan.nodes.map(node => node.id);
        for (const id of nodeIds) { pending.add(id); this.pendingDeletionIds.add(id); }
        const deletion = { id: randomUUID(), rootId: nodeIds[0], title: `エラー画像 ${plan.count}件`, scope: 'nodes',
          deletedAt: new Date().toISOString(), restoredAt: null, nodeIds, jobCount: plan.count, uploadCount: 0 };
        state.deletions.push(deletion);
        return { deletionId: deletion.id, deletedIds: nodeIds, count: plan.count };
      });
    } finally { for (const id of pending) this.pendingDeletionIds.delete(id); }
  }
  deletionPlan(rootId, state = this.state) {
    const root = state.commits.find(commit => commit.jobId === rootId);
    if (!root) throw missing();
    const hidden = deletedIds(state);
    if (hidden.has(rootId) || this.pendingDeletionIds.has(rootId)) throw deleted();
    const allIds = [...descendants(state, [rootId])].sort();
    const visibleIds = allIds.filter(id => !hidden.has(id));
    const planToken = createHash('sha256').update(JSON.stringify({ rootId, allIds, hiddenIds: allIds.filter(id => hidden.has(id)),
      activeDeletions: (state.deletions ?? []).filter(deletion => !deletion.restoredAt).map(deletion => deletion.id).sort() })).digest('hex');
    return { rootId, planToken, allIds, visibleIds, alreadyDeletedCount: allIds.length - visibleIds.length };
  }
  deletionPreview(rootId, jobs, uploads) {
    const plan = this.deletionPlan(rootId);
    const nodes = plan.visibleIds.map(id => {
      const commit = this.get(id);
      const item = commit.operation === 'upload' ? uploads?.get(id) : jobs.get(id);
      const kind = commit.operation === 'upload' ? 'upload' : 'job';
      return { id, kind, title: commit.title, status: item?.status ?? 'uploaded',
        ...(item?.image ? { image: { url: `/api/${kind === 'upload' ? 'uploads' : 'jobs'}/${id}/image`, mime: item.image.mime } } : {}) };
    });
    return { rootId, planToken: plan.planToken, nodes, count: nodes.length, jobCount: nodes.filter(node => node.kind === 'job').length,
      uploadCount: nodes.filter(node => node.kind === 'upload').length, activeCount: nodes.filter(node => ['queued', 'running'].includes(node.status)).length,
      alreadyDeletedCount: plan.alreadyDeletedCount };
  }
  async softDelete(rootId, planToken, { cancel } = {}) {
    if (typeof planToken !== 'string' || !/^[a-f0-9]{64}$/.test(planToken)) throw new AppError('削除する画像を確認してからお試しください。', 'INVALID_DELETE_PLAN', 400);
    const pending = new Set();
    try {
      return await this.mutate(async state => {
        const plan = this.deletionPlan(rootId, state);
        if (plan.planToken !== planToken) throw new AppError('削除対象が変わりました。対象をもう一度確認してください。', 'DELETE_PLAN_CHANGED', 409);
        for (const id of plan.allIds) { pending.add(id); this.pendingDeletionIds.add(id); }
        // Abort every affected worker before waiting for any worker to stop.
        // Metadata commits remain serialized while cancellation is in progress.
        const jobIds = plan.allIds.filter(id => state.commits.find(commit => commit.jobId === id).operation !== 'upload');
        await cancel?.(jobIds);
        const root = state.commits.find(commit => commit.jobId === rootId);
        const deletion = { id: randomUUID(), rootId, title: root.title, deletedAt: new Date().toISOString(), restoredAt: null,
          nodeIds: plan.allIds, jobCount: jobIds.length, uploadCount: plan.allIds.length - jobIds.length };
        state.deletions.push(deletion);
        const visibleJobs = plan.visibleIds.filter(id => state.commits.find(commit => commit.jobId === id).operation !== 'upload');
        return { deletionId: deletion.id, rootId, deletedIds: plan.visibleIds, count: plan.visibleIds.length,
          jobCount: visibleJobs.length, uploadCount: plan.visibleIds.length - visibleJobs.length, alreadyDeletedCount: plan.alreadyDeletedCount };
      });
    } finally { for (const id of pending) this.pendingDeletionIds.delete(id); }
  }
  trash() {
    return clone(this.state.deletions.filter(deletion => !deletion.restoredAt).map(({ restoredAt, nodeIds, ...deletion }) =>
      ({ ...deletion, nodeIds, nodeCount: nodeIds.length })).reverse());
  }
  async restore(deletionId) {
    return this.mutate(state => {
      const deletion = state.deletions.find(item => item.id === deletionId);
      if (!deletion) throw new AppError('削除履歴が見つかりません。', 'DELETION_NOT_FOUND', 404);
      expandDeletionGroups(state);
      const before = deletedIds(state);
      deletion.restoredAt ||= new Date().toISOString();
      const after = deletedIds(state);
      const restoredIds = deletion.nodeIds.filter(id => before.has(id) && !after.has(id));
      const stillDeletedIds = deletion.nodeIds.filter(id => after.has(id));
      return { deletionId, restoredIds, stillDeletedIds, count: restoredIds.length };
    });
  }
  async annotate(jobId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['title', 'notes'].includes(key)) || !Object.keys(input).length) throw new AppError('タイトルまたはメモを指定してください。', 'INVALID_LINEAGE_ANNOTATION', 400);
    const changes = {};
    if (Object.hasOwn(input, 'title')) changes.title = checkedText(input.title, 'タイトル', 100, false);
    if (Object.hasOwn(input, 'notes')) changes.notes = checkedText(input.notes, 'メモ', 2000, true);
    return this.mutate(state => {
      const commit = state.commits.find(item => item.jobId === jobId);
      if (!commit) throw missing();
      if (deletedIds(state).has(jobId) || this.pendingDeletionIds.has(jobId)) throw deleted();
      Object.assign(commit, changes); return commit;
    });
  }
  async renameBranch(branchId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'name')) throw new AppError('ブランチ名を指定してください。', 'INVALID_BRANCH_NAME', 400);
    const name = checkedText(input.name, 'ブランチ名', 80, false);
    return this.mutate(state => {
      const branch = state.branches.find(item => item.id === branchId);
      if (!branch) throw new AppError('ブランチが見つかりません。', 'LINEAGE_NOT_FOUND', 404);
      branch.name = name; branch.updatedAt = new Date().toISOString(); return branch;
    });
  }
}
