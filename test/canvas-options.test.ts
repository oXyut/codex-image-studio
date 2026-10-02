import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasSizeLabel, normalizeCanvasSize } from '../shared/canvas-options.js';

test('自動サイズを保存・復元でき、既存の固定比率の下書きと生成条件も維持する', () => {
  for (const size of ['auto', 'square', 'landscape', 'portrait', 'widescreen', 'vertical']) {
    const restored = JSON.parse(JSON.stringify({ size }));
    assert.equal(normalizeCanvasSize(restored.size), size);
  }
  assert.equal(canvasSizeLabel('auto'), '自動');
  assert.equal(canvasSizeLabel('auto', { full: true }), '自動');
  assert.equal(canvasSizeLabel('square', { full: true }), '正方形 · 1 : 1');
});

test('古い下書きの未指定・不正なサイズは自動に戻し、DOMセレクターへ任意文字列を渡さない', () => {
  for (const value of [undefined, null, '', 'unknown', '__proto__', 'square] input[name=style', {}]) assert.equal(normalizeCanvasSize(value), 'auto');
});
