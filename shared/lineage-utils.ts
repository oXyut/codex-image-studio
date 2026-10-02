import type { Batch, ImageSource, LineageBranch, LineageCommit, Reference } from './types.js';
export type GraphImage = {
  id: string; createdAt: string; kind?: string; status?: string; name?: string; prompt?: string; basePrompt?: string;
  references?: Partial<Reference>[]; batch?: Partial<Batch>; lineage?: Partial<LineageCommit> | null;
};
type Branch = Pick<LineageBranch, 'id' | 'name'> & Partial<LineageBranch>;
export type LineageNode<T extends GraphImage = ImageSource> = {
  id: string; kind: 'upload' | 'generation'; job: T; branchId: string; branch?: Branch;
  parentIds: string[]; sourceJobId: string | null; operation: string; title: string; notes: string; createdAt: string;
  batchId: string; parents: string[]; children: string[]; dependencies: string[]; level: number; componentId: string;
};
export type LineageEdge = { from: string; to: string; kind: 'reference' | 'source'; label: string };
type Component = { id: string; nodeIds: string[]; roots: string[]; title: string; createdAt: string };
type GraphBatch = { id: string; nodeIds: string[]; count: number; deletedCount: number; createdAt: string };
export type LineageGraph<T extends GraphImage = ImageSource> = {
  nodes: LineageNode<T>[]; nodeMap: Map<string, LineageNode<T>>; edges: LineageEdge[]; components: Component[];
  missingEdges: LineageEdge[]; cyclicEdges: LineageEdge[]; branches: Branch[]; batches: GraphBatch[]; batchMap: Map<string, GraphBatch>;
};
export type VisibleGraph<T extends GraphImage = ImageSource> = {
  nodes: LineageNode<T>[]; edges: LineageEdge[]; matchIds: Set<string>; visibleIds: Set<string>; filtered: boolean;
};
export type GraphPosition = { x: number; y: number; width: number; height: number; level: number; compact?: boolean };
export type BatchGroup = {
  id: string; nodeIds: string[]; x: number; y: number; width: number; height: number;
  count: number; visibleCount: number; deletedCount: number; compact: boolean;
};
type LayoutOptions = { compactBatches?: boolean; expandedBatchIds?: ReadonlySet<string>; cardHeight?: number };
export type GraphLayout = ReturnType<typeof layoutLineageGraph>;
export const lineageOperationNames: Record<string, string> = { generate: '新規生成', derive: '参照から生成', edit: '入力を編集', regenerate: '再生成', upload: '参照の起点' };
export const lineageStatusNames: Record<string, string> = { queued: '待機中', running: '生成中', succeeded: '完成', failed: 'エラー', cancelled: 'キャンセル', uploaded: 'アップロード' };
export const graphGeometry = { cardWidth: 184, cardHeight: 168, columnGap: 94, rowGap: 38, padding: 28, componentGap: 56 };
export const compactBatchGeometry = { cardWidth: 128, cardHeight: 140, gap: 12, padding: 12, headerHeight: 56, footerHeight: 52 };

const text = (value: unknown) => typeof value === 'string' ? value : '';
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const normalize = (value: unknown) => text(value).normalize('NFKC').toLocaleLowerCase('ja-JP');
const chronology = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.id.localeCompare(b.id);
const batchOrder = (a: LineageNode<GraphImage>, b: LineageNode<GraphImage>) => (a.job.batch?.index ?? 0) - (b.job.batch?.index ?? 0) || chronology(a, b);
function batchId(job: GraphImage) { return typeof job.batch?.id === 'string' && job.batch.id && Number.isSafeInteger(job.batch.count) && job.batch.count! > 1 && Number.isSafeInteger(job.batch.index) && job.batch.index! > 0 && job.batch.index! <= job.batch.count! ? job.batch.id : ''; }
export function lineageBatchLabel(id: string) { return `同時作成 #${id.slice(0, 6)}`; }

// Older histories are visible before their metadata has been migrated by the server.
export function buildLineageGraph<T extends GraphImage = ImageSource, U extends GraphImage = T>({ commits = [], branches = [], uploads = [] }: { commits?: (Partial<LineageCommit> & { jobId: string })[]; branches?: Branch[]; uploads?: U[] } = {}, jobs: T[] = []): LineageGraph<T | U> {
  const metadata = new Map(commits.filter(value => value && typeof value.jobId === 'string').map(value => [value.jobId, value]));
  const branchMap = new Map(branches.filter(value => value && typeof value.id === 'string').map(value => [value.id, value]));
  const nodeMap = new Map<string, LineageNode<T | U>>();
  const images = [...jobs, ...(Array.isArray(uploads) ? uploads : []).map(upload => ({ ...upload, kind: 'upload' as const, status: 'uploaded' }))];
  for (const job of images) {
    if (!job || typeof job.id !== 'string' || nodeMap.has(job.id)) continue;
    const commit = metadata.get(job.id) ?? job.lineage ?? {};
    const isUpload = job.kind === 'upload';
    const parentIds = isUpload ? [] : unique((Array.isArray(commit.parentIds) ? commit.parentIds : (job.references ?? []).map(value => value.jobId ?? value.uploadId)).filter((value): value is string => typeof value === 'string'));
    nodeMap.set(job.id, {
      id: job.id, kind: isUpload ? 'upload' : 'generation', job, branchId: text(commit.branchId), branch: branchMap.get(commit.branchId ?? ''),
      parentIds, sourceJobId: isUpload ? null : text(commit.sourceJobId) || null,
      operation: isUpload ? 'upload' : lineageOperationNames[commit.operation ?? ''] ? commit.operation! : (parentIds.length ? 'derive' : 'generate'),
      title: text(commit.title), notes: text(commit.notes), createdAt: commit.createdAt ?? job.createdAt,
      batchId: isUpload ? '' : batchId(job),
      parents: [], children: [], dependencies: [], level: 0, componentId: '',
    });
  }
  const nodes = [...nodeMap.values()].sort(chronology);
  const candidates: LineageEdge[] = [], missingEdges: LineageEdge[] = [];
  for (const value of nodes) {
    for (const parentId of value.parentIds) {
      const edge: LineageEdge = { from: parentId, to: value.id, kind: 'reference', label: '参照画像' };
      if (nodeMap.has(parentId)) candidates.push(edge); else missingEdges.push(edge);
    }
    if (value.sourceJobId && !value.parentIds.includes(value.sourceJobId)) {
      const edge: LineageEdge = { from: value.sourceJobId, to: value.id, kind: 'source', label: value.operation === 'regenerate' ? '再生成' : '入力を編集' };
      if (nodeMap.has(value.sourceJobId)) candidates.push(edge); else missingEdges.push(edge);
    }
  }
  // Keep every valid reference. A corrupt cyclic link is reported instead of trapping layout.
  const adjacency = new Map<string, string[]>(nodes.map(value => [value.id, []]));
  const edges: LineageEdge[] = [], cyclicEdges: LineageEdge[] = [];
  function reaches(start: string, target: string) {
    const stack = [start], seen = new Set();
    while (stack.length) { const id = stack.pop()!; if (id === target) return true; if (seen.has(id)) continue; seen.add(id); stack.push(...adjacency.get(id)!); }
    return false;
  }
  for (const edge of candidates) {
    if (edge.from === edge.to || reaches(edge.to, edge.from)) { cyclicEdges.push(edge); continue; }
    edges.push(edge); adjacency.get(edge.from)!.push(edge.to);
    nodeMap.get(edge.to)!.dependencies.push(edge.from);
    if (edge.kind === 'reference') { nodeMap.get(edge.to)!.parents.push(edge.from); nodeMap.get(edge.from)!.children.push(edge.to); }
  }
  const degree = new Map(nodes.map(value => [value.id, value.dependencies.length]));
  const queue = nodes.filter(value => !degree.get(value.id)!);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const childId of adjacency.get(current.id)!) {
      const child = nodeMap.get(childId)!; child.level = Math.max(child.level, current.level + 1);
      degree.set(childId, degree.get(childId)! - 1); if (degree.get(childId)! === 0) queue.push(child);
    }
  }
  const neighbors = new Map<string, string[]>(nodes.map(value => [value.id, []]));
  for (const edge of edges) { neighbors.get(edge.from)!.push(edge.to); neighbors.get(edge.to)!.push(edge.from); }
  const components: Component[] = [];
  for (const first of nodes) {
    if (first.componentId) continue;
    const component: Component = { id: first.id, nodeIds: [], roots: [], title: '', createdAt: first.createdAt };
    const stack = [first.id];
    while (stack.length) {
      const id = stack.pop()!, current = nodeMap.get(id)!; if (current.componentId) continue;
      current.componentId = component.id; component.nodeIds.push(id);
      if (!current.dependencies.length) component.roots.push(id); stack.push(...neighbors.get(id)!);
    }
    component.nodeIds.sort((a, b) => chronology(nodeMap.get(a)!, nodeMap.get(b)!));
    component.title = lineageTitle(nodeMap.get(component.roots[0] ?? first.id)!); components.push(component);
  }
  const batchMap = new Map<string, GraphBatch>();
  for (const value of nodes) {
    if (!value.batchId) continue;
    if (!batchMap.has(value.batchId)) batchMap.set(value.batchId, { id: value.batchId, nodeIds: [], count: value.job.batch!.count!, deletedCount: 0, createdAt: value.job.createdAt });
    const batch = batchMap.get(value.batchId)!; batch.nodeIds.push(value.id); batch.count = Math.max(batch.count, value.job.batch!.count!); batch.deletedCount = Math.max(batch.deletedCount, value.job.batch!.deletedCount || 0);
  }
  for (const batch of batchMap.values()) batch.nodeIds.sort((a, b) => batchOrder(nodeMap.get(a)!, nodeMap.get(b)!));
  return { nodes, nodeMap, edges, components, missingEdges, cyclicEdges, branches: [...branchMap.values()], batches: [...batchMap.values()], batchMap };
}

export function lineageTitle(value: { title?: string; kind?: string; job?: { name?: string; basePrompt?: string; prompt?: string } } | null | undefined) { return value?.title || (value?.kind === 'upload' ? text(value.job?.name) || 'アップロードした画像' : text(value?.job?.basePrompt ?? value?.job?.prompt).trim().replace(/\s+/g, ' ') || 'テンプレートから生成'); }

export function filterLineageGraph<T extends GraphImage>(graph: LineageGraph<T>, { query = '', branchId = '', componentId = '', batchId = '' } = {}): VisibleGraph<T> {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matches = graph.nodes.filter(value => (!branchId || value.branchId === branchId) && (!componentId || value.componentId === componentId) && (!batchId || value.batchId === batchId) && terms.every(term => normalize([value.title, value.notes, value.job.name, value.job.prompt, value.kind === 'upload' ? 'アップロード 参照の起点' : '', value.branch?.name, value.id, value.batchId ? lineageBatchLabel(value.batchId) : ''].join(' ')).includes(term)));
  const matchIds = new Set(matches.map(value => value.id));
  const visibleIds = new Set(matchIds), stack = [...matchIds];
  // Ancestors remain in view for a filtered branch or search, including all actual references.
  while (stack.length) for (const id of graph.nodeMap.get(stack.pop()!)?.dependencies ?? []) if (!visibleIds.has(id)) { visibleIds.add(id); stack.push(id); }
  return { nodes: graph.nodes.filter(value => visibleIds.has(value.id)), edges: graph.edges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to)), matchIds, visibleIds, filtered: Boolean(terms.length || branchId || componentId || batchId) };
}

export function layoutLineageGraph<T extends GraphImage>(graph: LineageGraph<T>, visible = filterLineageGraph(graph), options: LayoutOptions = {}) {
  const { cardWidth, columnGap, rowGap, padding, componentGap } = graphGeometry;
  const cardHeight = options.cardHeight ?? graphGeometry.cardHeight;
  const positions = new Map<string, GraphPosition>(), groups: { id: string; componentIds: string[]; top: number; height: number }[] = [], batchGroups: BatchGroup[] = [];
  const isCompact = (unit: LineageNode<T>[]) => Boolean(options.compactBatches && unit[0].batchId && !options.expandedBatchIds?.has(unit[0].batchId));
  const unitWidth = (unit: LineageNode<T>[]) => isCompact(unit)
    ? Math.min(2, unit.length) * compactBatchGeometry.cardWidth + (unit.length > 1 ? compactBatchGeometry.gap : 0) + compactBatchGeometry.padding * 2
    : cardWidth + (unit[0].batchId ? 20 : 0);
  // Batch peers share a display block. They remain separate ancestry components and gain no edges.
  const displayParents = new Map(graph.components.map(component => [component.id, component.id]));
  const displayRoot = (id: string) => { let root = id; while (displayParents.get(root)! !== root) root = displayParents.get(root)!; return root; };
  for (const batch of graph.batches || []) {
    const components = unique(batch.nodeIds.filter(id => visible.visibleIds.has(id)).map(id => graph.nodeMap.get(id)!.componentId));
    for (const id of components.slice(1)) displayParents.set(displayRoot(id), displayRoot(components[0]));
  }
  const displayBlocks = new Map<string, string[]>();
  for (const component of graph.components) { const root = displayRoot(component.id); if (!displayBlocks.has(root)) displayBlocks.set(root, []); displayBlocks.get(root)!.push(component.id); }
  let top = padding, right = padding;
  for (const [displayId, componentIds] of displayBlocks) {
    const members = visible.nodes.filter(value => componentIds.includes(value.componentId)); if (!members.length) continue;
    const minLevel = Math.min(...members.map(value => value.level));
    const columns = new Map<number, Map<string, LineageNode<T>[]>>();
    for (const value of members) {
      const level = value.level - minLevel;
      if (!columns.has(level)) columns.set(level, new Map());
      const units = columns.get(level)!;
      const id = value.batchId ? `batch:${value.batchId}` : `node:${value.id}`;
      if (!units.has(id)) units.set(id, []);
      units.get(id)!.push(value);
    }
    let height = 0, x = padding;
    for (const [level, units] of [...columns].sort(([a], [b]) => a - b)) {
      const average = (value: LineageNode<T>) => { const parents = value.dependencies.map(id => positions.get(id)).filter((point): point is GraphPosition => Boolean(point)); return parents.length ? parents.reduce((total, point) => total + point.y, 0) / parents.length : top; };
      const unitAverage = (unit: LineageNode<T>[]) => unit.reduce((total, value) => total + average(value), 0) / unit.length;
      const ordered = [...units.values()].sort((a, b) => unitAverage(a) - unitAverage(b) || chronology(a[0], b[0]));
      let offset = 0;
      for (const unit of ordered) {
        const y = top + offset;
        if (unit[0].batchId) {
          unit.sort(batchOrder);
          const compact = isCompact(unit), columns = compact ? Math.min(2, unit.length) : 1;
          const width = compact ? compactBatchGeometry.cardWidth : cardWidth;
          const height = compact ? compactBatchGeometry.cardHeight : cardHeight;
          const gap = compact ? compactBatchGeometry.gap : rowGap;
          const inset = compact ? compactBatchGeometry.padding : 10;
          const header = compactBatchGeometry.headerHeight;
          const footer = options.compactBatches ? compactBatchGeometry.footerHeight : 10;
          const rows = Math.ceil(unit.length / columns);
          const groupHeight = header + rows * height + (rows - 1) * gap + footer;
          for (const [index, value] of unit.entries()) positions.set(value.id, {
            x: x + inset + (index % columns) * (width + gap), y: y + header + Math.floor(index / columns) * (height + gap),
            width, height, level, ...(compact ? { compact: true } : {}),
          });
          const batch = graph.batchMap.get(unit[0].batchId)!;
          batchGroups.push({ id: batch.id, nodeIds: unit.map(value => value.id), x, y, width: unitWidth(unit), height: groupHeight, count: batch.count, visibleCount: batch.nodeIds.filter(id => visible.visibleIds.has(id)).length, deletedCount: batch.deletedCount, compact });
          offset += groupHeight + rowGap;
        } else {
          positions.set(unit[0].id, { x, y, width: cardWidth, height: cardHeight, level });
          offset += cardHeight + rowGap;
        }
      }
      height = Math.max(height, offset - rowGap);
      const columnWidth = Math.max(...ordered.map(unitWidth));
      right = Math.max(right, x + columnWidth);
      x += columnWidth + columnGap;
    }
    groups.push({ id: displayId, componentIds, top, height }); top += height + componentGap;
  }
  return { ...graphGeometry, cardHeight, positions, groups, batchGroups, width: Math.max(480, right + padding), height: Math.max(280, top - componentGap + padding) };
}

// Route connections through grid gutters, so a left-column image never draws a
// derivation through its right-hand peer and a right-column target stays identifiable.
export function lineageBatchEdgePath(from: GraphPosition, to: GraphPosition, sourceGroup?: BatchGroup, targetGroup?: BatchGroup) {
  const start = { x: from.x + from.width, y: from.y + from.height / 2 };
  const end = { x: to.x, y: to.y + to.height / 2 };
  const halfGap = compactBatchGeometry.gap / 2;
  let source = start, target = end;
  let prefix = `M ${start.x} ${start.y}`, suffix = '';
  if (sourceGroup?.compact && start.x < sourceGroup.x + sourceGroup.width - compactBatchGeometry.padding) {
    source = { x: sourceGroup.x + sourceGroup.width + halfGap, y: from.y + from.height + halfGap };
    prefix += ` L ${start.x + halfGap} ${start.y} L ${start.x + halfGap} ${source.y} L ${source.x} ${source.y}`;
  }
  if (targetGroup?.compact && to.x > targetGroup.x + compactBatchGeometry.padding) {
    target = { x: targetGroup.x - halfGap, y: to.y - halfGap };
    suffix = ` L ${end.x - halfGap} ${target.y} L ${end.x - halfGap} ${end.y} L ${end.x} ${end.y}`;
  }
  const bend = Math.max(12, (target.x - source.x) / 2);
  return `${prefix} C ${source.x + bend} ${source.y}, ${target.x - bend} ${target.y}, ${target.x} ${target.y}${suffix}`;
}

export function lineageEdgePath(from: { x: number; y: number }, to: { x: number; y: number }, geometry = graphGeometry) {
  const startX = from.x + geometry.cardWidth, startY = from.y + geometry.cardHeight / 2;
  const endX = to.x, endY = to.y + geometry.cardHeight / 2;
  const bend = Math.max(38, (endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}
