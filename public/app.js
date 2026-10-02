import { studioFeatures } from './studio-features.js';
import { createLineageView } from './lineage-view.js';
import { canvasSizeLabel, normalizeCanvasSize } from './canvas-options.js';
import { createDeletionUI, batchVisibility } from './deletion-ui.js';
import { groupGenerationHistory } from './batch-groups.js';
const $ = selector => document.querySelector(selector);
const state = { token: null, health: null, jobs: [], selected: null, filter: 'all', query: '', submitting: false, polling: false };
const statusNames = { queued: '待機中', running: '生成中', succeeded: '完成', failed: 'エラー', cancelled: 'キャンセル' };
const pendingActions = new Set();
let renderedGrid = '', renderedPreview = '', toastTimer, jobsRefreshPromise;
const emptyCanvas = $('#canvas').cloneNode(true), emptyPreviewMeta = $('#preview-meta').cloneNode(true);

function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
async function api(path, options = {}, renewed = false) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': state.token || '', ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    if (data.error?.code === 'INVALID_SESSION' && !renewed) { state.token = (await api('/api/session')).token; return api(path, options, true); }
    throw Object.assign(new Error(data.error?.message || '通信に失敗しました。'), { code: data.error?.code, status: response.status });
  }
  return data;
}
function toast(message) { const target = $('dialog[open]') || document.body; target.append($('#toast')); $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000); }
const features = studioFeatures({ api, toast, changed: updateCount, getJobs: () => state.jobs, getBatchCount: () => validBatchCount() || 1, onDerive: job => reuse(job, { derive: true }), onRegenerate: job => act(job.id, 'retry'), onDelete: job => deletion.open(job), onUploadsChanged: () => lineage.refresh() });
const lineage = createLineageView({ api, toast, getJobs: () => state.jobs, getBatchCount: () => validBatchCount() || 1, onSelect: job => { if (job?.kind !== 'upload') { state.selected = job?.id; if (job?.batch) state.batchId = job.batch.id; render(); } }, onDerive: job => reuse(job, { derive: true }), onRegenerate: job => act(job.id, 'retry'), onEdit: job => reuse(job), onPreview: job => features.openPreview(job), onDelete: job => deletion.open(job) });
const deletion = createDeletionUI({ api, toast, onChanged: async result => {
  const deleted = new Set(result.deletedIds || []);
  if (deleted.size) {
    state.jobs = state.jobs.filter(job => !deleted.has(job.id));
    if (deleted.has(state.selected)) state.selected = state.jobs[0]?.id || null;
    features.removeNodes(deleted);
    renderedGrid = ''; renderedPreview = ''; render();
  }
  await refreshJobs(true);
  await features.refreshUploads();
  await lineage.refresh();
  renderedGrid = ''; renderedPreview = ''; render();
} });
function validBatchCount() { const count = Number($('#batch-count').value); return Number.isInteger(count) && count >= 1 && count <= 10 ? count : null; }
function requestedCount() { const count = validBatchCount(); if (!count) throw new Error('生成件数は1〜10の整数で指定してください。'); return count; }
function updateCount() { $('#prompt-count').textContent = $('#prompt').value.length.toLocaleString('ja-JP'); features.updateSummary(); updateGenerate(); document.querySelectorAll('[data-count]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.count) === validBatchCount()))); renderedPreview = ''; if (state.jobs.length) render(); }
function updateGenerate() {
  const prompt = features.fullPrompt();
  const count = validBatchCount();
  $('#generate-button').disabled = !state.health?.ready || state.submitting || features.isUploading?.() || !state.token || !prompt || prompt.length > 12000 || !count;
  $('#generate-label').textContent = features.isUploading?.() ? '参照画像を保存中…' : state.submitting ? '生成を依頼中…' : count > 1 ? `${count}件まとめて生成する` : '画像を生成する';
}
async function refreshHealth(force = false) {
  try {
    state.health = await api(`/api/health${force ? '?refresh=1' : ''}`);
    $('#connection').className = `connection ${state.health.ready ? 'ready' : 'error'}`;
    $('#connection-label').textContent = state.health.ready ? 'ChatGPT 接続済み' : '接続の確認が必要';
    $('#connection').title = `${state.health.version || 'Codex CLI'} · ${state.health.message}`;
    $('#health-notice').hidden = state.health.ready;
    $('#health-notice').textContent = state.health.message;
  } catch { state.health = null; $('#connection').className = 'connection error'; $('#connection-label').textContent = 'サーバーに接続できません'; $('#health-notice').hidden = false; $('#health-notice').textContent = 'サーバーとの接続が切れました。起動状態を確認して、ページを再読み込みしてください。'; }
  updateGenerate();
}

async function refreshJobs(force = false) {
  if (jobsRefreshPromise) { await jobsRefreshPromise; if (!force) return; }
  jobsRefreshPromise = loadJobs().finally(() => { jobsRefreshPromise = null; });
  return jobsRefreshPromise;
}
async function loadJobs() {
  state.polling = true;
  try {
    const { jobs } = await api('/api/jobs'); const referenceKey = JSON.stringify(jobs.map(job => [job.id, job.image?.url, job.lineage?.title])); state.jobs = jobs;
    if (referenceKey !== state.referenceKey) { state.referenceKey = referenceKey; features.jobsChanged(); }
    if (!jobs.some(job => job.id === state.selected)) state.selected = jobs[0]?.id || null;
    render();
    const graphKey = JSON.stringify(jobs.map(job => [job.id, job.lineage]));
    if (graphKey !== state.graphKey && Date.now() - (state.graphAttempt || 0) > 15000) {
      state.graphAttempt = Date.now();
      try { await lineage.refresh(); state.graphKey = graphKey; state.graphAttempt = 0; }
      catch { /* Keep the current graph while a transient metadata request fails. */ }
    }
  } catch { /* A transient polling failure is shown by the periodic connection check. */ }
  finally { state.polling = false; }
}

function render() {
  $('#job-count').textContent = state.jobs.length;
  renderBatchProgress();
  const jobs = state.jobs.filter(job => (!state.batchFilter || job.batch?.id === state.batchFilter) && (state.filter === 'all' || (state.filter === 'active' ? ['queued', 'running'].includes(job.status) : job.status === state.filter)) && `${job.prompt} ${job.lineage?.title || ''} ${job.lineage?.notes || ''}`.toLowerCase().includes(state.query.toLowerCase()));
  const gridKey = JSON.stringify([jobs.map(j => [j.id, j.status, j.lineage?.title, j.batch]), state.selected, validBatchCount()]);
  if (gridKey !== renderedGrid) {
    renderedGrid = gridKey;
    const grid = $('#job-grid'); grid.replaceChildren();
    for (const group of groupGenerationHistory(jobs, state.jobs)) {
      const groupSection = element('section', `history-group${group.kind === 'batch' ? ' history-batch' : ' history-singles'}`);
      const groupGrid = element('div', 'history-group-grid');
      if (group.kind === 'batch') {
        groupSection.dataset.batchId = group.id;
        const date = new Date(group.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        groupSection.setAttribute('aria-label', `同時作成グループ #${group.id.slice(0, 6)} · ${group.total}件 · ${date}`);
        const header = element('div', 'history-batch-header');
        const copy = element('div', 'history-batch-copy');
        copy.append(element('h3', '', `同時作成 · ${group.total}件`), element('p', 'history-batch-meta', `${date} · グループ #${group.id.slice(0, 6)}`));
        const count = element('span', 'history-batch-count', `${group.jobs.length === group.total ? `${group.total}件を表示` : `表示 ${group.jobs.length} / 全${group.total}件`}${group.deleted ? ` · 削除 ${group.deleted}` : ''}${group.missing ? ` · 未受付 ${group.missing}` : ''}`);
        const graphButton = element('button', 'action', '系統図で見る'); graphButton.type = 'button'; graphButton.setAttribute('aria-label', `同時作成 #${group.id.slice(0, 6)}を系統図で見る`);
        graphButton.addEventListener('click', () => { lineage.showBatch(group.id); $('#lineage-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        header.append(copy, count, graphButton); groupSection.append(header);
      }
      for (const job of group.jobs) {
        const card = element('article', `job-card ${state.selected === job.id ? 'selected' : ''}`);
        const select = element('button'); select.type = 'button'; select.setAttribute('aria-label', `${statusNames[job.status]}: ${job.prompt}${group.kind === 'batch' ? ` · 同時作成 #${group.id.slice(0, 6)} ${job.batch.index}/${job.batch.count}` : ''}`); select.setAttribute('aria-pressed', String(state.selected === job.id));
        if (job.image) { const image = element('img'); image.src = job.image.url; image.alt = job.prompt; image.loading = 'lazy'; select.append(image); }
        else select.append(element('div', 'card-placeholder', job.status === 'running' ? '✧ 描いています…' : statusNames[job.status]));
        select.append(element('span', `card-status ${job.status}`, statusNames[job.status]));
        if (group.kind === 'batch') select.append(element('span', 'card-batch-index', `${job.batch.index} / ${job.batch.count}`));
        select.addEventListener('click', () => { state.selected = job.id; if (job.batch) state.batchId = job.batch.id; render(); if (job.image) features.openPreview(job); });
        const content = element('div', 'card-content'); content.append(element('p', '', job.lineage?.title || job.prompt));
        const meta = element('div'); meta.append(element('span', '', new Date(job.createdAt).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })), element('span', '', canvasSizeLabel(job.size))); content.append(meta);
        if (group.kind === 'batch') content.append(element('span', 'batch-item-label', `同時作成 #${group.id.slice(0, 6)} · ${job.batch.index} / ${job.batch.count}`));
        const graphLink = element('button', 'text-button gallery-lineage-link', `派生を表示 · ${job.id.slice(0, 8)}`); graphLink.type = 'button'; graphLink.addEventListener('click', () => { state.selected = job.id; if (job.batch) state.batchId = job.batch.id; render(); lineage.select(job.id, { focus: true }); $('#lineage-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); }); content.append(graphLink);
        const actions = element('div', 'card-actions');
        if (job.image) { addAction(actions, 'この画像から派生', () => reuse(job, { derive: true })); addAction(actions, validBatchCount() > 1 ? `${validBatchCount()}件再生成` : '再生成', () => act(job.id, 'retry')); addAction(actions, '入力を再利用', () => reuse(job)); }
        addAction(actions, '削除', () => deletion.open(job), 'danger'); content.append(actions);
        card.append(select, content); groupGrid.append(card);
      }
      groupSection.append(groupGrid); grid.append(groupSection);
    }
    $('#library-empty').hidden = jobs.length > 0;
    $('#library-empty p').firstChild.textContent = state.jobs.length ? '該当する作品がありません。' : 'まだ作品はありません。';
    $('#library-empty small').textContent = state.jobs.length ? 'フィルターや検索条件を変更してください。' : '最初のアイデアを、かたちにしてみましょう。';
  }
  const job = state.jobs.find(j => j.id === state.selected);
  const previewKey = JSON.stringify(job);
  if (job && previewKey !== renderedPreview) { renderedPreview = previewKey; renderPreview(job); }
  else if (!job && renderedPreview !== 'empty') { renderedPreview = 'empty'; const canvas = $('#canvas'); canvas.className = emptyCanvas.className; canvas.replaceChildren(...[...emptyCanvas.childNodes].map(child => child.cloneNode(true))); $('#preview-meta').replaceChildren(...[...emptyPreviewMeta.childNodes].map(child => child.cloneNode(true))); $('#preview-actions').replaceChildren(); $('#preview-actions').hidden = true; }
  lineage.render();
}

function renderPreview(job) {
  const canvas = $('#canvas'); canvas.replaceChildren(); canvas.className = `canvas ${job.image ? 'has-image' : ''}`;
  const actions = $('#preview-actions'); actions.replaceChildren(); actions.hidden = false;
  if (job.status === 'succeeded' && job.image) {
    const preview = element('button', 'canvas-image-button'); preview.type = 'button'; preview.setAttribute('aria-label', '画像を拡大プレビュー'); const image = element('img'); image.src = job.image.url; image.alt = job.prompt; preview.append(image); preview.addEventListener('click', () => features.openPreview(job)); canvas.append(preview);
    const download = element('a', 'action primary', '↓ ダウンロード'); download.href = job.image.downloadUrl; download.download = ''; actions.append(download);
    addAction(actions, 'この画像から派生', () => reuse(job, { derive: true }));
    addAction(actions, validBatchCount() > 1 ? `同じ入力で${validBatchCount()}件再生成` : '同じ入力で再生成', () => act(job.id, 'retry'));
    addAction(actions, '入力を編集して別案', () => reuse(job));
  } else {
    const panel = element('div', `canvas-progress ${job.status === 'failed' ? 'failed' : ''}`);
    if (['queued', 'running'].includes(job.status)) { panel.append(element('div', 'loader')); panel.append(element('h3', '', job.status === 'queued' ? '生成の空きを待っています。' : 'イメージを描いています。')); panel.append(element('p', '', job.message)); panel.append(element('small', '', '生成には数分かかることがあります。ページを閉じても生成は続きます。')); addAction(actions, '生成をキャンセル', () => act(job.id, 'cancel')); }
    else {
      panel.append(element('span', '', job.status === 'failed' ? '↻' : '◌'), element('h3', '', job.status === 'failed' ? '画像を生成できませんでした。' : '生成をキャンセルしました。'), element('p', '', job.error?.message || 'アイデアは履歴に保存されています。'));
      if (job.error?.advice) panel.append(element('small', '', job.error.advice));
      if (job.status === 'failed') {
        const details = element('details', 'failure-details');
        details.append(element('summary', '', 'エラーの詳細'), element('p', '', job.error?.details || 'この履歴には詳しい理由が保存されていません。入力は保持されています。'));
        details.append(element('small', '', `エラーコード: ${job.error?.code || 'UNKNOWN'}`));
        panel.append(details);
      }
      if (job.error?.category === 'content') addAction(actions, '内容を編集して再試行', () => reuse(job), 'primary');
      else { addAction(actions, 'もう一度生成', () => act(job.id, 'retry'), 'primary'); addAction(actions, '入力を編集', () => reuse(job)); }
    }
    canvas.append(panel);
  }
  addAction(actions, '削除', () => deletion.open(job), 'danger');
  $('#preview-meta').replaceChildren(element('span', '', statusNames[job.status].toUpperCase()), element('span', '', `${canvasSizeLabel(job.size)}${job.batch ? ` · 同時作成 #${job.batch.id.slice(0, 6)} ${job.batch.index}/${job.batch.count}` : ''}${job.transparent ? ' · 透過背景をリクエスト' : ''}${job.image ? ` · ${(job.image.bytes / 1024 / 1024).toFixed(1)} MB` : ''}`));
}

function renderBatchProgress() {
  const groups = new Map();
  for (const job of state.jobs) if (job.batch) { if (!groups.has(job.batch.id)) groups.set(job.batch.id, []); groups.get(job.batch.id).push(job); }
  const choicesKey = JSON.stringify([...groups].map(([id, jobs]) => [id, jobs.length, batchVisibility(jobs)]));
  const filter = $('#batch-filter');
  if (filter.dataset.key !== choicesKey) {
    filter.dataset.key = choicesKey; filter.replaceChildren(element('option', '', 'すべての生成'));
    filter.firstChild.value = '';
    for (const [id, jobs] of groups) { const { total, deleted } = batchVisibility(jobs); const option = element('option', '', `${new Date(jobs[0].createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${total}件${deleted ? `（削除 ${deleted}）` : ''} · ${id.slice(0, 6)}`); option.value = id; filter.append(option); }
    if (!groups.has(state.batchFilter)) state.batchFilter = ''; filter.value = state.batchFilter || '';
  }
  filter.hidden = !groups.size;
  if (!state.batchId || !groups.has(state.batchId)) state.batchId = groups.keys().next().value;
  const jobs = (groups.get(state.batchId) || []).sort((a, b) => a.batch.index - b.batch.index);
  const panel = $('#batch-progress'); panel.hidden = !jobs.length; if (!jobs.length) return;
  const key = JSON.stringify([state.batchId, jobs.map(j => [j.id, j.status, j.image?.url, j.batch?.deletedCount]), pendingActions.has(`batch/${state.batchId}`)]);
  if (panel.dataset.key === key) return; panel.dataset.key = key; panel.replaceChildren();
  const counts = Object.fromEntries(Object.keys(statusNames).map(status => [status, jobs.filter(j => j.status === status).length]));
  const finished = counts.succeeded + counts.failed + counts.cancelled;
  const { total, deleted, missing } = batchVisibility(jobs);
  const head = element('div', 'feature-heading'); head.append(element('h3', '', `同時作成 #${state.batchId.slice(0, 6)} · ${jobs[0].batch.count}件`));
  const filterButton = element('button', 'text-button', 'このグループを履歴で見る ↓'); filterButton.type = 'button'; filterButton.addEventListener('click', () => { state.batchFilter = state.batchId; filter.value = state.batchId; render(); $('.library').scrollIntoView({ behavior: 'smooth', block: 'start' }); }); head.append(filterButton); panel.append(head);
  const progress = element('progress'); progress.max = total; progress.value = finished + deleted + (!counts.queued && !counts.running ? missing : 0); progress.setAttribute('aria-label', 'まとめ生成の完了件数'); panel.append(progress);
  const status = element('p', 'feature-hint', `完成 ${counts.succeeded} · 生成中 ${counts.running} · 待機 ${counts.queued} · エラー ${counts.failed} · キャンセル ${counts.cancelled}${deleted ? ` · 削除 ${deleted}` : ''}${missing ? ` · 未受付 ${missing}` : ''}`); status.setAttribute('role', 'status'); panel.append(status);
  const list = element('div', 'batch-results');
  for (const job of jobs) { const choice = element('button', `batch-result ${job.status}`); choice.type = 'button'; choice.setAttribute('aria-label', `まとめ生成の${job.batch.index}件目 · ${statusNames[job.status]}`); if (job.image) { const image = element('img'); image.src = job.image.url; image.alt = ''; choice.append(image); } else choice.append(element('span', 'batch-result-placeholder', job.batch.index)); choice.append(element('span', '', `${job.batch.index}. ${statusNames[job.status]}`)); choice.addEventListener('click', () => { state.selected = job.id; render(); lineage.select(job.id, { focus: true }); $('#lineage-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); }); list.append(choice); }
  panel.append(list);
  if (counts.running + counts.queued) {
    const cancel = element('button', 'action', 'このグループの残りをキャンセル'); cancel.type = 'button'; cancel.disabled = pendingActions.has(`batch/${state.batchId}`);
    cancel.addEventListener('click', async () => { const batchId = state.batchId, actionKey = `batch/${batchId}`; if (pendingActions.has(actionKey)) return; pendingActions.add(actionKey); renderBatchProgress(); try { const remaining = state.jobs.filter(j => j.batch?.id === batchId && ['running', 'queued'].includes(j.status)).sort((a, b) => Number(a.status === 'running') - Number(b.status === 'running')); for (const job of remaining) await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }); await refreshJobs(true); toast('残りの生成をキャンセルしました。'); } catch (error) { toast(error.message); } finally { pendingActions.delete(actionKey); renderBatchProgress(); } }); panel.append(cancel);
  }
}

function addAction(parent, text, handler, extra = '') { const button = element('button', `action ${extra}`, text); button.type = 'button'; button.addEventListener('click', async () => { button.disabled = true; try { await handler(); } catch (error) { toast(error.message); } finally { button.disabled = false; } }); parent.append(button); }
function reuse(job, options = {}) {
  if (!job) return;
  if (job.kind === 'upload') {
    features.restoreUpload(job); updateCount(); $('#prompt').focus(); $('#generate-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('アップロード画像を起点に設定しました。変更したい内容を入力してください。'); return;
  }
  if (options.derive && (!job.image || job.status !== 'succeeded')) { toast('完成した画像から派生できます。'); return; }
  $(`input[name=size][value=${normalizeCanvasSize(job.size)}]`).checked = true; $('#style').value = job.style; $('#transparent').checked = job.transparent; features.restoreJob(job, options); updateCount(); $('#prompt').focus(); $('#generate-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(options.derive ? 'この画像を参照に設定しました。次の画像の文章を入力してください。' : '元の入力を復元しました。編集して別案を作れます。');
}
async function act(id, action) {
  const key = `${id}/${action}`; if (pendingActions.has(key)) return; pendingActions.add(key);
  try {
    const count = action === 'retry' ? requestedCount() : 1;
    const result = await api(`/api/jobs/${id}/${action === 'retry' && count > 1 ? 'retry-batch' : action}`, { method: 'POST', ...(count > 1 ? { body: JSON.stringify({ count }) } : {}) });
    const job = result.jobs?.[0] || result;
    if (action === 'retry') { state.selected = job.id; if (result.batchId) state.batchId = result.batchId; toast(count > 1 ? `同じ入力で${count}件の別案を生成します。` : '同じ入力で、新しいブランチに再生成します。'); }
    await refreshJobs(true);
    if (action === 'retry') lineage.select(job.id, { focus: true });
    return job;
  } finally { pendingActions.delete(key); }
}

$('#prompt').addEventListener('input', updateCount);
document.querySelectorAll('input[name=size], #style, #transparent').forEach(input => input.addEventListener('change', updateCount));
$('#batch-count').addEventListener('input', updateCount);
document.querySelectorAll('[data-count]').forEach(button => button.addEventListener('click', () => { $('#batch-count').value = button.dataset.count; updateCount(); }));
document.querySelectorAll('.prompt-example').forEach(button => button.addEventListener('click', () => { $('#prompt').value = button.dataset.example; updateCount(); $('#prompt').focus(); }));
$('#connection').addEventListener('click', () => refreshHealth(true));
$('#open-trash').addEventListener('click', () => deletion.openTrash());
$('#search').addEventListener('input', event => { state.query = event.target.value; render(); });
$('#batch-filter').addEventListener('change', event => { state.batchFilter = event.target.value; if (state.batchFilter) state.batchId = state.batchFilter; render(); });
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); render(); }));
$('#generate-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.submitting || features.isUploading?.() || !state.health?.ready || !state.token) return;
  state.submitting = true; updateGenerate(); $('#form-error').hidden = true;
  try {
    const count = requestedCount();
    const result = await api(count > 1 ? '/api/batches' : '/api/jobs', { method: 'POST', body: JSON.stringify({ prompt: $('#prompt').value, ...features.payload(), size: $('input[name=size]:checked').value, style: $('#style').value, transparent: $('#transparent').checked, ...(count > 1 ? { count } : {}) }) });
    const job = result.jobs?.[0] || result;
    if (result.batchId) { state.batchId = result.batchId; toast(`${count}件の別案を受け付けました。空いている処理枠から並列に生成します。`); }
    state.selected = job.id; await refreshJobs(true); lineage.select(job.id, { focus: false });
    if (window.matchMedia('(max-width:720px)').matches) $('#canvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
  finally { state.submitting = false; updateGenerate(); }
});
try { const session = await api('/api/session'); state.token = session.token; } catch { $('#health-notice').hidden = false; $('#health-notice').textContent = 'サーバーに接続できません。ページを再読み込みしてください。'; }
features.initialize(); await Promise.all([refreshHealth(), refreshJobs(), features.refreshUploads().catch(error => toast(error.message))]); updateCount();
setInterval(refreshJobs, 2000); setInterval(() => { refreshHealth(); features.refreshUploads().catch(() => {}); }, 30000);
