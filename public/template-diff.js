import { categoryLabel } from './prompt-utils.js';

const linesOf = value => value === '' ? [] : String(value ?? '').replace(/\r\n/g, '\n').split('\n');

// Template bodies are limited to 2,000 characters. Bound the matrix as well so
// newline-heavy inputs cannot allocate an unnecessarily large diff table.
export function diffLines(before, after, { maxCells = 400000 } = {}) {
  const oldLines = linesOf(before), newLines = linesOf(after), result = [];
  let beforeLine = 1, afterLine = 1;
  const append = (type, text) => {
    result.push({ type, text, beforeLine: type === 'added' ? null : beforeLine++, afterLine: type === 'removed' ? null : afterLine++ });
  };
  if ((oldLines.length + 1) * (newLines.length + 1) > maxCells) {
    let start = 0, oldEnd = oldLines.length, newEnd = newLines.length;
    while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) append('unchanged', oldLines[start++]);
    while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
    for (let index = start; index < oldEnd; index++) append('removed', oldLines[index]);
    for (let index = start; index < newEnd; index++) append('added', newLines[index]);
    for (let index = oldEnd; index < oldLines.length; index++) append('unchanged', oldLines[index]);
    return result;
  }
  const width = newLines.length + 1;
  const table = new Uint16Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      table[oldIndex * width + newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * width + newIndex], table[oldIndex * width + newIndex + 1]);
    }
  }
  let oldIndex = 0, newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) append('unchanged', oldLines[oldIndex++]), newIndex++;
    else if (oldIndex < oldLines.length && (newIndex >= newLines.length || table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1])) append('removed', oldLines[oldIndex++]);
    else append('added', newLines[newIndex++]);
  }
  return result;
}

export function templateMetadataDiff(before, after) {
  const fields = [
    ['name', '名前', value => value || '名称なし'],
    ['category', '分類', categoryLabel],
    ['tags', 'タグ', value => value?.length ? value.map(tag => `#${tag}`).join(' ') : 'なし'],
    ['favorite', 'お気に入り', value => value ? '登録済み' : '未登録'],
    ['archivedAt', '保存状態', value => value ? 'アーカイブ' : '使用中'],
  ];
  return fields.map(([key, label, format]) => {
    const oldValue = key === 'archivedAt' ? Boolean(before[key]) : before[key];
    const newValue = key === 'archivedAt' ? Boolean(after[key]) : after[key];
    return { key, label, before: format(before[key]), after: format(after[key]), changed: JSON.stringify(oldValue) !== JSON.stringify(newValue) };
  });
}

export function compareTemplateVersions(before, after) {
  const lines = diffLines(before.body, after.body);
  const metadata = templateMetadataDiff(before, after);
  return { lines, metadata, added: lines.filter(line => line.type === 'added').length, removed: lines.filter(line => line.type === 'removed').length, changedFields: metadata.filter(field => field.changed).length };
}
