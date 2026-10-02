import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTemplateVersions, diffLines, templateMetadataDiff } from '../shared/template-diff.js';

test('line diff keeps common lines and numbers both sides of changes', () => {
  assert.deepEqual(diffLines('自然光\n白い壁\n正面', '自然光\n青い壁\n正面\niPhone風'), [
    { type: 'unchanged', text: '自然光', beforeLine: 1, afterLine: 1 },
    { type: 'removed', text: '白い壁', beforeLine: 2, afterLine: null },
    { type: 'added', text: '青い壁', beforeLine: null, afterLine: 2 },
    { type: 'unchanged', text: '正面', beforeLine: 3, afterLine: 3 },
    { type: 'added', text: 'iPhone風', beforeLine: null, afterLine: 4 },
  ]);
});

test('empty and newline-only templates have a readable diff', () => {
  assert.deepEqual(diffLines('', ''), []);
  assert.deepEqual(diffLines('', 'first\n'), [
    { type: 'added', text: 'first', beforeLine: null, afterLine: 1 },
    { type: 'added', text: '', beforeLine: null, afterLine: 2 },
  ]);
  assert.equal(diffLines('a\r\nb', 'a\nb').every(line => line.type === 'unchanged'), true);
});

test('bounded fallback reconstructs newline-heavy inputs without a large matrix', () => {
  const before = `start\n${Array(850).fill('old').join('\n')}\nend`, after = `start\n${Array(850).fill('new').join('\n')}\nend`;
  const diff = diffLines(before, after);
  assert.equal(diff.filter(line => line.type !== 'added').map(line => line.text).join('\n'), before);
  assert.equal(diff.filter(line => line.type !== 'removed').map(line => line.text).join('\n'), after);
  assert.equal(diff[0].type, 'unchanged');
  assert.equal(diff.at(-1)!.type, 'unchanged');
});

test('metadata diff includes all editable fields and archive state', () => {
  const before = { name: '白い背景', category: 'background', tags: ['白'], favorite: false, archivedAt: null };
  const after = { name: '青い背景', category: 'color', tags: ['青', '涼しい'], favorite: true, archivedAt: '2026-10-02T00:00:00Z' };
  const diff = templateMetadataDiff(before, after);
  assert.equal(diff.length, 5);
  assert.equal(diff.every(field => field.changed), true);
  assert.equal(diff.find(field => field.key === 'category')!.before, '背景');
  assert.equal(diff.find(field => field.key === 'archivedAt')!.after, 'アーカイブ');
  assert.equal(templateMetadataDiff(after, { ...after, archivedAt: '2026-10-03T00:00:00Z' }).find(field => field.key === 'archivedAt')!.changed, false);
});

test('diff treats markup as text and summarizes body and metadata separately', () => {
  const before = { name: 'test', category: 'other', tags: [], favorite: false, archivedAt: null, body: '<img src=x onerror=alert(1)>' };
  const after = { ...before, body: '<script>alert(2)</script>' };
  const diff = compareTemplateVersions(before, after);
  assert.deepEqual([diff.added, diff.removed, diff.changedFields], [1, 1, 0]);
  assert.equal(diff.lines[0].text, before.body);
  assert.equal(diff.lines[1].text, after.body);
});
