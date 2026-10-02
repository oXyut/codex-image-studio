import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLineageGraph, filterLineageGraph, layoutLineageGraph, lineageEdgePath } from '../public/lineage-utils.js';

const job = (id, number, changes = {}) => ({ id, createdAt: new Date(Date.UTC(2026, 9, 2, 0, 0, number)).toISOString(), status: 'succeeded', prompt: `画像 ${id}`, references: [], ...changes });
const commit = (jobId, branchId, parentIds = [], changes = {}) => ({ jobId, branchId, parentIds, sourceJobId: parentIds[0] ?? null, operation: parentIds.length ? 'derive' : 'generate', title: '', notes: '', ...changes });

function hasOverlappingCards(positions) {
  const cards = [...positions.values()];
  return cards.some((a, i) => cards.slice(i + 1).some(b => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y));
}

test('複数参照の合流と再生成元を別種の線で表し、独立した画像も可視化する', () => {
  const jobs = [job('person', 1), job('background', 2), job('merge', 3), job('retry', 4), job('isolated', 5)];
  const graph = buildLineageGraph({ commits: [commit('person', 'main'), commit('background', 'garden'), commit('merge', 'main', ['person', 'background']), commit('retry', 'retry-branch', ['person', 'background'], { sourceJobId: 'merge', operation: 'regenerate' }), commit('isolated', 'other')] }, jobs);
  assert.deepEqual(graph.nodeMap.get('merge').parents, ['person', 'background']);
  assert.deepEqual(graph.edges.filter(edge => edge.to === 'retry').map(edge => [edge.from, edge.kind]), [['person', 'reference'], ['background', 'reference'], ['merge', 'source']]);
  assert.equal(graph.nodeMap.get('retry').level, 2); assert.equal(graph.components.length, 2);
  const layout = layoutLineageGraph(graph); assert.equal(layout.positions.size, jobs.length); assert.equal(hasOverlappingCards(layout.positions), false);
  for (const edge of graph.edges) {
    const start = layout.positions.get(edge.from), end = layout.positions.get(edge.to);
    assert.ok(end.x > start.x, '親と入力元の画像が生成先より左側に配置される');
    assert.ok(!/NaN|undefined|Infinity/.test(lineageEdgePath(start, end)));
  }
});

test('参照を持たない最初の画像を再生成しても、元画像とのつながりを失わない', () => {
  const graph = buildLineageGraph({ commits: [commit('root', 'main'), commit('root-retry', 'retry', [], { sourceJobId: 'root', operation: 'regenerate' })] }, [job('root', 1), job('root-retry', 2)]);
  assert.equal(graph.components.length, 1); assert.deepEqual(graph.edges.map(edge => [edge.from, edge.to, edge.kind]), [['root', 'root-retry', 'source']]);
  assert.deepEqual(graph.nodeMap.get('root-retry').parents, [], '参照画像の親がない再生成で元画像を参照と混同しない');
  assert.deepEqual(graph.nodeMap.get('root-retry').dependencies, ['root']);
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
  assert.equal(graph.nodeMap.get('root').level, 0); assert.equal(graph.nodeMap.get('middle').level, 1); assert.equal(graph.nodeMap.get('leaf').level, 2);
  const layout = layoutLineageGraph(graph); assert.ok(layout.positions.get('root').x < layout.positions.get('middle').x); assert.ok(layout.positions.get('middle').x < layout.positions.get('leaf').x);
});

test('独立した起点の同時作成を隣接配置し、親子関係と系統は追加しない', () => {
  const batch = { id: 'batch-one', count: 3 };
  const jobs = [job('a', 1, { batch: { ...batch, index: 3 } }), job('unrelated', 2), job('b', 3, { batch: { ...batch, index: 1 } }), job('c', 4, { batch: { ...batch, index: 2 } })];
  const graph = buildLineageGraph({}, jobs), layout = layoutLineageGraph(graph);
  assert.equal(graph.components.length, 4, '一括生成の仲間は参照関係の系統を偽造しない');
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(graph.batchMap.get(batch.id).nodeIds, ['b', 'c', 'a']);
  assert.equal(layout.batchGroups.length, 1); assert.deepEqual(layout.batchGroups[0].nodeIds, ['b', 'c', 'a']);
  assert.ok(layout.positions.get('b').y < layout.positions.get('c').y); assert.ok(layout.positions.get('c').y < layout.positions.get('a').y);
  assert.equal(layout.positions.get('a').x, layout.positions.get('b').x);
  assert.equal(hasOverlappingCards(layout.positions), false);
  const frame = layout.batchGroups[0], unrelated = layout.positions.get('unrelated');
  assert.ok(unrelated.y >= frame.y + frame.height || unrelated.y + unrelated.height <= frame.y, '同時刻の単発画像を囲みに入れない');
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
  for (const edge of visible.edges) assert.ok(layout.positions.get(edge.from).x < layout.positions.get(edge.to).x);
});

test('検索で同時作成の一部だけ表示すると全件数と削除数を残し、非表示の仲間を復活させない', () => {
  const batch = { id: 'filtered-batch', count: 4, deletedCount: 2 };
  const graph = buildLineageGraph({}, [job('chosen', 1, { batch: { ...batch, index: 1 }, prompt: '人物 昼' }), job('other', 2, { batch: { ...batch, index: 4 }, prompt: '人物 夜' })]);
  const visible = filterLineageGraph(graph, { query: '昼', batchId: batch.id }), layout = layoutLineageGraph(graph, visible);
  assert.deepEqual([...visible.visibleIds], ['chosen']); assert.equal(layout.positions.size, 1);
  assert.equal(layout.batchGroups[0].count, 4); assert.equal(layout.batchGroups[0].visibleCount, 1); assert.equal(layout.batchGroups[0].deletedCount, 2);
  assert.deepEqual(graph.batchMap.get(batch.id).nodeIds, ['chosen', 'other']);
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
  for (const frame of layout.batchGroups) assert.ok(['x', 'y', 'width', 'height'].every(key => Number.isFinite(frame[key])));
  for (const edge of graph.edges) assert.ok(layout.positions.get(edge.from).x < layout.positions.get(edge.to).x);
});
