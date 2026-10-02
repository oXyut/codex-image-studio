import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './validation.js';
import { categories, searchTemplates } from '../public/prompt-utils.js';

export function validateTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('テンプレートの入力を確認してください。', 'INVALID_TEMPLATE', 400);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!name || name.length > 80 || !body || body.length > 2000) throw new AppError('名前は1〜80文字、内容は1〜2,000文字で入力してください。', 'INVALID_TEMPLATE', 400);
  if (!categories.some(([id]) => id === input.category)) throw new AppError('テンプレートの分類を選んでください。', 'INVALID_CATEGORY', 400);
  if (!Array.isArray(input.tags ?? []) || (input.tags ?? []).length > 12 || (input.tags ?? []).some(tag => typeof tag !== 'string' || tag.length > 40)) throw new AppError('タグは12個まで、各40文字以内で入力してください。', 'INVALID_TAGS', 400);
  if (input.favorite !== undefined && typeof input.favorite !== 'boolean') throw new AppError('お気に入りの指定を確認してください。', 'INVALID_TEMPLATE', 400);
  const tags = [...new Set((input.tags ?? []).map(tag => tag.trim().replace(/^#/, '')).filter(Boolean))];
  return { name, body, category: input.category, tags, favorite: input.favorite ?? false };
}

const starters = [
  { name: 'リネンのシャツ', category: 'clothing', tags: ['サンプル', '自然', 'カジュアル'], body: '生成りのリネンシャツ。自然な布のしわと、ゆったりしたシルエット。' },
  { name: '自然な顔立ち', category: 'face', tags: ['サンプル', '人物', '自然'], body: '自然な顔立ちと穏やかな表情。肌の質感を残し、過度な美肌加工をしない。' },
  { name: '肩にかかるボブ', category: 'hair', tags: ['サンプル', '人物', 'ボブ'], body: '肩にかかる長さのボブヘア。自然な毛流れと少しだけ動きのある髪。' },
  { name: '明るい白い背景', category: 'background', tags: ['サンプル', '白', 'スタジオ'], body: '明るい白い背景。被写体の周りには余白を持たせ、背景に文字や小物を置かない。' },
  { name: 'やわらかな暖色', category: 'color', tags: ['サンプル', '暖色', 'ナチュラル'], body: 'やわらかな暖色の色調。彩度は控えめで、自然な色を保つ。' },
  { name: 'iPhoneの日常スナップ', category: 'camera', tags: ['サンプル', 'iPhone', 'スナップ'], body: 'iPhoneで日常を撮影したような自然なスナップ写真。目線の高さで撮り、作り込みすぎない構図と現実的な質感。' },
  { name: '窓からのやわらかい光', category: 'lighting', tags: ['サンプル', '自然光', 'やわらかい'], body: '窓から入るやわらかい自然光。なだらかな影と自然なハイライト。' },
];

const managementFields = ['name', 'body', 'category', 'tags', 'favorite', 'archivedAt'];
const clone = value => structuredClone(value);
const positiveVersion = value => Number.isSafeInteger(value) && value > 0;

function requireObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('テンプレートの入力を確認してください。', 'INVALID_TEMPLATE', 400);
}
function validateExpectedVersion(input) {
  if (input.expectedVersion !== undefined && !positiveVersion(input.expectedVersion)) throw new AppError('編集元のバージョンを確認してください。', 'INVALID_TEMPLATE_VERSION', 400);
  return input.expectedVersion;
}
function checkVersion(item, expectedVersion) {
  if (expectedVersion !== undefined && item.version !== expectedVersion) throw new AppError('テンプレートが更新されています。最新の内容を確認してから、もう一度保存してください。', 'VERSION_CONFLICT', 409);
}
function sameSnapshot(left, right) {
  return managementFields.every(key => JSON.stringify(key === 'tags' ? [...left.tags].sort() : left[key]) === JSON.stringify(key === 'tags' ? [...right.tags].sort() : right[key]));
}
function revision(item, operation, createdAt, extra = {}) {
  const snapshot = Object.fromEntries(managementFields.map(key => [key, clone(item[key])]));
  return { templateId: item.id, id: item.id, version: item.version, operation, createdAt, ...snapshot, ...extra };
}
function findTemplate(items, id) {
  const item = items.find(entry => entry.id === id);
  if (!item) throw new AppError('テンプレートが見つかりません。', 'TEMPLATE_NOT_FOUND', 404);
  return item;
}

export class TemplateStore {
  constructor(path, { seed = true } = {}) { this.path = path; this.seed = seed; this.templates = []; this.revisions = []; this.writes = Promise.resolve(); }
  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(data.templates) || ![undefined, 1, 2].includes(data.version)) throw new Error('Invalid template store');
      if (data.version === 2) {
        if (!Array.isArray(data.revisions) || data.templates.some(item => !positiveVersion(item.version) || !data.revisions.some(entry => entry.templateId === item.id && entry.version === item.version))) throw new Error('Invalid template revisions');
        this.templates = clone(data.templates); this.revisions = clone(data.revisions);
      } else {
        this.templates = data.templates.map(item => ({ ...item, tags: [...item.tags], version: 1 }));
        this.revisions = this.templates.map(item => revision(item, 'create', item.createdAt));
        await this.mutate(() => null);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('テンプレートの保存ファイルを読み込めませんでした。data/templates.json を確認してください。');
      if (this.seed) for (const item of starters) await this.create(item);
    }
  }
  list(options = {}) { return clone(searchTemplates(this.templates, options)); }
  all() { return clone(this.templates); }
  get(id) { return clone(findTemplate(this.templates, id)); }
  versions(id) {
    this.get(id);
    return { templateId: id, versions: clone(this.revisions.filter(entry => entry.templateId === id).sort((a, b) => b.version - a.version)) };
  }
  getVersion(id, versionNumber) {
    this.get(id);
    if (!positiveVersion(versionNumber)) throw new AppError('バージョンを確認してください。', 'INVALID_TEMPLATE_VERSION', 400);
    const result = this.revisions.find(entry => entry.templateId === id && entry.version === versionNumber);
    if (!result) throw new AppError('テンプレートのバージョンが見つかりません。', 'TEMPLATE_VERSION_NOT_FOUND', 404);
    return clone(result);
  }
  mutate(fn) {
    const operation = this.writes.then(async () => {
      const items = clone(this.templates), revisions = clone(this.revisions);
      const result = fn(items, revisions);
      await writeFile(`${this.path}.tmp`, JSON.stringify({ version: 2, templates: items, revisions }, null, 2), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      this.templates = items; this.revisions = revisions; return clone(result);
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  create(input) {
    const valid = validateTemplate(input);
    return this.mutate((items, revisions) => {
      if (items.length >= 2000) throw new AppError('テンプレートの保存上限に達しました。', 'TEMPLATE_LIMIT', 400);
      const now = new Date().toISOString();
      const item = { id: randomUUID(), ...valid, createdAt: now, updatedAt: now, archivedAt: null, version: 1 };
      items.push(item); revisions.push(revision(item, 'create', now)); return item;
    });
  }
  update(id, input) {
    requireObject(input); const expectedVersion = validateExpectedVersion(input);
    return this.mutate((items, revisions) => {
      const item = findTemplate(items, id); checkVersion(item, expectedVersion);
      const changes = validateTemplate({ ...item, ...input });
      const updated = { ...item, ...changes };
      if (sameSnapshot(item, updated)) return item;
      Object.assign(item, changes, { version: item.version + 1, updatedAt: new Date().toISOString() });
      revisions.push(revision(item, 'update', item.updatedAt)); return item;
    });
  }
  archive(id, restore = false, input = {}) {
    requireObject(input); const expectedVersion = validateExpectedVersion(input);
    return this.mutate((items, revisions) => {
      const item = findTemplate(items, id); checkVersion(item, expectedVersion);
      if (restore ? !item.archivedAt : Boolean(item.archivedAt)) return item;
      const now = new Date().toISOString();
      Object.assign(item, { archivedAt: restore ? null : now, updatedAt: now, version: item.version + 1 });
      revisions.push(revision(item, restore ? 'unarchive' : 'archive', now)); return item;
    });
  }
  revert(id, input) {
    requireObject(input); const expectedVersion = validateExpectedVersion(input);
    if (!positiveVersion(input.version) || Object.keys(input).some(key => !['version', 'expectedVersion'].includes(key))) throw new AppError('復元するバージョンを確認してください。', 'INVALID_TEMPLATE_VERSION', 400);
    return this.mutate((items, revisions) => {
      const item = findTemplate(items, id); checkVersion(item, expectedVersion);
      const source = revisions.find(entry => entry.templateId === id && entry.version === input.version);
      if (!source) throw new AppError('テンプレートのバージョンが見つかりません。', 'TEMPLATE_VERSION_NOT_FOUND', 404);
      for (const key of managementFields) item[key] = clone(source[key]);
      item.version += 1; item.updatedAt = new Date().toISOString();
      revisions.push(revision(item, 'revert', item.updatedAt, { revertedFrom: source.version })); return item;
    });
  }
}
