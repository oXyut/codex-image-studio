import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphImage, GraphPosition } from "../shared/lineage-utils.js";
import {
  buildLineageGraph,
  filterLineageGraph,
  layoutLineageGraph,
  lineageEdgePath,
  lineageBatchEdgePath,
} from '../shared/lineage-utils.js';
import type { LineageCommit } from '../shared/types.js';

const job = (id: string, number: number, changes: Partial<GraphImage> = {}) => ({ id, createdAt: new Date(Date.UTC(2026, 9, 2, 0, 0, number)).toISOString(), status: 'succeeded', prompt: `画像 ${id}`, references: [], ...changes });
const commit = (jobId: string, branchId: string, parentIds: string[] = [], changes: Partial<LineageCommit> = {}) => ({ jobId, branchId, parentIds, sourceJobId: parentIds[0] ?? null, operation: parentIds.length ? 'derive' : 'generate', title: '', notes: '', ...changes });

function hasOverlappingCards(positions: Map<string, GraphPosition>) {
  const cards = [...positions.values()];
  return cards.some((a, i) => cards.slice(i + 1).some(b => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y));
}

test('複数参照の合流と再生成元を別種の線で表し、独立した画像も可視化する', () => {
  const jobs = [job('person', 1), job('background', 2), job('merge', 3), job('retry', 4), job('isolated', 5)];
  const graph = buildLineageGraph({ commits: [commit('person', 'main'), commit('background', 'garden'), commit('merge', 'main', ['person', 'background']), commit('retry', 'retry-branch', ['person', 'background'], { sourceJobId: 'merge', operation: 'regenerate' }), commit('isolated', 'other')] }, jobs);
  assert.deepEqual(graph.nodeMap.get('merge')!.parents, ['person', 'background']);
  assert.deepEqual(graph.edges.filter(edge => edge.to === 'retry').map(edge => [edge.from, edge.kind]), [['person', 'reference'], ['background', 'reference'], ['merge', 'source']]);
  assert.equal(graph.nodeMap.get('retry')!.level, 2); assert.equal(graph.components.length, 2);
  const layout = layoutLineageGraph(graph); assert.equal(layout.positions.size, jobs.length); assert.equal(hasOverlappingCards(layout.positions), false);
  for (const edge of graph.edges) {
    const start = layout.positions.get(edge.from), end = layout.positions.get(edge.to);
    assert.ok(end!.x > start!.x, '親と入力元の画像が生成先より左側に配置される');
    assert.ok(!/NaN|undefined|Infinity/.test(lineageEdgePath(start!, end!)));
  }
});

test('参照を持たない最初の画像を再生成しても、元画像とのつながりを失わない', () => {
  const graph = buildLineageGraph({ commits: [commit('root', 'main'), commit('root-retry', 'retry', [], { sourceJobId: 'root', operation: 'regenerate' })] }, [job('root', 1), job('root-retry', 2)]);
  assert.equal(graph.components.length, 1); assert.deepEqual(graph.edges.map(edge => [edge.from, edge.to, edge.kind]), [['root', 'root-retry', 'source']]);
  assert.deepEqual(graph.nodeMap.get('root-retry')!.parents, [], '参照画像の親がない再生成で元画像を参照と混同しない');
  assert.deepEqual(graph.nodeMap.get('root-retry')!.dependencies, ['root']);
});

test('ブランチを絞り込んでもすべての参照元と入力編集元を残す', () => {
  const graph = buildLineageGraph({
    branches: [{ id: 'main', name: 'Main' }, { id: 'background', name: '庭' }, { id: 'retry', name: 'IPHONE案' }],
    commits: [commit('person', 'main'), commit('garden', 'background'), commit('merged', 'main', ['person', 'garden']), commit('retry', 'retry', ['person', 'garden'], { sourceJobId: 'merged', operation: 'regenerate', notes: '候補Bで検討' }), commit('unrelated', 'other')],
  }, [job('person', 1), job('garden', 2), job('merged', 3), job('retry', 4), job('unrelated', 5)]);
  const filtered = filterLineageGraph(graph, { branchId: 'retry', query: 'ｉＰｈｏｎｅ 候補b' });
  assert.deepEqual([...filtered.matchIds], ['retry']); assert.deepEqual([...filtered.visibleIds].sort(), ['garden', 'merged', 'person', 'retry']);
  assert.equal(filtered.edges.length, 5); assert.equal(filtered.filtered, true);
  const layout = layoutLineageGraph(graph, filtered); assert.equal(layout.positions.size, 4); assert.equal(hasOverlappingCards(layout.positions), false);
  const absent = filterLineageGraph(graph, { query: '存在しないキーワード' }); assert.equal(absent.nodes.length, 0); assert.equal(absent.edges.length, 0);
  const emptyLayout = layoutLineageGraph(graph, absent); assert.equal(emptyLayout.positions.size, 0); assert.ok(Number.isFinite(emptyLayout.height));
});

test('古い履歴、欠けた参照、循環を含むデータでも有限の図を描く', () => {
  const jobs = [job('a', 1, { references: [{ jobId: 'b' }, { jobId: 'missing' }, { jobId: 'b' }] }), job('b', 2, { references: [{ jobId: 'a' }] }), job('self', 3, { references: [{ jobId: 'self' }] }), job('a', 4)];
  const graph = buildLineageGraph({}, jobs);
  assert.equal(graph.nodes.length, 3, '同じジョブを重複表示しない');
  assert.equal(graph.missingEdges.length, 1); assert.equal(graph.missingEdges[0].from, 'missing');
  assert.equal(graph.cyclicEdges.length, 2); assert.equal(graph.edges.length, 1);
  const layout = layoutLineageGraph(graph); assert.equal(layout.positions.size, 3); assert.equal(hasOverlappingCards(layout.positions), false);
  for (const position of layout.positions.values()) assert.ok(Object.values(position).every(Number.isFinite));
});

test('時刻の順が親子関係と一致しなくても、多段の参照を左から右へ配置する', () => {
  const jobs = [job('leaf', 1), job('middle', 2), job('root', 3)];
  const graph = buildLineageGraph({ commits: [commit('leaf', 'main', ['middle']), commit('middle', 'main', ['root']), commit('root', 'main')] }, jobs);
  assert.equal(graph.nodeMap.get('root')!.level, 0); assert.equal(graph.nodeMap.get('middle')!.level, 1); assert.equal(graph.nodeMap.get('leaf')!.level, 2);
  const layout = layoutLineageGraph(graph); assert.ok(layout.positions.get('root')!.x < layout.positions.get('middle')!.x); assert.ok(layout.positions.get('middle')!.x < layout.positions.get('leaf')!.x);
});

test('独立した起点の同時作成を隣接配置し、親子関係と系統は追加しない', () => {
  const batch = { id: 'batch-one', count: 3 };
  const jobs = [job('a', 1, { batch: { ...batch, index: 3 } }), job('unrelated', 2), job('b', 3, { batch: { ...batch, index: 1 } }), job('c', 4, { batch: { ...batch, index: 2 } })];
  const graph = buildLineageGraph({}, jobs), layout = layoutLineageGraph(graph);
  assert.equal(graph.components.length, 4, '一括生成の仲間は参照関係の系統を偽造しない');
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(graph.batchMap.get(batch.id)!.nodeIds, ['b', 'c', 'a']);
  assert.equal(layout.batchGroups.length, 1); assert.deepEqual(layout.batchGroups[0].nodeIds, ['b', 'c', 'a']);
  assert.ok(layout.positions.get('b')!.y < layout.positions.get('c')!.y); assert.ok(layout.positions.get('c')!.y < layout.positions.get('a')!.y);
  assert.equal(layout.positions.get('a')!.x, layout.positions.get('b')!.x);
  assert.equal(hasOverlappingCards(layout.positions), false);
  const frame = layout.batchGroups[0], unrelated = layout.positions.get('unrelated');
  assert.ok(unrelated!.y >= frame.y + frame.height || unrelated!.y + unrelated!.height <= frame.y, '同時刻の単発画像を囲みに入れない');
});

test('同時作成フィルターは仲間とすべての参照・再生成元を残し、別の一括生成を混ぜない', () => {
  const batch = { id: 'batch-variants', count: 2 };
  const jobs = [job('person', 1), job('garden', 2), job('source', 3), job('variant-a', 4, { batch: { ...batch, index: 1 } }), job('variant-b', 5, { batch: { ...batch, index: 2 } }), job('other', 6, { batch: { id: 'other-batch', count: 2, index: 1 } })];
  const graph = buildLineageGraph({ commits: [commit('person', 'person'), commit('garden', 'garden'), commit('source', 'main', ['person', 'garden']), commit('variant-a', 'a', ['person', 'garden'], { sourceJobId: 'source', operation: 'regenerate' }), commit('variant-b', 'b', ['person', 'garden'], { sourceJobId: 'source', operation: 'regenerate' })] }, jobs);
  const visible = filterLineageGraph(graph, { batchId: batch.id }), layout = layoutLineageGraph(graph, visible);
  assert.deepEqual([...visible.matchIds], ['variant-a', 'variant-b']);
  assert.deepEqual([...visible.visibleIds].sort(), ['garden', 'person', 'source', 'variant-a', 'variant-b']);
  assert.equal(visible.edges.length, 8, '元の複数親と再生成元の線を維持する');
  assert.equal(layout.batchGroups.length, 1); assert.equal(layout.batchGroups[0].visibleCount, 2);
  assert.equal(hasOverlappingCards(layout.positions), false);
  for (const edge of visible.edges) assert.ok(layout.positions.get(edge.from)!.x < layout.positions.get(edge.to)!.x);
});

test('検索で同時作成の一部だけ表示すると全件数と削除数を残し、非表示の仲間を復活させない', () => {
  const batch = { id: 'filtered-batch', count: 4, deletedCount: 2 };
  const graph = buildLineageGraph({}, [job('chosen', 1, { batch: { ...batch, index: 1 }, prompt: '人物 昼' }), job('other', 2, { batch: { ...batch, index: 4 }, prompt: '人物 夜' })]);
  const visible = filterLineageGraph(graph, { query: '昼', batchId: batch.id }), layout = layoutLineageGraph(graph, visible);
  assert.deepEqual([...visible.visibleIds], ['chosen']); assert.equal(layout.positions.size, 1);
  assert.equal(layout.batchGroups[0].count, 4); assert.equal(layout.batchGroups[0].visibleCount, 1); assert.equal(layout.batchGroups[0].deletedCount, 2);
  assert.deepEqual(graph.batchMap.get(batch.id)!.nodeIds, ['chosen', 'other']);
  assert.equal(filterLineageGraph(graph, { batchId: 'missing-batch' }).nodes.length, 0);
});

test('作成時刻が同じでもbatch IDがない画像は同時作成として扱わない', () => {
  const graph = buildLineageGraph({}, [job('a', 1), job('b', 1), job('c', 1, { batch: { id: 'broken', index: 2, count: 1 } })]);
  assert.equal(graph.batches.length, 0); assert.equal(layoutLineageGraph(graph).batchGroups.length, 0);
});

test('異なる段の同時作成情報を含む履歴でも囲みと参照線を有限で重ならず配置する', () => {
  const batch = { id: 'legacy-batch', count: 2 };
  const graph = buildLineageGraph({ commits: [commit('a', 'main'), commit('b', 'main', ['a']), commit('single', 'other'), commit('merged', 'merge', ['b', 'single'])] }, [job('a', 1, { batch: { ...batch, index: 1 } }), job('single', 2), job('b', 3, { batch: { ...batch, index: 2 } }), job('merged', 4)]);
  const layout = layoutLineageGraph(graph); assert.equal(layout.batchGroups.length, 2); assert.equal(hasOverlappingCards(layout.positions), false);
  for (const frame of layout.batchGroups) assert.ok((['x', 'y', 'width', 'height'] as const).every(key => Number.isFinite(frame[key])));
  for (const edge of graph.edges) assert.ok(layout.positions.get(edge.from)!.x < layout.positions.get(edge.to)!.x);
});

test('同時作成を受付順の2列グリッドに圧縮し、元の画像IDと系統を保持する', () => {
  const batch = { id: 'four-grid', count: 4 };
  const jobs = [job('root', 0), ...[4, 2, 1, 3].map(index => job(`v${index}`, index, { batch: { ...batch, index }, references: [{ jobId: 'root' }] })), job('leaf', 5, { references: [{ jobId: 'v2' }] }), job('unrelated', 6)];
  const graph = buildLineageGraph({}, jobs), visible = filterLineageGraph(graph);
  const compact = layoutLineageGraph(graph, visible, { compactBatches: true, cardHeight: 200 });
  const expanded = layoutLineageGraph(graph, visible, { compactBatches: true, expandedBatchIds: new Set([batch.id]), cardHeight: 200 });
  assert.deepEqual(compact.batchGroups[0].nodeIds, ['v1', 'v2', 'v3', 'v4']);
  const [a, b, c, d] = ['v1', 'v2', 'v3', 'v4'].map(id => compact.positions.get(id)!);
  assert.equal(a.y, b.y); assert.equal(c.y, d.y); assert.equal(a.x, c.x); assert.equal(b.x, d.x);
  assert.ok(a.x < b.x && a.y < c.y);
  assert.ok(compact.height < expanded.height * 0.6, '4枚のまとまりで縦の表示領域を40%以上減らす');
  assert.equal(hasOverlappingCards(compact.positions), false);
  assert.deepEqual([...compact.positions.keys()].sort(), jobs.map(image => image.id).sort());
  assert.equal(graph.components.length, 2);
  assert.deepEqual(graph.edges.filter(edge => edge.to === 'leaf').map(edge => edge.from), ['v2']);
  assert.equal(graph.edges.length, 5, '同時作成の仲間の間に親子関係を追加しない');
  const group = compact.batchGroups[0], unrelated = compact.positions.get('unrelated')!;
  assert.ok(unrelated.y >= group.y + group.height);
});

test('2〜10枚と検索後の部分集合でも枠・次の世代の画像が重ならない', () => {
  for (let count = 2; count <= 10; count++) {
    const batch = { id: `grid-${count}`, count, deletedCount: 1 };
    const graph = buildLineageGraph({}, [job('root', 0), ...Array.from({ length: count - 1 }, (_, index) => job(`v${index}`, index + 1, { batch: { ...batch, index: index + 1 }, prompt: index === 0 ? '検索対象' : 'ほかの画像', references: [{ jobId: 'root' }] })), job('leaf', 20, { references: [{ jobId: 'v0' }] })]);
    const compact = layoutLineageGraph(graph, undefined, { compactBatches: true, cardHeight: 200 });
    assert.equal(hasOverlappingCards(compact.positions), false);
    const group = compact.batchGroups[0], leaf = compact.positions.get('leaf')!;
    assert.ok(group.x + group.width < leaf.x, '2列の枠幅を次の世代の開始位置に反映する');
    const filtered = layoutLineageGraph(graph, filterLineageGraph(graph, { query: '検索対象' }), { compactBatches: true });
    assert.deepEqual([...filtered.positions.keys()].sort(), ['root', 'v0']);
    assert.equal(filtered.batchGroups[0].visibleCount, 1);
    assert.equal(filtered.batchGroups[0].count, count);
    assert.equal(filtered.batchGroups[0].deletedCount, 1);
  }
});

test('参照元や入力元が複数でも保持し、異なる世代の同時作成を一つの枠に合流させない', () => {
  const batch = { id: 'legacy-grid', count: 2 };
  const graph = buildLineageGraph({ commits: [commit('a', 'main'), commit('source', 'other'), commit('b', 'main', ['a'], { sourceJobId: 'source', operation: 'edit' }), commit('leaf', 'leaf', ['a', 'b'])] }, [job('a', 1, { batch: { ...batch, index: 1 } }), job('source', 2), job('b', 3, { batch: { ...batch, index: 2 } }), job('leaf', 4)]);
  const layout = layoutLineageGraph(graph, undefined, { compactBatches: true });
  assert.equal(layout.batchGroups.length, 2);
  assert.equal(hasOverlappingCards(layout.positions), false);
  for (const edge of graph.edges) assert.ok(layout.positions.get(edge.from)!.x < layout.positions.get(edge.to)!.x);
  assert.deepEqual(graph.edges.filter(edge => edge.to === 'b').map(edge => [edge.from, edge.kind]), [['a', 'reference'], ['source', 'source']]);
});

test('グリッドの内側の画像への線はサムネイル間の余白を通り、仲間の画像に重ならない', () => {
  const batch = { id: 'routes', count: 4 };
  const graph = buildLineageGraph({}, [job('root', 0), ...[1, 2, 3, 4].map(index => job(`v${index}`, index, { batch: { ...batch, index }, references: [{ jobId: 'root' }] })), job('leaf', 5, { references: [{ jobId: 'v1' }] })]);
  const layout = layoutLineageGraph(graph, undefined, { compactBatches: true }), group = layout.batchGroups[0];
  // Sample the actual path, including Bezier sections, against the other grid images.
  function sample(path: string) {
    const parts = path.match(/[MLC]|-?\d+(?:\.\d+)?/g)!;
    const points: { x: number; y: number }[] = [];
    let current = { x: 0, y: 0 }, index = 0;
    const point = () => ({ x: Number(parts[index++]), y: Number(parts[index++]) });
    while (index < parts.length) {
      const command = parts[index++];
      if (command === 'M') { current = point(); continue; }
      const controls = command === 'C' ? [point(), point()] : null, end = point();
      for (let step = 0; step <= 50; step++) {
        const t = step / 50, s = 1 - t;
        points.push(controls ? { x: s ** 3 * current.x + 3 * s ** 2 * t * controls[0].x + 3 * s * t ** 2 * controls[1].x + t ** 3 * end.x, y: s ** 3 * current.y + 3 * s ** 2 * t * controls[0].y + 3 * s * t ** 2 * controls[1].y + t ** 3 * end.y } : { x: current.x + t * (end.x - current.x), y: current.y + t * (end.y - current.y) });
      }
      current = end;
    }
    return points;
  }
  for (const edge of graph.edges) {
    const path = lineageBatchEdgePath(layout.positions.get(edge.from)!, layout.positions.get(edge.to)!, group.nodeIds.includes(edge.from) ? group : undefined, group.nodeIds.includes(edge.to) ? group : undefined);
    assert.ok(!/NaN|undefined|Infinity/.test(path));
    for (const id of group.nodeIds.filter(id => id !== edge.from && id !== edge.to)) {
      const peer = layout.positions.get(id)!;
      assert.ok(sample(path).every(point => !(point.x > peer.x && point.x < peer.x + peer.width && point.y > peer.y && point.y < peer.y + peer.height)), `${edge.from}から${edge.to}の線が${id}を横切らない`);
    }
  }
});
