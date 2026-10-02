import { compareTemplateVersions } from './template-diff.js';

const operationNames = { create: '作成', update: '編集', archive: 'アーカイブ', unarchive: 'アーカイブから復元', restore: 'アーカイブから復元', revert: '過去版から復元' };
const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
const button = (text, action, className = 'action') => { const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', action); return value; };
const dateLabel = value => new Date(value).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function createTemplateHistory({ api, toast, onUse, onChanged }) {
  let current = null, versions = [], loading = false, saving = false, returnToLibrary = false, returnFocus = null, requestId = 0, closeMessage = '';
  const dialog = node('dialog', 'studio-dialog template-history-dialog');
  dialog.id = 'template-history-dialog'; dialog.setAttribute('aria-labelledby', 'template-history-title');
  const heading = node('div', 'dialog-heading'), headingText = node('div');
  const title = node('h2', '', 'テンプレートの履歴・差分'); title.id = 'template-history-title';
  const info = node('p', 'feature-hint');
  headingText.append(node('p', 'eyebrow', 'TEMPLATE VERSIONS'), title, info);
  const close = button('×', () => dialog.close(), 'close-dialog'); close.setAttribute('aria-label', 'テンプレートの履歴を閉じる'); heading.append(headingText, close);
  const message = node('p', 'template-history-message'); message.setAttribute('role', 'status');
  const refresh = button('最新の履歴を読み込む', () => load().catch(showError));
  const selectors = node('div', 'template-history-selectors');
  const beforeSelect = node('select'), afterSelect = node('select'); beforeSelect.id = 'template-version-before'; afterSelect.id = 'template-version-after'; beforeSelect.setAttribute('aria-label', '比較元'); afterSelect.setAttribute('aria-label', '比較先');
  const beforeLabel = node('label', '', '比較元'); beforeLabel.htmlFor = beforeSelect.id; beforeLabel.append(beforeSelect);
  const afterLabel = node('label', '', '比較先'); afterLabel.htmlFor = afterSelect.id; afterLabel.append(afterSelect);
  selectors.append(beforeLabel, node('span', 'template-history-arrow', '→'), afterLabel);
  const summary = node('p', 'template-history-summary'); summary.setAttribute('aria-live', 'polite');
  const metadata = node('div', 'template-history-metadata');
  const bodyHeading = node('div', 'template-history-body-heading'); bodyHeading.append(node('h3', '', '本文の差分'), node('span', '', '− 削除　＋ 追加'));
  const body = node('div', 'template-history-diff'); body.setAttribute('aria-label', 'テンプレート本文の差分');
  const actions = node('div', 'template-history-actions');
  const use = button('比較先の版をプロンプトに追加', () => {
    const version = selectedVersion(afterSelect); if (!version || onUse({ ...version, id: current.id }) === false) return;
    closeMessage = `v${version.version} をプロンプトに追加しました。`; dialog.close();
  }, 'action primary');
  const revert = button('比較先の版を復元', async () => {
    const version = selectedVersion(afterSelect); if (!version || saving) return;
    saving = true; render(); showMessage('選んだ内容を、新しい版として保存しています。');
    try {
      current = await api(`/api/templates/${current.id}/revert`, { method: 'POST', body: JSON.stringify({ version: version.version, expectedVersion: current.version }) });
      await onChanged(); await load({ preferAfter: current.version, preferBefore: version.version });
      showMessage(`v${version.version} の内容を v${current.version} として復元しました。選択中のプロンプト要素は維持しています。`);
      toast(`v${current.version} として復元しました。`);
    } catch (error) {
      if (error.status === 409 || error.code === 'VERSION_CONFLICT') {
        try { await onChanged(); await load(); showMessage('別の操作で更新されています。最新の履歴を読み込みました。差分を確認してから、もう一度復元してください。', true); }
        catch (refreshError) { showError(refreshError); }
      } else showError(error);
    } finally { saving = false; render(); }
  });
  actions.append(use, revert, refresh);
  const hint = node('p', 'feature-hint', '復元すると新しい版を作ります。過去の履歴と、画像生成時の入力は保持します。アーカイブ済みの版を復元した場合は、その保存状態も引き継ぎます。');
  dialog.append(heading, message, selectors, summary, metadata, bodyHeading, body, actions, hint); document.body.append(dialog);
  beforeSelect.addEventListener('change', renderDiff); afterSelect.addEventListener('change', renderDiff);
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    const library = document.querySelector('#template-dialog');
    if (returnToLibrary && library && !library.open) { library.showModal(); (returnFocus?.isConnected ? returnFocus : document.querySelector('#template-search'))?.focus(); }
    returnToLibrary = false;
    if (closeMessage) { toast(closeMessage); closeMessage = ''; }
  });
  function selectedVersion(select) { return versions.find(version => version.version === Number(select.value)); }
  function showMessage(text, error = false) { message.textContent = text; message.classList.toggle('is-error', error); message.setAttribute('role', error ? 'alert' : 'status'); }
  function showError(error) { showMessage(error.message || '履歴を読み込めませんでした。', true); }
  function renderSelect(select, value) {
    select.replaceChildren();
    for (const version of versions) {
      const label = `v${version.version}${version.version === current.version ? ' · 最新' : ''} · ${operationNames[version.operation] || '保存'} · ${dateLabel(version.createdAt)}`;
      const option = node('option', '', label); option.value = String(version.version); select.append(option);
    }
    select.value = String(versions.some(version => version.version === value) ? value : versions[0]?.version || '');
  }
  function render() {
    info.textContent = current ? `${current.name} · 最新 v${current.version ?? 1} · ${versions.length}版` : '';
    beforeSelect.disabled = loading || saving || !versions.length; afterSelect.disabled = beforeSelect.disabled;
    refresh.disabled = loading || saving; close.disabled = saving;
    renderDiff();
  }
  function renderDiff() {
    const before = selectedVersion(beforeSelect), after = selectedVersion(afterSelect);
    use.disabled = loading || saving || !after; revert.disabled = loading || saving || !after || after.version === current?.version;
    use.textContent = after ? `v${after.version} をプロンプトに追加` : '比較先の版をプロンプトに追加';
    revert.textContent = after ? `v${after.version} の内容を新しい版として復元` : '比較先の版を復元';
    metadata.replaceChildren(); body.replaceChildren();
    if (!before || !after) { summary.textContent = ''; return; }
    const diff = compareTemplateVersions(before, after);
    summary.textContent = `v${before.version} → v${after.version} · 本文 ＋${diff.added}行 −${diff.removed}行 · 属性 ${diff.changedFields}項目の変更`;
    const table = node('table'); const caption = node('caption', '', '名前・分類・タグ・保存状態の比較');
    const head = node('thead'), row = node('tr'); row.append(node('th', '', '属性'), node('th', '', `v${before.version}`), node('th', '', `v${after.version}`)); head.append(row);
    const content = node('tbody');
    for (const field of diff.metadata) {
      const item = node('tr', field.changed ? 'has-change' : ''); const label = node('th', '', field.label); label.scope = 'row';
      item.append(label, node('td', '', field.before), node('td', '', field.after)); content.append(item);
    }
    table.append(caption, head, content); metadata.append(table);
    if (!diff.lines.length) body.append(node('p', 'empty-feature', '本文は空です。'));
    for (const line of diff.lines) {
      const item = node('div', `template-diff-line template-diff-${line.type}`);
      const oldLine = node('span', 'template-diff-number', line.beforeLine ?? ''); oldLine.setAttribute('aria-hidden', 'true');
      const newLine = node('span', 'template-diff-number', line.afterLine ?? ''); newLine.setAttribute('aria-hidden', 'true');
      const marker = node('span', 'template-diff-marker', line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '); marker.setAttribute('aria-label', line.type === 'added' ? '追加' : line.type === 'removed' ? '削除' : '変更なし');
      item.append(oldLine, newLine, marker, node('code', '', line.text || ' ')); body.append(item);
    }
  }
  async function load({ preferBefore = Number(beforeSelect.value), preferAfter = Number(afterSelect.value) } = {}) {
    if (!current) return;
    const activeRequest = ++requestId; loading = true; render(); showMessage('履歴を読み込んでいます。');
    try {
      const result = await api(`/api/templates/${current.id}/versions`);
      if (activeRequest !== requestId) return;
      versions = result.versions; const latest = versions[0]; if (latest) current = { ...current, ...latest, id: result.templateId };
      renderSelect(beforeSelect, preferBefore || versions[1]?.version || latest?.version); renderSelect(afterSelect, preferAfter || latest?.version);
      showMessage(versions.length < 2 ? '最初の版です。編集して保存すると、差分を比較できます。' : '比較する2つの版を選んでください。');
    } finally { if (activeRequest === requestId) { loading = false; render(); } }
  }
  async function open(template, trigger = document.activeElement) {
    current = { ...template }; versions = []; beforeSelect.replaceChildren(); afterSelect.replaceChildren(); returnFocus = trigger;
    const library = document.querySelector('#template-dialog'); returnToLibrary = Boolean(library?.open); if (returnToLibrary) library.close();
    if (!dialog.open) dialog.showModal();
    try { await load({ preferBefore: 0, preferAfter: 0 }); } catch (error) { showError(error); }
    afterSelect.focus();
  }
  return { open, destroy: () => { requestId++; dialog.remove(); } };
}
