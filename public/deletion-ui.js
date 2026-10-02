const statusNames = { queued: '待機中', running: '生成中', succeeded: '完成', failed: 'エラー', cancelled: 'キャンセル', uploaded: 'アップロード' };
function node(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function button(text, action, className = 'action') { const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', action); return value; }

export function batchVisibility(jobs) {
  const total = jobs[0]?.batch?.count ?? jobs.length;
  const deleted = Math.max(0, ...jobs.map(job => Number.isSafeInteger(job.batch?.deletedCount) ? job.batch.deletedCount : 0));
  return { total, deleted, missing: Math.max(0, total - jobs.length - deleted) };
}

export function createDeletionUI({ api, toast, onChanged }) {
  let preview = null, rootId = null, busy = false, requestVersion = 0, returnFocus = null, trashVersion = 0, trashLoading = false;
  const dialog = node('dialog', 'studio-dialog deletion-dialog'); dialog.id = 'deletion-dialog'; dialog.setAttribute('aria-labelledby', 'deletion-dialog-title');
  const heading = node('div', 'dialog-heading'); const headingCopy = node('div'); const title = node('h2', '', '画像を削除'); title.id = 'deletion-dialog-title'; headingCopy.append(node('p', 'eyebrow', 'MOVE TO TRASH'), title);
  const close = button('×', () => { if (!busy) dialog.close(); }, 'close-dialog'); close.setAttribute('aria-label', '削除の確認を閉じる'); heading.append(headingCopy, close);
  const explanation = node('p', 'deletion-explanation', '選んだ画像と、そこからつながる下流の画像をすべて削除します。参照からの派生、入力を引き継いだ別案、再生成も対象です。');
  const retention = node('p', 'feature-hint', '画像ファイルと生成条件は保存したまま、履歴・系統図・参照候補から非表示にします。「ゴミ箱」からまとめて復元できます。');
  const summary = node('p', 'deletion-summary'); summary.id = 'deletion-summary'; summary.setAttribute('role', 'status');
  const activity = node('p', 'deletion-active-warning'); activity.hidden = true;
  const error = node('p', 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const list = node('div', 'deletion-node-list'); list.setAttribute('aria-label', '削除する画像の一覧');
  const footer = node('div', 'deletion-footer'); const cancel = button('キャンセル', () => dialog.close());
  const confirm = button('削除対象を確認中…', () => submit(), 'action danger primary'); confirm.id = 'confirm-image-deletion'; confirm.disabled = true; footer.append(cancel, confirm);
  dialog.append(heading, explanation, retention, summary, activity, error, list, footer);
  const trashDialog = node('dialog', 'studio-dialog trash-dialog'); trashDialog.id = 'trash-dialog'; trashDialog.setAttribute('aria-labelledby', 'trash-dialog-title');
  const trashHeading = node('div', 'dialog-heading'); const trashCopy = node('div'); const trashTitle = node('h2', '', '削除した画像'); trashTitle.id = 'trash-dialog-title'; trashCopy.append(node('p', 'eyebrow', 'TRASH'), trashTitle, node('p', 'feature-hint', '削除した起点と下流の画像を、削除したグループごとに復元できます。'));
  const trashClose = button('×', () => trashDialog.close(), 'close-dialog'); trashClose.setAttribute('aria-label', 'ゴミ箱を閉じる'); trashHeading.append(trashCopy, trashClose);
  const trashStatus = node('p', 'feature-hint'); trashStatus.setAttribute('role', 'status');
  const trashList = node('div', 'trash-list'); trashList.setAttribute('aria-label', '削除グループ');
  const refreshTrash = button('再読み込み', () => loadTrash(), 'action'); const trashToolbar = node('div', 'trash-toolbar'); trashToolbar.append(trashStatus, refreshTrash);
  trashDialog.append(trashHeading, trashToolbar, trashList);
  document.body.append(dialog, trashDialog);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { requestVersion++; preview = null; if (returnFocus?.isConnected) returnFocus.focus(); });

  function pending(value) { busy = value; close.disabled = value; cancel.disabled = value; confirm.disabled = value || !preview?.count; }
  function renderPreview(value) {
    summary.textContent = `削除する画像 ${value.count}件 · 生成履歴 ${value.jobCount}件 · アップロード ${value.uploadCount}枚`;
    activity.hidden = !value.activeCount; activity.textContent = `この中の${value.activeCount}件は生成中・待機中です。削除すると生成を停止します。復元後も自動では再開しません。`;
    list.replaceChildren();
    const orderedNodes = [...value.nodes].sort((a, b) => Number(b.id === value.rootId) - Number(a.id === value.rootId));
    for (const item of orderedNodes) {
      const row = node('article', 'deletion-node'); row.dataset.nodeId = item.id;
      const media = node('div', 'deletion-node-media'); if (item.image?.url) { const image = node('img'); image.src = item.image.url; image.alt = ''; image.loading = 'lazy'; media.append(image); } else media.append(node('span', '', statusNames[item.status] || '履歴'));
      const copy = node('div', 'deletion-node-copy'); copy.append(node('strong', '', item.title || '画像'), node('span', '', `${item.id === value.rootId ? '選択した起点 · ' : '下流 · '}${item.kind === 'upload' ? 'アップロード' : statusNames[item.status] || '生成履歴'} · ${item.id.slice(0, 8)}`)); row.append(media, copy); list.append(row);
    }
    if (value.alreadyDeletedCount) list.append(node('p', 'feature-hint', `下流の${value.alreadyDeletedCount}件は、すでに別の削除グループで非表示になっています。`));
    confirm.textContent = value.count ? `${value.count}件を削除` : '削除対象がありません'; confirm.disabled = !value.count;
  }
  async function loadPreview({ changed = false } = {}) {
    const version = ++requestVersion; preview = null; confirm.disabled = true; confirm.textContent = '削除対象を確認中…'; summary.textContent = '下流の画像を確認しています…'; list.replaceChildren(); activity.hidden = true;
    try {
      const value = await api(`/api/lineage/nodes/${rootId}/deletion-preview`); if (version !== requestVersion || !dialog.open) return;
      preview = value; renderPreview(value);
      if (changed) { error.hidden = false; error.textContent = '確認中に画像のつながりが変わりました。更新した対象一覧を確認して、もう一度削除してください。'; }
    } catch (failure) { if (version === requestVersion && dialog.open) { error.hidden = false; error.textContent = failure.message; summary.textContent = '削除対象を読み込めませんでした。いったん閉じて、もう一度お試しください。'; confirm.textContent = '削除できません'; } }
  }
  async function submit() {
    if (busy || !preview?.count) return;
    pending(true); error.hidden = true; confirm.textContent = preview.activeCount ? '生成を停止して削除中…' : '削除中…';
    try {
      const result = await api(`/api/lineage/nodes/${rootId}`, { method: 'DELETE', body: JSON.stringify({ planToken: preview.planToken }) });
      dialog.close();
      try { await onChanged(result); toast(`${result.count}件を削除しました。ゴミ箱から復元できます。`); }
      catch { toast(`${result.count}件を削除しました。表示の更新に失敗したため、ページを再読み込みしてください。`); }
      if (trashDialog.open) await loadTrash();
    } catch (failure) {
      if (failure.code === 'DELETE_PLAN_CHANGED') { pending(false); await loadPreview({ changed: true }); return; }
      error.hidden = false; error.textContent = failure.message;
    } finally { pending(false); if (preview && dialog.open) confirm.textContent = `${preview.count}件を削除`; }
  }
  async function open(source) {
    const id = typeof source === 'string' ? source : source?.id; if (!id || busy) return;
    rootId = id; returnFocus = document.activeElement; error.hidden = true;
    if (!dialog.open) dialog.showModal(); await loadPreview(); if (dialog.open) cancel.focus();
  }
  async function loadTrash() {
    if (trashLoading) return;
    const version = ++trashVersion; trashLoading = true; refreshTrash.disabled = true; trashStatus.textContent = 'ゴミ箱を読み込み中…';
    try {
      const { deletions } = await api('/api/trash'); if (version !== trashVersion) return;
      trashList.replaceChildren(); trashStatus.textContent = deletions.length ? `${deletions.length}グループ` : 'ゴミ箱は空です。';
      for (const group of deletions) {
        const card = node('article', 'trash-card'); card.dataset.deletionId = group.id;
        const copy = node('div'); copy.append(node('h3', '', group.title || '削除した画像'), node('p', 'feature-hint', `${group.nodeCount}件 · 生成履歴 ${group.jobCount}件 · アップロード ${group.uploadCount}枚`), node('p', 'trash-date', `${new Date(group.deletedAt).toLocaleString('ja-JP')} · 起点 ${group.rootId.slice(0, 8)}`));
        const restore = button('このグループを復元', async () => {
          restore.disabled = true; restore.textContent = '復元中…';
          try {
            const result = await api(`/api/trash/${group.id}/restore`, { method: 'POST' });
            let refreshFailed = false; try { await onChanged(result); } catch { refreshFailed = true; }
            await loadTrash();
            toast(`${result.restoredIds.length}件を復元しました。${result.stillDeletedIds.length ? ` ${result.stillDeletedIds.length}件は上流や別グループの削除が残っています。` : ''}${refreshFailed ? ' 表示の更新に失敗したため、ページを再読み込みしてください。' : ''}`);
          } catch (failure) { toast(failure.message); }
          finally { restore.disabled = false; restore.textContent = 'このグループを復元'; }
        }); restore.setAttribute('aria-label', `${group.title || '削除した画像'}の削除グループを復元`); card.append(copy, restore); trashList.append(card);
      }
    } catch (failure) { trashStatus.textContent = `ゴミ箱を読み込めませんでした。${failure.message}`; }
    finally { trashLoading = false; refreshTrash.disabled = false; }
  }
  function openTrash() { if (!trashDialog.open) trashDialog.showModal(); loadTrash(); }
  return { open, openTrash };
}
