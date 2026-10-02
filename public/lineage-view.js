import { buildLineageGraph, filterLineageGraph, layoutLineageGraph, lineageEdgePath, lineageTitle, lineageOperationNames, lineageStatusNames, lineageBatchLabel } from './lineage-utils.js';
import { categoryLabel, roleLabel } from './prompt-utils.js';
import { canvasSizeLabel } from './canvas-options.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
let viewCount = 0;
function element(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function svgElement(tag, attributes = {}) { const value = document.createElementNS(svgNamespace, tag); for (const [name, content] of Object.entries(attributes)) value.setAttribute(name, String(content)); return value; }
function button(text, action, className = 'action') { const value = element('button', className, text); value.type = 'button'; value.addEventListener('click', action); return value; }
function option(label, value) { const item = element('option', '', label); item.value = value; return item; }
function shorten(value, length = 38) { return value.length > length ? `${value.slice(0, length)}…` : value; }
function active(job) { return ['running', 'queued'].includes(job?.status); }
function dateLabel(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function imageCounts(nodes) { const uploads = nodes.filter(value => value.kind === 'upload').length; return `生成${nodes.length - uploads}件${uploads ? ` · アップロード${uploads}枚` : ''}`; }

export function createLineageView({ api, toast, getJobs, getBatchCount = () => 1, onSelect, onDerive, onRegenerate, onEdit, onPreview, onDelete }) {
  const section = document.querySelector('#lineage-section');
  if (!section) throw new Error('画像の系統を表示する領域がありません。');
  const markerPrefix = `lineage-${++viewCount}`;
  let metadata = { version: 1, commits: [], branches: [] }, graph, visible, layout, selectedId = null;
  let graphKey = '', inspectorId = null, zoom = 1, refreshing = false, refreshAgain = false, destroyed = false;
  let drag = null, inspectorImageKey = '', inspectorState, viewportSignature = '';
  const heading = element('div', 'lineage-heading');
  const headingCopy = element('div'); headingCopy.append(element('p', 'eyebrow', 'IMAGE LINEAGE'));
  const title = element('h2', '', '画像のつながり'); const count = element('span', 'lineage-count', '0'); title.append(count);
  headingCopy.append(title, element('p', 'lineage-description', 'アップロードした参照や生成画像から、次の一枚へ。起点・別案・再生成の履歴をたどれます。'));
  const newest = button('最新の画像へ ↓', () => { const latest = graph?.nodes.filter(value => value.kind !== 'upload').at(-1) ?? graph?.nodes.at(-1); if (latest) choose(latest.id, true); });
  newest.classList.add('lineage-newest'); heading.append(headingCopy, newest);
  const filters = element('div', 'lineage-filters');
  const search = element('input'); search.type = 'search'; search.placeholder = 'ファイル名・タイトル・プロンプトを検索'; search.setAttribute('aria-label', '画像のつながりを検索');
  const branchSelect = element('select'); branchSelect.setAttribute('aria-label', 'ブランチで絞り込む');
  const componentSelect = element('select'); componentSelect.setAttribute('aria-label', '画像の系統で絞り込む');
  const batchSelect = element('select'); batchSelect.setAttribute('aria-label', '系統図の同時作成グループで絞り込む');
  const reset = button('解除', () => { search.value = ''; branchSelect.value = ''; componentSelect.value = ''; batchSelect.value = ''; render(true); });
  filters.append(search, branchSelect, componentSelect, batchSelect, reset);
  const legend = element('div', 'lineage-legend');
  const uploadLegend = element('span', 'lineage-upload-legend'); uploadLegend.append(element('i', 'upload'), document.createTextNode('アップロード：参照の起点')); legend.append(uploadLegend);
  for (const [className, label] of [['reference', '実線：参照画像'], ['source', '破線：入力を引き継いだ別案・再生成']]) { const entry = element('span'); entry.append(element('i', className), document.createTextNode(label)); legend.append(entry); }
  const batchLegend = element('span', 'lineage-batch-legend'); batchLegend.append(element('i', 'batch'), document.createTextNode('淡い囲み：同じ依頼での同時作成')); legend.append(batchLegend);
  const resultText = element('span', 'lineage-result-count'); legend.append(resultText);
  const body = element('div', 'lineage-body'); const graphPanel = element('div', 'lineage-graph-panel');
  const graphTools = element('div', 'lineage-graph-tools');
  const zoomOut = button('−', () => setZoom(zoom - .15), 'lineage-tool'); zoomOut.setAttribute('aria-label', '系統図を縮小');
  const zoomLabel = element('span', 'lineage-zoom', '100%');
  const zoomIn = button('＋', () => setZoom(zoom + .15), 'lineage-tool'); zoomIn.setAttribute('aria-label', '系統図を拡大');
  const fit = button('全体を表示', fitGraph, 'lineage-tool');
  const selectedView = button('選択へ', () => focusNode(selectedId), 'lineage-tool');
  graphTools.append(zoomOut, zoomLabel, zoomIn, fit, selectedView, element('span', 'lineage-pan-hint', '背景をドラッグして移動'));
  const viewport = element('div', 'lineage-viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', '画像の系統図。上下左右のキーで移動できます');
  const canvas = svgElement('svg', { class: 'lineage-svg', role: 'group', 'aria-label': '参照画像と生成履歴の系統図' });
  const empty = element('div', 'lineage-empty');
  empty.append(element('span', 'lineage-empty-symbol', '⌘'), element('h3', '', 'ここから、画像が枝分かれしていきます。'), element('p', '', '画像をアップロードするか生成すると、参照の起点と別案のつながりを確認できます。'));
  const warning = element('p', 'lineage-warning'); warning.hidden = true;
  viewport.append(canvas, empty); graphPanel.append(graphTools, viewport, warning);
  const inspector = element('aside', 'lineage-inspector'); inspector.setAttribute('aria-label', '選択した画像と履歴の詳細');
  body.append(graphPanel, inspector); section.classList.add('lineage-section'); section.replaceChildren(heading, filters, legend, body);
  search.addEventListener('input', () => render(true));
  branchSelect.addEventListener('change', () => render(true)); componentSelect.addEventListener('change', () => render(true));
  batchSelect.addEventListener('change', () => render(true));

  const safely = action => async event => { const target = event?.currentTarget; if (target) target.disabled = true; try { await action(); } catch (error) { toast(error.message); } finally { if (target?.isConnected) { target.disabled = false; updateInspector(); } } };
  function choose(id, focus = false) { select(id, { focus }); onSelect?.(graph.nodeMap.get(id)?.job); }
  function select(id, { focus = false } = {}) {
    if (!graph?.nodeMap.has(id)) { selectedId = id; return; }
    selectedId = id;
    if (focus && !visible?.visibleIds.has(id)) { search.value = ''; branchSelect.value = ''; componentSelect.value = ''; batchSelect.value = ''; render(true); }
    updateSelection(); updateInspector(); if (focus) focusNode(id);
  }
  function updateSelection() {
    for (const card of canvas.querySelectorAll('.lineage-node')) { const selected = card.dataset.jobId === selectedId; card.classList.toggle('selected', selected); card.setAttribute('aria-pressed', String(selected)); }
    for (const edge of canvas.querySelectorAll('.lineage-edge')) edge.classList.toggle('selected-edge', edge.dataset.to === selectedId);
    selectedView.disabled = !visible?.visibleIds.has(selectedId);
  }
  function updateChoices(selectElement, values, firstLabel) {
    const current = selectElement.value;
    const signature = JSON.stringify(values);
    if (selectElement.dataset.signature === signature) return;
    selectElement.dataset.signature = signature; selectElement.replaceChildren(option(firstLabel, ''));
    for (const [id, label] of values) selectElement.append(option(label, id));
    selectElement.value = values.some(([id]) => id === current) ? current : '';
  }
  function render(force = false) {
    if (destroyed) return;
    const jobs = getJobs(); const nextKey = JSON.stringify([metadata, jobs.map(job => [job.id, job.status, job.image?.url, job.prompt, job.basePrompt, job.references, job.lineage, job.batch, job.error])]);
    if (!force && graphKey === nextKey) { updateInspector(); return; }
    graphKey = nextKey; graph = buildLineageGraph(metadata, jobs);
    count.textContent = imageCounts(graph.nodes);
    const branches = graph.branches.filter(branch => graph.nodes.some(value => value.branchId === branch.id));
    updateChoices(branchSelect, branches.map(branch => [branch.id, branch.name]), 'すべてのブランチ');
    updateChoices(componentSelect, graph.components.map(component => [component.id, `${shorten(component.title, 22)} · ${imageCounts(component.nodeIds.map(id => graph.nodeMap.get(id)))}`]), 'すべての系統');
    updateChoices(batchSelect, graph.batches.map(batch => [batch.id, `${lineageBatchLabel(batch.id)} · ${batch.count}件`]), 'すべての同時作成'); batchSelect.hidden = !graph.batches.length;
    visible = filterLineageGraph(graph, { query: search.value, branchId: branchSelect.value, componentId: componentSelect.value, batchId: batchSelect.value });
    layout = layoutLineageGraph(graph, visible);
    resultText.textContent = visible.filtered ? `${visible.matchIds.size}件に一致 · 元画像を含め${visible.nodes.length}件` : `${branches.length}ブランチ · ${graph.components.length}系統`;
    warning.hidden = !graph.missingEdges.length && !graph.cyclicEdges.length;
    warning.textContent = [graph.missingEdges.length ? `${graph.missingEdges.length}件の元画像が見つかりません。履歴の詳細には元画像のIDを残しています。` : '', graph.cyclicEdges.length ? '循環する履歴があるため、その線の表示を省略しました。' : ''].filter(Boolean).join(' ');
    const previouslyFocused = document.activeElement?.closest('.lineage-node')?.dataset.jobId;
    canvas.replaceChildren(); canvas.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    drawMarkers();
    for (const batch of layout.batchGroups) drawBatchGroup(batch);
    for (const edge of visible.edges) drawEdge(edge);
    for (const value of visible.nodes) drawNode(value);
    empty.hidden = visible.nodes.length > 0; canvas.toggleAttribute('hidden', !visible.nodes.length);
    if (!graph.nodes.length) { empty.querySelector('h3').textContent = 'ここから、画像が枝分かれしていきます。'; empty.querySelector('p').textContent = '画像をアップロードするか生成すると、参照の起点と別案のつながりを確認できます。'; }
    else if (!visible.nodes.length) { empty.querySelector('h3').textContent = '条件に合う画像がありません。'; empty.querySelector('p').textContent = '検索条件やブランチの絞り込みを変更してください。'; }
    if (!selectedId || !graph.nodeMap.has(selectedId)) selectedId = visible.nodes.at(-1)?.id ?? null;
    updateZoom(); updateSelection(); updateInspector();
    if (previouslyFocused) canvas.querySelector(`[data-job-id="${CSS.escape(previouslyFocused)}"]`)?.focus({ preventScroll: true });
    const nextSignature = visible.nodes.map(value => value.id).join(',');
    if (force && viewportSignature !== nextSignature) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    viewportSignature = nextSignature;
  }
  function drawMarkers() {
    const defs = svgElement('defs');
    for (const kind of ['reference', 'source']) { const marker = svgElement('marker', { id: `${markerPrefix}-${kind}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }); marker.append(svgElement('path', { d: 'M 1 1 L 7 4 L 1 7 z', class: `lineage-arrow ${kind}` })); defs.append(marker); }
    canvas.append(defs);
  }
  function drawBatchGroup(batch) {
    const group = svgElement('g', { class: 'lineage-batch-group', 'data-batch-id': batch.id, role: 'group', 'aria-label': `${lineageBatchLabel(batch.id)}、表示${batch.visibleCount}件、全${batch.count}件${batch.deletedCount ? `、削除${batch.deletedCount}件` : ''}` });
    group.append(svgElement('rect', { x: batch.x, y: batch.y, width: batch.width, height: batch.height, rx: 13 }));
    const title = svgElement('text', { x: batch.x + 10, y: batch.y + 13, class: 'lineage-batch-group-title' }); title.textContent = lineageBatchLabel(batch.id);
    const count = svgElement('text', { x: batch.x + 10, y: batch.y + 25, class: 'lineage-batch-group-count' }); count.textContent = `表示 ${batch.visibleCount} / 全 ${batch.count}${batch.deletedCount ? ` · 削除 ${batch.deletedCount}` : ''}`;
    group.append(title, count); canvas.append(group);
  }
  function drawEdge(edge) {
    const from = layout.positions.get(edge.from), to = layout.positions.get(edge.to);
    if (!from || !to) return;
    const path = svgElement('path', { d: lineageEdgePath(from, to), class: `lineage-edge ${edge.kind}`, 'marker-end': `url(#${markerPrefix}-${edge.kind})`, 'data-from': edge.from, 'data-to': edge.to });
    const title = svgElement('title'); title.textContent = `${lineageTitle(graph.nodeMap.get(edge.from))} → ${lineageTitle(graph.nodeMap.get(edge.to))}：${edge.label}`; path.append(title); canvas.append(path);
    if (edge.kind === 'source') { const x = (from.x + layout.cardWidth + to.x) / 2, y = (from.y + to.y) / 2 + layout.cardHeight / 2; const label = svgElement('g', { class: 'lineage-edge-caption', 'aria-hidden': 'true' }); label.append(svgElement('rect', { x: x - 31, y: y - 9, width: 62, height: 18, rx: 5 })); const text = svgElement('text', { x, y: y + 3, 'text-anchor': 'middle' }); text.textContent = edge.label; label.append(text); canvas.append(label); }
  }
  function drawNode(value) {
    const point = layout.positions.get(value.id);
    const wrapper = svgElement('foreignObject', { x: point.x, y: point.y, width: point.width, height: point.height });
    const card = button('', () => choose(value.id), `lineage-node ${value.kind === 'upload' ? 'lineage-node-upload' : ''} ${visible.filtered && !visible.matchIds.has(value.id) ? 'context' : ''}`);
    card.dataset.jobId = value.id; card.dataset.kind = value.kind; card.setAttribute('aria-label', `${lineageTitle(value)}、${lineageStatusNames[value.job.status] ?? '履歴'}${value.kind === 'upload' ? '、参照の起点' : ''}${value.batchId ? `、${lineageBatchLabel(value.batchId)}の${value.job.batch.index}/${value.job.batch.count}件目` : ''}、${value.id.slice(0, 8)}`);
    const media = element('span', `lineage-node-media ${value.job.status}`);
    if (value.job.image?.url) { const image = element('img'); image.src = value.job.image.url; image.alt = ''; image.loading = 'lazy'; media.append(image); }
    else media.append(element('span', 'lineage-node-placeholder', value.job.status === 'running' ? '✧ 生成中' : lineageStatusNames[value.job.status] ?? '履歴'));
    media.append(element('span', `lineage-node-status ${value.job.status}`, lineageStatusNames[value.job.status] ?? '履歴'));
    if (value.batchId) { card.dataset.batchId = value.batchId; const badge = element('span', 'lineage-node-batch', `#${value.batchId.slice(0, 6)} · ${value.job.batch.index}/${value.job.batch.count}`); badge.title = `${lineageBatchLabel(value.batchId)} · ${value.job.batch.index}件目`; media.append(badge); }
    const details = element('span', 'lineage-node-copy'); details.append(element('strong', '', lineageTitle(value)), element('span', 'lineage-node-meta', `${value.branch?.name || '履歴'} · ${value.id.slice(0, 7)}`));
    const foot = element('span', 'lineage-node-foot'); foot.append(element('span', '', lineageOperationNames[value.operation]), value.branch?.headJobId === value.id && value.kind !== 'upload' ? element('span', 'lineage-head-label', '先端') : element('time', '', dateLabel(value.createdAt)));
    details.append(foot); card.append(media, details); wrapper.append(card); canvas.append(wrapper);
  }
  function updateZoom() {
    if (!layout) return;
    canvas.setAttribute('width', Math.round(layout.width * zoom)); canvas.setAttribute('height', Math.round(layout.height * zoom));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`; zoomOut.disabled = zoom <= .25; zoomIn.disabled = zoom >= 2;
  }
  function setZoom(value) {
    const old = zoom; zoom = Math.max(.25, Math.min(2, Math.round(value * 100) / 100));
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / old, centerY = (viewport.scrollTop + viewport.clientHeight / 2) / old;
    updateZoom(); viewport.scrollLeft = centerX * zoom - viewport.clientWidth / 2; viewport.scrollTop = centerY * zoom - viewport.clientHeight / 2;
  }
  function fitGraph() { if (!layout) return; zoom = Math.max(.25, Math.min(1, (viewport.clientWidth - 20) / layout.width, (viewport.clientHeight - 20) / layout.height)); updateZoom(); viewport.scrollLeft = 0; viewport.scrollTop = 0; }
  function focusNode(id) {
    const position = layout?.positions.get(id); if (!position) return;
    viewport.scrollTo({ left: (position.x + position.width / 2) * zoom - viewport.clientWidth / 2, top: (position.y + position.height / 2) * zoom - viewport.clientHeight / 2, behavior: 'smooth' });
  }

  function relationList(ids, emptyText, roles = false) {
    const list = element('div', 'lineage-relations');
    if (!ids.length) list.append(element('p', 'lineage-small-note', emptyText));
    for (const id of ids) {
      const related = graph.nodeMap.get(id);
      if (!related) { list.append(element('p', 'lineage-small-note', `元画像が見つかりません · ${id.slice(0, 8)}`)); continue; }
      const item = button('', () => choose(id, true), `lineage-relation${related.kind === 'upload' ? ' lineage-relation-upload' : ''}`);
      if (related.job.image?.url) { const image = element('img'); image.src = related.job.image.url; image.alt = ''; image.loading = 'lazy'; item.append(image); }
      else item.append(element('span', 'lineage-relation-placeholder', '◌'));
      const copy = element('span'); copy.append(element('strong', '', shorten(lineageTitle(related), 40)));
      const role = roles ? graph.nodeMap.get(selectedId)?.job.references?.find(ref => (ref.jobId ?? ref.uploadId) === id)?.role : null;
      copy.append(element('small', '', `${role ? `${roleLabel(role)} · ` : ''}${lineageStatusNames[related.job.status]}${related.kind === 'upload' ? ' · 参照の起点' : ''} · ${id.slice(0, 7)}`)); item.append(copy); list.append(item);
    }
    return list;
  }
  function updateInspector() {
    const value = graph?.nodeMap.get(selectedId);
    if (!value) {
      if (inspectorId !== null || !inspector.childNodes.length) { inspector.replaceChildren(element('div', 'lineage-inspector-empty', '画像を選ぶと、プロンプト・元画像・ブランチを確認できます。')); inspectorId = null; inspectorState = null; }
      return;
    }
    if (inspectorId !== selectedId) buildInspector(value);
    const { job } = value;
    inspectorState.status.textContent = `${lineageStatusNames[job.status]} · ${dateLabel(job.createdAt)} · ${job.id.slice(0, 8)}${job.batch ? ` · まとめ生成 ${job.batch.index}/${job.batch.count}` : ''}`;
    inspectorState.title.textContent = lineageTitle(value);
    inspectorState.branchLabel.textContent = value.branch?.name || 'ブランチ情報なし';
    if (inspectorState.branchId !== value.branchId || (inspectorState.branchName.disabled && value.branch)) {
      inspectorState.branchId = value.branchId; inspectorState.branchName.value = value.branch?.name || '';
      inspectorState.branchName.disabled = !value.branch; inspectorState.branchSave.disabled = !value.branch;
    }
    const imageKey = `${job.status}:${job.image?.url ?? ''}`;
    if (inspectorImageKey !== imageKey) {
      inspectorImageKey = imageKey; inspectorState.image.replaceChildren();
      if (job.image?.url) { const image = element('img'); image.src = job.image.url; image.alt = job.kind === 'upload' ? job.name : job.prompt; inspectorState.image.append(image); }
      else inspectorState.image.append(element('span', '', job.status === 'running' ? '✧ 画像を生成しています' : lineageStatusNames[job.status]));
    }
    inspectorState.image.disabled = !job.image;
    inspectorState.derive.disabled = !['succeeded', 'uploaded'].includes(job.status) || !job.image;
    inspectorState.regenerate.disabled = active(job);
    inspectorState.regenerate.textContent = job.error?.category === 'content' ? '内容を編集して再試行' : getBatchCount() > 1 ? `同じ入力で${getBatchCount()}件再生成` : job.status === 'failed' ? '同じ入力で再試行' : '同じ入力で再生成';
    inspectorState.error.hidden = !job.error?.message;
    inspectorState.error.textContent = [job.error?.message, job.error?.advice].filter(Boolean).join('\n');
    inspectorState.errorDetails.hidden = job.status !== 'failed';
    inspectorState.errorText.textContent = job.error?.details || 'この履歴には詳しい理由が保存されていません。入力は保持されています。';
    const relationKey = JSON.stringify([value.parentIds, value.sourceJobId, graph.edges.filter(edge => edge.from === value.id).map(edge => edge.to), graph.nodes.map(node => [node.id, node.title, node.job.status, node.job.image?.url, node.job.batch])]);
    if (relationKey !== inspectorState.relationKey) { inspectorState.relationships.replaceChildren(...buildRelationships(value).childNodes); inspectorState.relationKey = relationKey; }
  }
  function buildRelationships(value) {
    const relationships = element('div', 'lineage-relationship-section');
    if (value.batchId) relationships.append(buildBatchPeers(value));
    if (value.kind === 'upload') relationships.append(element('p', 'lineage-upload-origin-note', 'このアップロード画像を起点に、参照して生成した画像がつながります。'));
    else relationships.append(element('h4', '', `参照した画像 · ${value.parentIds.length}枚`), relationList(value.parentIds, '参照画像なしで生成しました。', true));
    if (value.sourceJobId && !value.parentIds.includes(value.sourceJobId)) {
      relationships.append(element('h4', '', value.operation === 'regenerate' ? '再生成した元の履歴' : '入力を引き継いだ履歴'), relationList([value.sourceJobId], ''), element('p', 'lineage-small-note', value.operation === 'regenerate' ? '元の文章・テンプレート・参照画像を使った別案です。' : '元の入力を編集して生成した別案です。'));
    }
    const descendants = graph.edges.filter(edge => edge.from === value.id).map(edge => edge.to);
    relationships.append(element('h4', '', `ここから生まれた画像 · ${descendants.length}枚`), relationList(descendants, 'まだ次の画像はありません。'));
    return relationships;
  }
  function buildBatchPeers(value) {
    const batch = graph.batchMap.get(value.batchId), section = element('section', 'lineage-batch-peers'); section.setAttribute('aria-label', '同時作成の画像');
    const heading = element('div', 'feature-heading'); heading.append(element('h4', '', lineageBatchLabel(batch.id)), button('このグループを見る', () => showBatch(batch.id), 'text-button')); section.append(heading);
    section.append(element('p', 'lineage-small-note', `同じ一括生成で作成した画像 · 保存 ${batch.nodeIds.length} / 全 ${batch.count}${batch.deletedCount ? ` · 削除 ${batch.deletedCount}` : ''}。このグループ分けは参照・親子関係とは別です。`));
    const list = element('div', 'lineage-batch-peer-list');
    for (const id of batch.nodeIds) {
      const peer = graph.nodeMap.get(id), selected = id === selectedId;
      const item = button('', () => choose(id, true), `lineage-batch-peer${selected ? ' selected' : ''}`); item.setAttribute('aria-label', `${lineageBatchLabel(batch.id)}の${peer.job.batch.index}件目を選択、${lineageStatusNames[peer.job.status]}`); item.setAttribute('aria-pressed', String(selected));
      if (peer.job.image?.url) { const image = element('img'); image.src = peer.job.image.url; image.alt = ''; image.loading = 'lazy'; item.append(image); } else item.append(element('span', 'lineage-batch-peer-placeholder', lineageStatusNames[peer.job.status]));
      item.append(element('span', '', `${peer.job.batch.index}/${batch.count} · ${lineageStatusNames[peer.job.status]}`)); list.append(item);
    }
    section.append(list); return section;
  }
  function showBatch(id) {
    if (!graph?.batchMap.has(id)) return;
    search.value = ''; branchSelect.value = ''; componentSelect.value = ''; batchSelect.value = id; render(true);
    const first = graph.batchMap.get(id).nodeIds[0]; if (first) choose(first); fitGraph();
  }
  function buildInspector(value) {
    inspectorId = selectedId; inspectorImageKey = ''; inspector.replaceChildren();
    const isUpload = value.kind === 'upload'; inspector.classList.toggle('lineage-inspector-upload', isUpload);
    const identity = element('div', 'lineage-inspector-heading'); const branchLabel = element('span', 'lineage-branch-chip', value.branch?.name || 'ブランチ情報なし'); const title = element('h3', '', lineageTitle(value)); const status = element('p', 'lineage-small-note');
    identity.append(branchLabel, title, status);
    const image = button('', () => { const job = graph.nodeMap.get(selectedId)?.job; if (job?.image) onPreview?.(job); }, 'lineage-inspector-image'); image.setAttribute('aria-label', '選択した画像を拡大プレビュー');
    const actions = element('div', 'lineage-inspector-actions');
    const derive = button('この画像から生成 →', safely(() => onDerive?.(graph.nodeMap.get(selectedId).job)), 'action primary');
    const regenerate = button('同じ入力で別案を生成', safely(() => { const job = graph.nodeMap.get(selectedId).job; return job.error?.category === 'content' ? onEdit?.(job) : onRegenerate?.(job); }));
    const edit = button('入力を編集して別案', safely(() => onEdit?.(graph.nodeMap.get(selectedId).job)));
    regenerate.hidden = isUpload; edit.hidden = isUpload;
    actions.append(derive, regenerate, edit);
    if (onDelete) actions.append(button('この画像と下流を削除', safely(() => onDelete(graph.nodeMap.get(selectedId)?.job)), 'action danger'));
    const error = element('p', 'lineage-inspector-error'); error.hidden = true;
    const errorDetails = element('details', 'lineage-detail'); errorDetails.hidden = true;
    const errorText = element('pre'); errorDetails.append(element('summary', '', 'エラーの詳細'), errorText);
    const prompt = element('details', 'lineage-detail'); const promptSummary = element('summary', '', 'この画像の生成プロンプト'); const promptText = element('pre', '', value.job.prompt); prompt.append(promptSummary, promptText);
    const recipe = element('details', 'lineage-detail'); recipe.append(element('summary', '', 'テンプレート・生成条件'));
    const conditions = element('dl', 'lineage-generation-settings');
    const styleNames = { auto: 'おまかせ', photo: 'フォトリアル', illustration: 'イラスト', '3d': '3Dレンダー', minimal: 'ミニマル' };
    for (const [label, content] of [['指定サイズ', canvasSizeLabel(value.job.size, { full: true })], ['スタイル', styleNames[value.job.style] ?? value.job.style ?? 'おまかせ'], ['背景の透過', value.job.transparent ? 'リクエストあり' : 'リクエストなし']]) conditions.append(element('dt', '', label), element('dd', '', content));
    const layerList = element('div', 'lineage-layer-snapshots');
    const layers = value.job.layers ?? [];
    layerList.append(element('p', 'lineage-small-note', layers.length ? `生成時のテンプレート · ${layers.length}個` : 'テンプレートは使用していません。'));
    for (const [index, layer] of layers.entries()) {
      const snapshot = element('article', 'lineage-layer-snapshot'); const heading = element('div');
      heading.append(element('span', 'category-chip', categoryLabel(layer.category)), element('strong', '', `${index + 1}. ${layer.name}${layer.version ? ` · v${layer.version}` : ''}`));
      snapshot.append(heading, element('p', '', layer.body)); layerList.append(snapshot);
    }
    recipe.append(conditions, layerList);
    const uploadDetails = element('div', 'lineage-upload-details');
    if (isUpload) {
      uploadDetails.append(element('p', 'lineage-upload-origin-label', 'アップロードした参照の起点'));
      const information = element('dl', 'lineage-generation-settings');
      const bytes = value.job.image?.bytes;
      const fileSize = Number.isFinite(bytes) ? `${(bytes / 1024 / 1024).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} MB` : '未記録';
      const dimensions = value.job.image?.width && value.job.image?.height ? `${value.job.image.width} × ${value.job.image.height} px` : '未記録';
      for (const [label, content] of [['元のファイル名', value.job.name ?? '未記録'], ['寸法', dimensions], ['ファイル形式', value.job.image?.mime ?? '未記録'], ['ファイルサイズ', fileSize], ['保存日時', new Date(value.job.createdAt).toLocaleString('ja-JP')]]) information.append(element('dt', '', label), element('dd', '', content));
      uploadDetails.append(information);
    }
    const relationships = buildRelationships(value);
    const annotations = element('details', 'lineage-detail'); annotations.open = true; annotations.append(element('summary', '', 'タイトル・メモを管理'));
    const annotationForm = element('form', 'lineage-annotation-form');
    const nameLabel = element('label', '', 'タイトル'); const name = element('input'); name.type = 'text'; name.maxLength = 100; name.required = true; name.value = value.title; name.placeholder = '例：青いカップ・やわらかい光'; name.setAttribute('aria-label', isUpload ? 'アップロード画像のタイトル' : '生成履歴のタイトル'); nameLabel.append(name);
    const notesLabel = element('label', '', 'メモ'); const notes = element('textarea'); notes.maxLength = 2000; notes.value = value.notes; notes.placeholder = '変えた要素や、次に試したいこと'; notes.setAttribute('aria-label', isUpload ? 'アップロード画像のメモ' : '生成履歴のメモ'); notesLabel.append(notes);
    const save = button('タイトルとメモを保存', () => {}); save.type = 'submit'; annotationForm.append(nameLabel, notesLabel, save); annotations.append(annotationForm);
    const forId = selectedId;
    annotationForm.addEventListener('submit', async event => {
      event.preventDefault(); if (save.disabled) return; save.disabled = true;
      try { await api(`/api/lineage/${isUpload ? 'uploads' : 'jobs'}/${forId}`, { method: 'PATCH', body: JSON.stringify({ title: name.value, notes: notes.value }) }); await refresh(); toast('タイトルとメモを保存しました。'); }
      catch (error) { toast(error.message); } finally { save.disabled = false; }
    });
    const branchManagement = element('details', 'lineage-detail'); branchManagement.append(element('summary', '', 'ブランチ名を変更'));
    const branchForm = element('form', 'lineage-branch-form'); const branchName = element('input'); branchName.type = 'text'; branchName.maxLength = 80; branchName.required = true; branchName.value = value.branch?.name || ''; branchName.setAttribute('aria-label', 'ブランチ名');
    const branchSave = button('変更', () => {}); branchSave.type = 'submit'; branchSave.disabled = !value.branch; branchName.disabled = !value.branch;
    branchForm.append(branchName, branchSave); branchManagement.append(branchForm);
    branchForm.addEventListener('submit', async event => {
      event.preventDefault(); if (branchSave.disabled) return; branchSave.disabled = true;
      try { const branchId = graph.nodeMap.get(forId)?.branchId; await api(`/api/lineage/branches/${branchId}`, { method: 'PATCH', body: JSON.stringify({ name: branchName.value }) }); await refresh(); toast('ブランチ名を変更しました。'); }
      catch (error) { toast(error.message); } finally { branchSave.disabled = false; }
    });
    inspector.append(identity, image, actions, error, errorDetails, ...(isUpload ? [uploadDetails] : [prompt, recipe]), relationships, annotations, branchManagement);
    inspectorState = { title, status, branchLabel, image, derive, regenerate, edit, error, errorDetails, errorText, relationships, relationKey: '', branchName, branchSave, branchId: value.branchId };
  }

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.pointerType === 'touch' || event.target.closest('.lineage-node')) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging'); event.preventDefault();
  });
  viewport.addEventListener('pointermove', event => { if (drag?.pointerId !== event.pointerId) return; viewport.scrollLeft = drag.left - (event.clientX - drag.x); viewport.scrollTop = drag.top - (event.clientY - drag.y); });
  const endDrag = () => { drag = null; viewport.classList.remove('dragging'); };
  viewport.addEventListener('pointerup', endDrag); viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport) return;
    const movement = { ArrowLeft: [-130, 0], ArrowRight: [130, 0], ArrowUp: [0, -130], ArrowDown: [0, 130] }[event.key];
    if (movement) { event.preventDefault(); viewport.scrollBy({ left: movement[0], top: movement[1], behavior: 'smooth' }); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); setZoom(zoom + .15); }
    else if (event.key === '-') { event.preventDefault(); setZoom(zoom - .15); }
  });
  async function refresh() {
    if (destroyed) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try { metadata = await api('/api/lineage'); render(); }
    catch (error) { warning.textContent = `画像のつながりを読み込めませんでした。${error.message}`; warning.hidden = false; throw error; }
    finally { refreshing = false; if (refreshAgain) { refreshAgain = false; await refresh(); } }
  }
  render();
  return { refresh, render, select, showBatch, destroy() { destroyed = true; section.replaceChildren(); } };
}
