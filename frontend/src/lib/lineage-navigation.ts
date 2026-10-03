import { lineageTitle, type GraphImage, type GraphLayout, type LineageGraph } from '@shared/lineage-utils.js';

// Batch peers are navigated together without inventing ancestry edges between them.
export function lineageFamilies<T extends GraphImage>(graph: LineageGraph<T>) {
  const parents = new Map(graph.components.map(value => [value.id, value.id]));
  const root = (id: string): string => {
    let current = id;
    while (parents.get(current) !== current) current = parents.get(current)!;
    return current;
  };
  for (const batch of graph.batches) {
    const ids = batch.nodeIds.map(id => graph.nodeMap.get(id)!.componentId);
    for (const id of ids.slice(1)) parents.set(root(id), root(ids[0]));
  }
  const families = new Map<string, { id: string; title: string; nodeIds: string[]; componentIds: string[]; latestAt: string }>();
  for (const component of graph.components) {
    const id = root(component.id);
    if (!families.has(id)) families.set(id, { id, title: component.title, nodeIds: [], componentIds: [], latestAt: '' });
    const family = families.get(id)!;
    family.componentIds.push(component.id);
    family.nodeIds.push(...component.nodeIds);
    for (const nodeId of component.nodeIds) {
      const node = graph.nodeMap.get(nodeId)!;
      if (node.createdAt > family.latestAt) family.latestAt = node.createdAt;
    }
  }
  return [...families.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

export function initialLineageFamily<T extends GraphImage>(graph: LineageGraph<T>, selectedId: string | null) {
  const families = lineageFamilies(graph);
  return families.find(family => selectedId && family.nodeIds.includes(selectedId))?.id ?? families[0]?.id ?? '';
}

// Pack whole disconnected blocks; relationships and batch geometry inside each block stay intact.
export function packLineageOverview<T extends GraphImage>(graph: LineageGraph<T>, layout: GraphLayout): GraphLayout {
  const positions = new Map([...layout.positions].map(([id, point]) => [id, { ...point }]));
  const batchGroups = layout.batchGroups.map(group => ({ ...group }));
  const blocks = layout.groups.map(group => {
    const ids = graph.nodes.filter(node => group.componentIds.includes(node.componentId) && positions.has(node.id)).map(node => node.id);
    const points = ids.map(id => positions.get(id)!);
    const frames = batchGroups.filter(frame => frame.nodeIds.some(id => ids.includes(id)));
    const bounds = [...points, ...frames];
    const left = Math.min(...bounds.map(point => point.x));
    const top = Math.min(...bounds.map(point => point.y));
    return { group, ids, frames, left, top, width: Math.max(...bounds.map(point => point.x + point.width)) - left, height: Math.max(...bounds.map(point => point.y + point.height)) - top };
  });
  const targetWidth = Math.max(1300, ...blocks.map(block => block.width));
  const gap = 72, padding = 28;
  let x = padding, y = padding, rowHeight = 0, right = padding;
  const groups = blocks.map(block => {
    if (x > padding && x + block.width > targetWidth + padding) { x = padding; y += rowHeight + gap; rowHeight = 0; }
    const dx = x - block.left, dy = y - block.top;
    for (const id of block.ids) { const point = positions.get(id)!; point.x += dx; point.y += dy; }
    for (const frame of block.frames) { frame.x += dx; frame.y += dy; }
    const group = { ...block.group, top: y, height: block.height };
    right = Math.max(right, x + block.width); rowHeight = Math.max(rowHeight, block.height); x += block.width + gap;
    return group;
  });
  return { ...layout, positions, batchGroups, groups, width: right + padding, height: y + rowHeight + padding };
}

export function lineageRelationLabels<T extends GraphImage>(graph: LineageGraph<T>, id: string) {
  return graph.edges.filter(edge => edge.to === id).map(edge => `${edge.kind === 'source' ? '入力元' : '参照元'}: ${lineageTitle(graph.nodeMap.get(edge.from))}`);
}
