const canvasSizes = new Map([
  ['auto', { name: '自動', ratio: '' }],
  ['square', { name: '正方形', ratio: '1 : 1' }],
  ['landscape', { name: '横長', ratio: '3 : 2' }],
  ['portrait', { name: '縦長', ratio: '2 : 3' }],
  ['widescreen', { name: 'ワイド', ratio: '16 : 9' }],
  ['vertical', { name: '縦ワイド', ratio: '9 : 16' }],
]);

export function normalizeCanvasSize(value: unknown): string { return typeof value === 'string' && canvasSizes.has(value) ? value : 'auto'; }

export function canvasSizeLabel(value: string | undefined, { full = false } = {}) {
  const size = canvasSizes.get(value ?? '');
  if (!size) return value || '未指定';
  return size.ratio ? (full ? `${size.name} · ${size.ratio}` : size.ratio) : size.name;
}
