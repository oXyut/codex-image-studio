import { categories, referenceRoles, categoryLabel, composePrompt, searchTemplates } from './prompt-utils.js';
import { createTemplateHistory } from './template-history.js';
import { canvasSizeLabel, normalizeCanvasSize } from './canvas-options.js';

const $ = selector => document.querySelector(selector);
const draftKey = 'codex-image-studio-draft-v2';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function referenceSourceId(reference) { return reference?.uploadId || reference?.jobId; }
export function normalizeReferences(values) {
  if (!Array.isArray(values)) return [];
  const ids = new Set();
  return values.filter(value => {
    const id = referenceSourceId(value);
    if (!value || Boolean(value.jobId) === Boolean(value.uploadId) || !uuid.test(id) || !referenceRoles.some(([role]) => role === value.role) || ids.has(id)) return false;
    ids.add(id); return true;
  }).slice(0, 4).map(value => ({ [value.uploadId ? 'uploadId' : 'jobId']: referenceSourceId(value), role: value.role }));
}
export function reconcileDraftSources({ references, lineageContext }, { jobs = [], uploads = [], jobsLoaded = false, uploadsLoaded = false, removedIds = new Set() } = {}) {
  const jobIds = new Set(jobs.map(job => job.id)), uploadIds = new Set(uploads.map(upload => upload.id));
  const visible = references.filter(reference => !removedIds.has(referenceSourceId(reference)) && (reference.uploadId ? !uploadsLoaded || uploadIds.has(reference.uploadId) : !jobsLoaded || jobIds.has(reference.jobId)));
  const contextId = lineageContext?.sourceJobId;
  const context = removedIds.has(contextId) || (jobsLoaded && uploadsLoaded && contextId && !jobIds.has(contextId) && !uploadIds.has(contextId)) ? null : lineageContext;
  return { references: visible, lineageContext: context };
}
export function uploadFileType(file) {
  if (!file || !file.size) throw new Error('空のファイルはアップロードできません。');
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} は10MBを超えています。小さい画像を選んでください。`);
  const types = ['image/png', 'image/jpeg', 'image/webp'];
  if (types.includes(file.type)) return file.type;
  if (file.type && file.type !== 'application/octet-stream') throw new Error(`${file.name} は対応していない形式です。PNG・JPEG・WebPを選んでください。`);
  const extension = file.name?.split('.').pop()?.toLowerCase();
  const mime = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]).get(extension);
  if (!mime) throw new Error(`${file.name} は対応していない形式です。PNG・JPEG・WebPを選んでください。`);
  return mime;
}
function node(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function button(text, action, className = 'action') { const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', action); return value; }

export function studioFeatures({ api, toast, changed, getJobs, onDerive, onRegenerate, onDelete, onUploadsChanged = () => {}, getBatchCount = () => 1 }) {
  let templates = [], layers = [], references = [], uploads = [], editing = null, editingVersion = null, previewId = null, saving = false, lineageContext = null, uploading = false, uploadsLoading = false, uploadsError = '', uploadsPromise = null;
  let jobsLoaded = false, uploadsLoaded = false;
  const snapshot = value => ({ id: value.id, name: value.name, category: value.category, body: value.body, tags: [...value.tags], favorite: value.favorite, ...(Number.isSafeInteger(value.version) && value.version > 0 ? { version: value.version } : {}) });
  const notify = () => { renderLayers(); renderReferences(); renderContext(); changed(); };
  const safely = action => async () => { try { await action(); } catch (error) { toast(error.message); } };
  const options = (select, choices) => { for (const [id, label] of choices) { const option = node('option', '', label); option.value = id; select.append(option); } };
  options($('#template-category-filter'), categories); options($('#template-category'), categories);
  const editorVersion = node('p', 'template-editor-version'); editorVersion.hidden = true; $('#template-editor-title').parentElement.after(editorVersion);
  const conflictRefresh = button('最新の内容を読み込む（編集中の内容を置き換えます）', safely(async () => {
    await loadTemplates(); const latest = templates.find(template => template.id === editing); if (latest) resetEditor(latest);
  }), 'action template-conflict-refresh'); conflictRefresh.hidden = true; $('#template-error').after(conflictRefresh);
  const history = createTemplateHistory({ api, toast, onUse: addTemplate, onChanged: loadTemplates });

  function saveDraft() {
    try { localStorage.setItem(draftKey, JSON.stringify({ prompt: $('#prompt').value, layers, references, lineageContext, count: getBatchCount(), size: $('input[name=size]:checked').value, style: $('#style').value, transparent: $('#transparent').checked })); } catch { /* Generation remains available when browser storage is disabled. */ }
  }
  function restoreDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey)); if (!draft) return;
      if (typeof draft.prompt === 'string') $('#prompt').value = draft.prompt.slice(0, 4000);
      layers = Array.isArray(draft.layers) ? draft.layers.filter(layer => layer && typeof layer.body === 'string' && Array.isArray(layer.tags) && categories.some(([id]) => id === layer.category)).slice(0, 12).map(snapshot) : [];
      references = normalizeReferences(draft.references);
      if (draft.lineageContext && uuid.test(draft.lineageContext.sourceJobId) && ['derive', 'edit'].includes(draft.lineageContext.operation)) lineageContext = { sourceJobId: draft.lineageContext.sourceJobId, operation: draft.lineageContext.operation, newBranch: draft.lineageContext.newBranch === true };
      $(`input[name=size][value=${normalizeCanvasSize(draft.size)}]`).checked = true;
      if (Number.isSafeInteger(draft.count) && draft.count >= 1 && draft.count <= 10 && $('#batch-count')) $('#batch-count').value = String(draft.count);
      if (['auto', 'photo', 'illustration', '3d', 'minimal'].includes(draft.style)) $('#style').value = draft.style;
      $('#transparent').checked = draft.transparent === true;
    } catch { /* Ignore an invalid local draft. */ }
    notify();
  }
  function fullPrompt() { return composePrompt($('#prompt').value, layers); }
  const sourceFor = id => uploads.find(upload => upload.id === id) || getJobs().find(job => job.id === id);
  const hasReference = id => references.some(reference => referenceSourceId(reference) === id);
  const referenceFor = source => ({ [source.kind === 'upload' ? 'uploadId' : 'jobId']: source.id, role: 'overall' });
  const previewSources = () => [...getJobs().filter(job => job.status === 'succeeded' && job.image), ...uploads.filter(upload => upload.image)];
  function reconcileSources(removedIds = new Set()) {
    const next = reconcileDraftSources({ references, lineageContext }, { jobs: getJobs(), uploads, jobsLoaded, uploadsLoaded, removedIds });
    const edited = next.references.length !== references.length || next.lineageContext !== lineageContext;
    references = next.references; lineageContext = next.lineageContext;
    if (edited) notify();
  }
  function renderContext() {
    if (lineageContext?.operation === 'derive' && !hasReference(lineageContext.sourceJobId)) lineageContext = null;
    $('#creation-context').hidden = !lineageContext;
    if (!lineageContext) return;
    const source = sourceFor(lineageContext.sourceJobId);
    const uploaded = source?.kind === 'upload' || references.some(reference => reference.uploadId === lineageContext.sourceJobId);
    $('#creation-context-label').textContent = uploaded ? 'アップロード画像を起点に生成' : lineageContext.operation === 'derive' ? 'この画像から派生' : '入力を編集して別案';
    $('#creation-context-source').textContent = `${source?.name || source?.lineage?.title || source?.basePrompt?.split('\n')[0] || source?.prompt?.split('\n')[0] || (uploaded ? 'アップロードした画像' : '元の画像')} · ${lineageContext.sourceJobId.slice(0, 8)}`;
    $('#creation-new-branch').checked = lineageContext.newBranch;
    $('#creation-new-branch').disabled = lineageContext.operation === 'edit';
    $('#creation-context-hint').textContent = uploaded ? '入力中のプロンプトと設定を使います。元のアップロード画像とのつながりをブランチに残します。' : lineageContext.operation === 'derive' ? '最新の画像からは同じ枝の続きに、過去の画像からは新しい枝に保存します。' : '当時の文章・要素・参照を復元しました。生成すると、新しい枝に別案として保存します。';
  }
  $('#clear-creation-context').addEventListener('click', () => { lineageContext = null; notify(); });
  $('#creation-new-branch').addEventListener('change', event => { if (lineageContext) lineageContext.newBranch = event.target.checked; changed(); });
  function updateSummary() { const prompt = fullPrompt(); $('#combined-prompt').textContent = prompt || '入力またはテンプレートを選ぶと、ここに送信内容が表示されます。'; $('#combined-count').textContent = `${prompt.length.toLocaleString('ja-JP')} / 12,000`; $('#combined-count').classList.toggle('over-limit', prompt.length > 12000); saveDraft(); if ($('#image-preview-dialog').open) renderImageDialog(); }
  function renderLayers() {
    $('#layer-count').textContent = `${layers.length} / 12`; const list = $('#selected-layers'); list.replaceChildren();
    if (!layers.length) list.append(node('p', 'empty-feature', '要素を選ぶと、ここに順番に並びます。'));
    layers.forEach((layer, index) => {
      const item = node('div', 'layer-item'); const content = node('div'); content.append(node('span', 'category-chip', categoryLabel(layer.category)), node('strong', '', layer.name));
      if (layer.version) content.append(node('span', 'template-version-chip', `v${layer.version}`)); content.append(node('p', '', layer.body));
      const controls = node('div', 'layer-controls');
      const up = button('↑', () => { [layers[index - 1], layers[index]] = [layers[index], layers[index - 1]]; notify(); }, 'icon-button'); up.disabled = index === 0; up.setAttribute('aria-label', `${layer.name}を上へ`);
      const down = button('↓', () => { [layers[index], layers[index + 1]] = [layers[index + 1], layers[index]]; notify(); }, 'icon-button'); down.disabled = index === layers.length - 1; down.setAttribute('aria-label', `${layer.name}を下へ`);
      const remove = button('×', () => { layers.splice(index, 1); notify(); renderTemplates(); }, 'icon-button'); remove.setAttribute('aria-label', `${layer.name}を外す`);
      controls.append(up, down, remove); item.append(content, controls); list.append(item);
    });
  }
  function addReference(job, { quiet = false } = {}) {
    if (!job?.image || (job.kind !== 'upload' && job.status !== 'succeeded')) return false;
    if (hasReference(job.id)) { if (!quiet) toast('この画像は参照に追加済みです。'); return false; }
    if (references.length >= 4) { toast('参照画像は4枚まで選べます。'); return; }
    references.push(referenceFor(job)); notify(); renderUploads(); if (!quiet) toast(job.kind === 'upload' ? 'アップロード画像を参照に追加しました。ブランチの起点として保存されます。' : '参照に追加しました。引き継ぐ要素を選べます。'); return true;
  }
  function renderReferences() {
    $('#reference-count').textContent = `${references.length} / 4`; const list = $('#selected-references'); list.replaceChildren();
    $('#upload-reference-button').disabled = uploading || references.length >= 4;
    $('#reference-file-input').disabled = uploading || references.length >= 4;
    $('#upload-reference-button').textContent = uploading ? 'アップロード中…' : '＋ 画像をアップロード';
    if (!references.length) list.append(node('p', 'empty-feature', '画像をアップロードするか、保存済みの画像から選択できます。'));
    references.forEach((ref, index) => {
      const job = sourceFor(referenceSourceId(ref)); const uploaded = Boolean(ref.uploadId); const card = node('div', `reference-item${uploaded ? ' upload-reference-item' : ''}`);
      const imageButton = button('', () => job && openPreview(job), 'reference-thumbnail'); imageButton.setAttribute('aria-label', `参照画像${index + 1}をプレビュー`);
      if (job?.image) { const image = node('img'); image.src = job.image.url; image.alt = uploaded ? job.name : job.prompt; imageButton.append(image); } else imageButton.append(node('span', '', uploadsError && uploaded ? '再読込' : '読込待ち'));
      const content = node('div', 'reference-content'); content.append(node('span', `reference-source-chip${uploaded ? ' upload-source-chip' : ''}`, uploaded ? 'アップロード · 起点' : '生成画像'));
      content.append(node('strong', 'reference-name', job?.name || job?.lineage?.title || job?.basePrompt?.split('\n')[0] || job?.prompt?.split('\n')[0] || (uploaded ? 'アップロード画像' : '生成画像')));
      const label = node('label', '', `引き継ぐ要素 ${index + 1}`); const select = node('select'); select.setAttribute('aria-label', `引き継ぐ要素 ${index + 1}`); options(select, referenceRoles); select.value = ref.role; select.addEventListener('change', () => { ref.role = select.value; changed(); }); label.append(select); content.append(label);
      const remove = button('×', () => { references.splice(index, 1); notify(); renderUploads(); }, 'icon-button'); remove.setAttribute('aria-label', `参照画像${index + 1}を外す`); card.append(imageButton, content, remove); list.append(card);
    });
  }
  async function refreshUploads() {
    if (uploadsPromise) return uploadsPromise;
    uploadsLoading = true; uploadsError = ''; renderUploads();
    uploadsPromise = (async () => {
      try {
        const result = await api('/api/uploads'); uploads = result.uploads.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); uploadsLoaded = true; reconcileSources(); renderReferences(); renderContext(); if ($('#image-preview-dialog').open) renderImageDialog();
        await uploadsChanged(); return uploads;
      } catch (error) { uploadsError = error.message; throw error; }
      finally { uploadsLoading = false; uploadsPromise = null; renderUploads(); }
    })();
    return uploadsPromise;
  }
  async function uploadsChanged(upload) { try { await onUploadsChanged(upload); } catch { if (upload) toast('画像は保存しました。ブランチの表示は再読み込みしてください。'); } }
  function renderUploads() {
    const query = $('#upload-search').value.normalize('NFKC').toLocaleLowerCase('ja-JP');
    const results = uploads.filter(upload => upload.name.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(query));
    $('#refresh-uploads').disabled = uploadsLoading;
    $('#upload-list-status').textContent = uploadsError ? `一覧を読み込めませんでした。${uploadsError}「再読み込み」で再試行できます。` : uploadsLoading ? 'アップロード画像を読み込み中…' : !uploads.length ? 'アップロード画像はまだありません。「画像をアップロード」から追加してください。' : !results.length ? '検索条件に合う画像はありません。' : `${results.length}件 · 参照は生成画像と合わせて4枚まで`;
    const list = $('#upload-list'); list.replaceChildren();
    for (const upload of results) {
      const card = node('article', 'upload-card'); const preview = button('', () => { $('#upload-reference-dialog').close(); openPreview(upload); }, 'upload-card-preview'); preview.setAttribute('aria-label', `${upload.name}をプレビュー`);
      const image = node('img'); image.src = upload.image.url; image.alt = upload.name; image.loading = 'lazy'; preview.append(image); card.append(preview);
      const content = node('div', 'upload-card-content'); content.append(node('span', 'reference-source-chip upload-source-chip', 'アップロード · 起点'), node('h3', '', upload.name));
      content.append(node('p', 'feature-hint', `${upload.image.width} × ${upload.image.height} · ${(upload.image.bytes / 1024 / 1024).toFixed(1)} MB`));
      const controls = node('div', 'upload-card-actions'); const add = button(hasReference(upload.id) ? '✓ 追加済み' : '＋ 参照に追加', () => addReference(upload), 'action'); add.disabled = hasReference(upload.id) || references.length >= 4;
      controls.append(add, button('この画像から生成', () => { $('#upload-reference-dialog').close(); onDerive?.(upload); }, 'action primary')); content.append(controls); card.append(content); list.append(card);
      if (onDelete) controls.append(button('削除', safely(() => onDelete(upload)), 'action danger'));
    }
  }
  function uploadStatus(message, error = false) { const status = $('#upload-reference-status'); status.hidden = !message; status.textContent = message; status.classList.toggle('upload-error', error); }
  async function uploadFiles(files) {
    if (!files.length || uploading) return;
    try {
      if (files.length > 4 - references.length) throw new Error(`参照画像は合計4枚までです。あと${4 - references.length}枚選べます。`);
      files.forEach(uploadFileType);
    } catch (error) { uploadStatus(error.message, true); return; }
    uploading = true; changed(); renderReferences(); let completed = 0; const failures = [];
    try {
      for (const [index, file] of files.entries()) {
        if (references.length >= 4) { failures.push('参照画像が4枚に達したため、残りのアップロードを停止しました。'); break; }
        uploadStatus(`${index + 1} / ${files.length} · ${file.name} をアップロード中…`);
        try {
          const result = await api(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': uploadFileType(file) }, body: file }); const upload = result.upload ?? result;
          uploads = [upload, ...uploads.filter(value => value.id !== upload.id)]; completed++; addReference(upload, { quiet: true }); await uploadsChanged(upload);
        } catch (error) { failures.push(`${file.name}: ${error.message}`); }
      }
      uploadStatus(`${completed}枚の画像を保存しました。${failures.length ? ` ${failures.join(' ')}` : ' 引き継ぐ要素を選んで生成できます。'}`, Boolean(failures.length));
    } finally { uploading = false; renderReferences(); renderUploads(); changed(); }
  }
  async function loadTemplates() { ({ templates } = await api('/api/templates?all=1')); renderTemplates(); }
  function resetEditor(template, body = '') {
    editing = template?.id || null; editingVersion = template?.version || null; $('#template-editor-title').textContent = template ? 'テンプレートを編集' : '新しいテンプレート';
    $('#template-name').value = template?.name || ''; $('#template-body').value = template?.body ?? body; $('#template-category').value = template?.category || 'other'; $('#template-tags').value = template?.tags.join(', ') || ''; $('#template-favorite').checked = template?.favorite || false; $('#template-error').hidden = true;
    editorVersion.hidden = !editingVersion; editorVersion.textContent = editingVersion ? `v${editingVersion} を編集しています。保存すると新しい版になります。` : ''; conflictRefresh.hidden = true;
  }
  async function mutateTemplate(template, path, method, body = {}) {
    try { await api(path, { method, body: JSON.stringify({ ...body, expectedVersion: template.version }) }); }
    catch (error) { if (error.status === 409 || error.code === 'VERSION_CONFLICT') await loadTemplates(); throw error; }
  }
  function addTemplate(template) {
    const index = layers.findIndex(layer => layer.id === template.id);
    if (index < 0 && layers.length >= 12) { toast('テンプレートは12個まで選べます。'); return false; }
    if (index >= 0) layers[index] = snapshot(template); else layers.push(snapshot(template));
    notify(); renderTemplates(); toast(`${template.name}${template.version ? ` v${template.version}` : ''} を追加しました。`); return true;
  }
  function renderTemplates() {
    const results = searchTemplates(templates, { query: $('#template-search').value, category: $('#template-category-filter').value, favorite: $('#template-favorites').checked, archived: $('#template-archived').checked });
    $('#template-result-count').textContent = `${results.length}件`; const list = $('#template-list'); list.replaceChildren();
    if (!results.length) list.append(node('p', 'template-empty', '条件に合うテンプレートがありません。検索条件を変えるか、新しい要素を保存してください。'));
    for (const template of results) {
      const card = node('article', 'template-card'); const top = node('div', 'template-card-heading'); top.append(node('span', 'category-chip', categoryLabel(template.category)), node('h3', '', template.name), node('span', 'template-version-chip', `v${template.version ?? 1}`));
      const star = button(template.favorite ? '★' : '☆', safely(async () => { await mutateTemplate(template, `/api/templates/${template.id}`, 'PATCH', { favorite: !template.favorite }); await loadTemplates(); }), 'icon-button favorite-button'); star.setAttribute('aria-label', `${template.name}のお気に入りを切り替え`); star.setAttribute('aria-pressed', String(template.favorite)); top.append(star); card.append(top, node('p', 'template-body', template.body));
      const tags = node('div', 'template-tags'); for (const tag of template.tags) tags.append(button(`#${tag}`, () => { $('#template-search').value = `#${tag}`; renderTemplates(); }, 'tag-button')); card.append(tags);
      const actions = node('div', 'template-card-actions');
      if (!template.archivedAt) {
        const existing = layers.find(layer => layer.id === template.id); const identical = existing && existing.body === template.body && existing.name === template.name && existing.category === template.category && existing.version === template.version;
        const add = button(identical ? '✓ 追加済み' : existing ? '選択中の要素を更新' : '＋ プロンプトに追加', () => addTemplate(template), 'action primary'); add.disabled = Boolean(identical); actions.append(add, button('編集', () => { resetEditor(template); $('#template-name').focus(); }));
        actions.append(button('アーカイブ', safely(async () => { await mutateTemplate(template, `/api/templates/${template.id}`, 'DELETE'); if (editing === template.id) resetEditor(); await loadTemplates(); toast('アーカイブしました。後から復元できます。'); })));
      } else actions.append(button('復元', safely(async () => { await mutateTemplate(template, `/api/templates/${template.id}/restore`, 'POST'); await loadTemplates(); toast('テンプレートを復元しました。'); })));
      const historyButton = button('履歴・差分', () => history.open(template, historyButton)); historyButton.setAttribute('aria-label', `${template.name}の履歴・差分`); actions.append(historyButton);
      card.append(actions); list.append(card);
    }
  }
  function openTemplates(body) {
    if (body !== undefined) { if (body.length > 2000) { toast('テンプレートは2,000文字までです。保存する要素を短くしてからお試しください。'); return; } resetEditor(null, body); }
    if (!$('#template-dialog').open) $('#template-dialog').showModal(); loadTemplates().catch(error => toast(error.message));
    if (body !== undefined) $('#template-name').focus(); else $('#template-search').focus();
  }
  function openPreview(job) { if (!job?.image) return; if (job.kind === 'upload' && !uploads.some(upload => upload.id === job.id)) uploads.unshift(job); previewId = job.id; renderImageDialog(); if (!$('#image-preview-dialog').open) $('#image-preview-dialog').showModal(); }
  function renderImageDialog() {
    const completed = previewSources(); const index = completed.findIndex(job => job.id === previewId); const job = completed[index]; if (!job) { previewId = null; $('#image-preview-dialog').close(); $('#dialog-image').removeAttribute('src'); return; }
    const uploaded = job.kind === 'upload';
    $('#image-dialog-title').textContent = uploaded ? `アップロード画像 · ${job.name}` : '画像プレビュー';
    $('#dialog-image').src = job.image.url; $('#dialog-image').alt = uploaded ? job.name : job.prompt; $('#dialog-prompt').textContent = job.prompt || ''; $('#dialog-prompt-details').hidden = uploaded; $('#dialog-download').href = job.image.downloadUrl; $('#dialog-download').download = uploaded ? job.name : '';
    $('#image-position').textContent = `${index + 1} / ${completed.length}`; $('#previous-image').disabled = index <= 0; $('#next-image').disabled = index >= completed.length - 1;
    $('#dialog-image-meta').textContent = uploaded ? `アップロード · ブランチの起点 · ${job.image.width} × ${job.image.height} · ${new Date(job.createdAt).toLocaleString('ja-JP')}` : `${new Date(job.createdAt).toLocaleString('ja-JP')} · ${canvasSizeLabel(job.size, { full: true })} · テンプレート ${(job.layers ?? []).length}個 · 参照画像 ${(job.references ?? []).length}枚${job.image.recovered ? ' · 完成画像を回収しました' : ''}`;
    $('#dialog-reference').textContent = hasReference(job.id) ? '✓ 参照に追加済み' : '＋ 参照に追加'; $('#dialog-reference').disabled = hasReference(job.id) || references.length >= 4;
    $('#dialog-image-meta').textContent += ` · ${job.id.slice(0, 8)}`;
    $('#dialog-derive').textContent = uploaded ? 'この画像から生成' : 'この画像から派生'; $('#dialog-regenerate').hidden = uploaded; $('#dialog-regenerate').disabled = uploaded;
    const count = getBatchCount(); $('#dialog-regenerate').textContent = count > 1 ? `同じ入力で${count}件再生成` : '同じ入力で再生成';
  }
  function navigate(step) { const jobs = previewSources(); const index = jobs.findIndex(job => job.id === previewId); if (jobs[index + step]) openPreview(jobs[index + step]); }
  $('#previous-image').addEventListener('click', () => navigate(-1)); $('#next-image').addEventListener('click', () => navigate(1));
  $('#dialog-reference').addEventListener('click', () => { addReference(sourceFor(previewId)); renderImageDialog(); });
  $('#dialog-derive').addEventListener('click', () => { const job = sourceFor(previewId); $('#image-preview-dialog').close(); onDerive?.(job); });
  $('#dialog-regenerate').addEventListener('click', async () => { const job = sourceFor(previewId); if (!job || job.kind === 'upload') return; const control = $('#dialog-regenerate'); control.disabled = true; try { await onRegenerate?.(job); $('#image-preview-dialog').close(); } catch (error) { toast(error.message); } finally { control.disabled = false; } });
  $('#dialog-delete').addEventListener('click', safely(() => onDelete?.(sourceFor(previewId))));
  $('#image-preview-dialog').addEventListener('keydown', event => { if (event.target.matches('button, dialog')) { if (event.key === 'ArrowLeft') navigate(-1); if (event.key === 'ArrowRight') navigate(1); } });
  document.querySelectorAll('[data-close]').forEach(value => value.addEventListener('click', () => $(`#${value.dataset.close}`).close()));
  $('#open-templates').addEventListener('click', () => openTemplates());
  $('#save-prompt-template').addEventListener('click', () => { const body = $('#prompt').value.trim(); if (!body) { toast('保存したい要素を入力してください。'); return; } openTemplates(body); });
  $('#browse-references').addEventListener('click', () => $('.library').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('#upload-reference-button').addEventListener('click', () => $('#reference-file-input').click());
  $('#reference-file-input').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; uploadFiles(files).catch(error => uploadStatus(error.message, true)); });
  $('#browse-uploads').addEventListener('click', () => { renderUploads(); $('#upload-reference-dialog').showModal(); $('#upload-search').focus(); refreshUploads().catch(() => {}); });
  $('#refresh-uploads').addEventListener('click', () => refreshUploads().catch(() => {}));
  $('#upload-search').addEventListener('input', renderUploads);
  for (const id of ['template-search', 'template-category-filter', 'template-favorites', 'template-archived']) $(`#${id}`).addEventListener(id === 'template-search' ? 'input' : 'change', renderTemplates);
  $('#new-template').addEventListener('click', () => { resetEditor(); $('#template-name').focus(); });
  $('#template-form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return; saving = true; $('#save-template').disabled = true; $('#template-error').hidden = true;
    try {
      const body = { name: $('#template-name').value, category: $('#template-category').value, body: $('#template-body').value, tags: $('#template-tags').value.split(/[,、\n]/).map(tag => tag.trim()).filter(Boolean), favorite: $('#template-favorite').checked, ...(editingVersion ? { expectedVersion: editingVersion } : {}) };
      await api(`/api/templates${editing ? `/${editing}` : ''}`, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) }); await loadTemplates(); resetEditor(); toast('テンプレートを保存しました。');
    } catch (error) {
      const conflict = error.status === 409 || error.code === 'VERSION_CONFLICT';
      $('#template-error').textContent = conflict ? `${error.message} 編集中の内容は保持しています。最新を読み込むと、この入力を置き換えます。` : error.message; $('#template-error').hidden = false; conflictRefresh.hidden = !conflict;
      if (conflict) { try { await loadTemplates(); } catch { /* Keep the editor and its original version when refreshing fails. */ } }
    }
    finally { saving = false; $('#save-template').disabled = false; }
  });
  function restoreJob(job, { derive = false } = {}) {
    if (job.kind === 'upload') { restoreUpload(job); return; }
    layers = (job.layers ?? []).map(snapshot); references = derive ? [{ jobId: job.id, role: 'overall' }] : normalizeReferences(job.references);
    lineageContext = { sourceJobId: job.id, operation: derive ? 'derive' : 'edit', newBranch: !derive }; $('#prompt').value = job.basePrompt ?? job.prompt; notify(); renderTemplates();
  }
  function restoreUpload(upload) {
    if (!upload?.image || upload.kind !== 'upload') return;
    if (!uploads.some(value => value.id === upload.id)) uploads.unshift(upload);
    references = [referenceFor(upload)]; lineageContext = { sourceJobId: upload.id, operation: 'derive', newBranch: false }; notify(); renderUploads();
  }
  function removeNodes(ids) {
    const removedIds = ids instanceof Set ? ids : new Set(ids); uploads = uploads.filter(upload => !removedIds.has(upload.id)); reconcileSources(removedIds); renderReferences(); renderContext(); renderUploads(); if ($('#image-preview-dialog').open) renderImageDialog();
  }
  return { initialize: restoreDraft, updateSummary, fullPrompt, payload: () => ({ layers: layers.map(snapshot), references: references.map(ref => ({ ...ref })), ...(lineageContext ? { lineageContext: { ...lineageContext } } : {}) }), restoreJob, restoreUpload, addReference, openPreview, refreshUploads, removeNodes, isUploading: () => uploading, jobsChanged: () => { jobsLoaded = true; reconcileSources(); renderReferences(); renderContext(); if ($('#image-preview-dialog').open) renderImageDialog(); } };
}
