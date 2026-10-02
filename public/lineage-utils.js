export const lineageOperationNames = { generate: '新規生成', derive: '参照から生成', edit: '入力を編集', regenerate: '再生成', upload: '参照の起点' };
export const lineageStatusNames = { queued: '待機中', running: '生成中', succeeded: '完成', failed: 'エラー', cancelled: 'キャンセル', uploaded: 'アップロード' };
export const graphGeometry = { cardWidth: 184, cardHeight: 168, columnGap: 94, rowGap: 38, padding: 28, componentGap: 56 };

const text = value => typeof value === 'string' ? value : '';
const unique = values => [...new Set(values)];
const normalize = value => text(value).normalize('NFKC').toLocaleLowerCase('ja-JP');
const chronology = (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.id.localeCompare(b.id);
const batchOrder = (a, b) => (a.job.batch?.index ?? 0) - (b.job.batch?.index ?? 0) || chronology(a, b);
function batchId(job) { return typeof job.batch?.id === 'string' && job.batch.id && Number.isSafeInteger(job.batch.count) && job.batch.count > 1 && Number.isSafeInteger(job.batch.index) && job.batch.index > 0 && job.batch.index <= job.batch.count ? job.batch.id : ''; }
export function lineageBatchLabel(id) { return `同時作成 #${id.slice(0, 6)}`; }

// Older histories are visible before their metadata has been migrated by the server.
export function buildLineageGraph({ commits = [], branches = [], uploads = [] } = {}, jobs = []) {
  const metadata = new Map(commits.filter(value => value && typeof value.jobId === 'string').map(value => [value.jobId, value]));
  const branchMap = new Map(branches.filter(value => value && typeof value.id === 'string').map(value => [value.id, value]));
  const nodeMap = new Map();
  const images = [...jobs, ...(Array.isArray(uploads) ? uploads : []).map(upload => ({ ...upload, kind: 'upload', status: 'uploaded' }))];
  for (const job of images) {
    if (!job || typeof job.id !== 'string' || nodeMap.has(job.id)) continue;
    const commit = metadata.get(job.id) ?? job.lineage ?? {};
    const isUpload = job.kind === 'upload';
    const parentIds = isUpload ? [] : unique((Array.isArray(commit.parentIds) ? commit.parentIds : (job.references ?? []).map(value => value.jobId ?? value.uploadId)).filter(value => typeof value === 'string'));
    nodeMap.set(job.id, {
      id: job.id, kind: isUpload ? 'upload' : 'generation', job, branchId: text(commit.branchId), branch: branchMap.get(commit.branchId),
      parentIds, sourceJobId: isUpload ? null : text(commit.sourceJobId) || null,
      operation: isUpload ? 'upload' : lineageOperationNames[commit.operation] ? commit.operation : (parentIds.length ? 'derive' : 'generate'),
      title: text(commit.title), notes: text(commit.notes), createdAt: commit.createdAt ?? job.createdAt,
      batchId: isUpload ? '' : batchId(job),
      parents: [], children: [], dependencies: [], level: 0, componentId: null,
    });
  }
  const nodes = [...nodeMap.values()].sort(chronology);
  const candidates = [], missingEdges = [];
  for (const value of nodes) {
    for (const parentId of value.parentIds) {
      const edge = { from: parentId, to: value.id, kind: 'reference', label: '参照画像' };
      if (nodeMap.has(parentId)) candidates.push(edge); else missingEdges.push(edge);
    }
    if (value.sourceJobId && !value.parentIds.includes(value.sourceJobId)) {
      const edge = { from: value.sourceJobId, to: value.id, kind: 'source', label: value.operation === 'regenerate' ? '再生成' : '入力を編集' };
      if (nodeMap.has(value.sourceJobId)) candidates.push(edge); else missingEdges.push(edge);
    }
  }
  // Keep every valid reference. A corrupt cyclic link is reported instead of trapping layout.
  const adjacency = new Map(nodes.map(value => [value.id, []]));
  const edges = [], cyclicEdges = [];
  function reaches(start, target) {
    const stack = [start], seen = new Set();
    while (stack.length) { const id = stack.pop(); if (id === target) return true; if (seen.has(id)) continue; seen.add(id); stack.push(...adjacency.get(id)); }
    return false;
  }
  for (const edge of candidates) {
    if (edge.from === edge.to || reaches(edge.to, edge.from)) { cyclicEdges.push(edge); continue; }
    edges.push(edge); adjacency.get(edge.from).push(edge.to);
    nodeMap.get(edge.to).dependencies.push(edge.from);
    if (edge.kind === 'reference') { nodeMap.get(edge.to).parents.push(edge.from); nodeMap.get(edge.from).children.push(edge.to); }
  }
  const degree = new Map(nodes.map(value => [value.id, value.dependencies.length]));
  const queue = nodes.filter(value => !degree.get(value.id));
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const childId of adjacency.get(current.id)) {
      const child = nodeMap.get(childId); child.level = Math.max(child.level, current.level + 1);
      degree.set(childId, degree.get(childId) - 1); if (degree.get(childId) === 0) queue.push(child);
    }
  }
  const neighbors = new Map(nodes.map(value => [value.id, []]));
  for (const edge of edges) { neighbors.get(edge.from).push(edge.to); neighbors.get(edge.to).push(edge.from); }
  const components = [];
  for (const first of nodes) {
    if (first.componentId) continue;
    const component = { id: first.id, nodeIds: [], roots: [], title: '', createdAt: first.createdAt };
    const stack = [first.id];
    while (stack.length) {
      const id = stack.pop(), current = nodeMap.get(id); if (current.componentId) continue;
      current.componentId = component.id; component.nodeIds.push(id);
      if (!current.dependencies.length) component.roots.push(id); stack.push(...neighbors.get(id));
    }
    component.nodeIds.sort((a, b) => chronology(nodeMap.get(a), nodeMap.get(b)));
    component.title = lineageTitle(nodeMap.get(component.roots[0] ?? first.id)); components.push(component);
  }
  const batchMap = new Map();
  for (const value of nodes) {
    if (!value.batchId) continue;
    if (!batchMap.has(value.batchId)) batchMap.set(value.batchId, { id: value.batchId, nodeIds: [], count: value.job.batch.count, deletedCount: 0, createdAt: value.job.createdAt });
    const batch = batchMap.get(value.batchId); batch.nodeIds.push(value.id); batch.count = Math.max(batch.count, value.job.batch.count); batch.deletedCount = Math.max(batch.deletedCount, value.job.batch.deletedCount || 0);
  }
  for (const batch of batchMap.values()) batch.nodeIds.sort((a, b) => batchOrder(nodeMap.get(a), nodeMap.get(b)));
  return { nodes, nodeMap, edges, components, missingEdges, cyclicEdges, branches: [...branchMap.values()], batches: [...batchMap.values()], batchMap };
}

export function lineageTitle(value) { return value?.title || (value?.kind === 'upload' ? text(value.job?.name) || 'アップロードした画像' : text(value?.job?.basePrompt ?? value?.job?.prompt).trim().replace(/\s+/g, ' ') || 'テンプレートから生成'); }

export function filterLineageGraph(graph, { query = '', branchId = '', componentId = '', batchId = '' } = {}) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matches = graph.nodes.filter(value => (!branchId || value.branchId === branchId) && (!componentId || value.componentId === componentId) && (!batchId || value.batchId === batchId) && terms.every(term => normalize([value.title, value.notes, value.job.name, value.job.prompt, value.kind === 'upload' ? 'アップロード 参照の起点' : '', value.branch?.name, value.id, value.batchId ? lineageBatchLabel(value.batchId) : ''].join(' ')).includes(term)));
  const matchIds = new Set(matches.map(value => value.id));
  const visibleIds = new Set(matchIds), stack = [...matchIds];
  // Ancestors remain in view for a filtered branch or search, including all actual references.
  while (stack.length) for (const id of graph.nodeMap.get(stack.pop())?.dependencies ?? []) if (!visibleIds.has(id)) { visibleIds.add(id); stack.push(id); }
  return { nodes: graph.nodes.filter(value => visibleIds.has(value.id)), edges: graph.edges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to)), matchIds, visibleIds, filtered: Boolean(terms.length || branchId || componentId || batchId) };
}

export function layoutLineageGraph(graph, visible = filterLineageGraph(graph)) {
  const { cardWidth, cardHeight, columnGap, rowGap, padding, componentGap } = graphGeometry;
  const positions = new Map(), groups = [], batchGroups = [];
  // Batch peers share a display block. They remain separate ancestry components and gain no edges.
  const displayParents = new Map(graph.components.map(component => [component.id, component.id]));
  const displayRoot = id => { let root = id; while (displayParents.get(root) !== root) root = displayParents.get(root); return root; };
  for (const batch of graph.batches || []) {
    const components = unique(batch.nodeIds.filter(id => visible.visibleIds.has(id)).map(id => graph.nodeMap.get(id).componentId));
    for (const id of components.slice(1)) displayParents.set(displayRoot(id), displayRoot(components[0]));
  }
  const displayBlocks = new Map();
  for (const component of graph.components) { const root = displayRoot(component.id); if (!displayBlocks.has(root)) displayBlocks.set(root, []); displayBlocks.get(root).push(component.id); }
  let top = padding, maxLevel = 0;
  for (const [displayId, componentIds] of displayBlocks) {
    const members = visible.nodes.filter(value => componentIds.includes(value.componentId)); if (!members.length) continue;
    const minLevel = Math.min(...members.map(value => value.level));
    const columns = new Map();
    for (const value of members) { const level = value.level - minLevel; if (!columns.has(level)) columns.set(level, []); columns.get(level).push(value); maxLevel = Math.max(maxLevel, level); }
    let height = 0;
    for (const [level, values] of [...columns].sort(([a], [b]) => a - b)) {
      const average = value => { const parents = value.dependencies.map(id => positions.get(id)).filter(Boolean); return parents.length ? parents.reduce((total, point) => total + point.y, 0) / parents.length : top; };
      const units = new Map();
      for (const value of values) { const id = value.batchId ? `batch:${value.batchId}` : `node:${value.id}`; if (!units.has(id)) units.set(id, []); units.get(id).push(value); }
      const unitAverage = unit => unit.reduce((total, value) => total + average(value), 0) / unit.length;
      const ordered = [...units.values()].sort((a, b) => unitAverage(a) - unitAverage(b) || chronology(a[0], b[0]));
      let offset = 0;
      for (const unit of ordered) {
        if (unit[0].batchId) { unit.sort(batchOrder); offset += 36; }
        const firstY = top + offset, x = padding + level * (cardWidth + columnGap);
        for (const value of unit) { positions.set(value.id, { x, y: top + offset, width: cardWidth, height: cardHeight, level }); offset += cardHeight + rowGap; }
        if (unit[0].batchId) {
          const batch = graph.batchMap.get(unit[0].batchId);
          batchGroups.push({ id: batch.id, nodeIds: unit.map(value => value.id), x: x - 10, y: firstY - 34, width: cardWidth + 20, height: unit.length * (cardHeight + rowGap) - rowGap + 44, count: batch.count, visibleCount: batch.nodeIds.filter(id => visible.visibleIds.has(id)).length, deletedCount: batch.deletedCount });
        }
      }
      height = Math.max(height, offset - rowGap + (values.some(value => value.batchId) ? 10 : 0));
    }
    groups.push({ id: displayId, componentIds, top, height }); top += height + componentGap;
  }
  return { positions, groups, batchGroups, width: Math.max(480, padding * 2 + maxLevel * (cardWidth + columnGap) + cardWidth), height: Math.max(280, top - componentGap + padding), ...graphGeometry };
}

export function lineageEdgePath(from, to, geometry = graphGeometry) {
  const startX = from.x + geometry.cardWidth, startY = from.y + geometry.cardHeight / 2;
  const endX = to.x, endY = to.y + geometry.cardHeight / 2;
  const bend = Math.max(38, (endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}
