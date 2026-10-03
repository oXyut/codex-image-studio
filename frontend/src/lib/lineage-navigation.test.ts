import { describe, expect, it } from 'vitest';
import { buildLineageGraph, layoutLineageGraph, type GraphImage } from '@shared/lineage-utils.js';
import { initialLineageFamily, lineageFamilies, packLineageOverview } from './lineage-navigation';

const image = (id: string, minute: number, extra: Partial<GraphImage> = {}): GraphImage => ({ id, prompt: id, status: 'succeeded', createdAt: new Date(Date.UTC(2026, 9, 3, 0, minute)).toISOString(), ...extra });

describe('lineage navigation', () => {
  it('選択した系統を優先し、未選択なら最新の系統を選ぶ', () => {
    const graph = buildLineageGraph({}, [image('old', 0), image('child', 1, { references: [{ jobId: 'old' }] }), image('new', 2)]);
    expect(initialLineageFamily(graph, null)).toBe('new');
    expect(initialLineageFamily(graph, 'child')).toBe('old');
    expect(initialLineageFamily(graph, 'missing')).toBe('new');
    expect(initialLineageFamily(buildLineageGraph(), null)).toBe('');
  });

  it('同時作成とその下流を一緒に切り替え、独立した系統や参照線を偽造しない', () => {
    const batch = { id: 'batch', count: 2 };
    const graph = buildLineageGraph({}, [image('a', 0, { batch: { ...batch, index: 1 } }), image('b', 1, { batch: { ...batch, index: 2 } }), image('child', 2, { references: [{ jobId: 'a' }] }), image('separate', 3)]);
    expect(graph.components).toHaveLength(3);
    expect(graph.edges.map(edge => [edge.from, edge.to])).toEqual([['a', 'child']]);
    const families = lineageFamilies(graph);
    expect(families).toHaveLength(2);
    expect(families.find(family => family.nodeIds.includes('b'))!.nodeIds.sort()).toEqual(['a', 'b', 'child']);
    expect(initialLineageFamily(graph, 'child')).toBe(initialLineageFamily(graph, 'b'));
  });

  it('12件・6系統を横にも配置し、矢印の相対位置と同時作成の枠を保つ', () => {
    const jobs: GraphImage[] = Array.from({ length: 6 }, (_, i) => [image(`root-${i}`, i * 2), image(`child-${i}`, i * 2 + 1, { references: [{ jobId: `root-${i}` }] })]).flat();
    jobs[1].batch = { id: 'variants', count: 2, index: 1 };
    jobs[3].batch = { id: 'variants', count: 2, index: 2 };
    const graph = buildLineageGraph({}, jobs);
    const original = layoutLineageGraph(graph, undefined, { compactBatches: true, cardHeight: 200 });
    const packed = packLineageOverview(graph, original);
    expect(packed.height).toBeLessThan(original.height);
    expect(new Set(graph.components.map(component => packed.positions.get(component.nodeIds[0])!.x)).size).toBeGreaterThan(1);
    const cards = [...packed.positions.values()];
    expect(cards.some((a, i) => cards.slice(i + 1).some(b => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y))).toBe(false);
    for (const edge of graph.edges) {
      const beforeFrom = original.positions.get(edge.from)!, beforeTo = original.positions.get(edge.to)!;
      const from = packed.positions.get(edge.from)!, to = packed.positions.get(edge.to)!;
      expect([to.x - from.x, to.y - from.y]).toEqual([beforeTo.x - beforeFrom.x, beforeTo.y - beforeFrom.y]);
    }
    const frame = packed.batchGroups[0];
    for (const id of frame.nodeIds) {
      const point = packed.positions.get(id)!;
      expect(point.x).toBeGreaterThan(frame.x);
      expect(point.x + point.width).toBeLessThan(frame.x + frame.width);
      expect(point.y + point.height).toBeLessThan(frame.y + frame.height);
    }
    expect(original.positions.get('root-0')).not.toBe(packed.positions.get('root-0'));
  });

  it('空の概要図も有限の寸法で返す', () => {
    const graph = buildLineageGraph();
    const result = packLineageOverview(graph, layoutLineageGraph(graph));
    expect(Number.isFinite(result.width)).toBe(true);
    expect(Number.isFinite(result.height)).toBe(true);
  });
});
