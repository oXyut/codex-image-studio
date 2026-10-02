import { AppError, validateInput } from './validation.js';
import { validateTemplate } from './template-store.js';
import { composePrompt, referenceRoles } from '../public/prompt-utils.js';

const idPattern = /^[a-f0-9-]{36}$/;
export function prepareGeneration(input, templates, jobs, uploads, lineage = jobs?.lineage) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('入力を確認してください。', 'INVALID_INPUT', 400);
  let layers = input.layers ?? [];
  if (input.templateIds !== undefined) {
    if (!Array.isArray(input.templateIds) || input.templateIds.length > 12 || input.templateIds.some(id => typeof id !== 'string' || !idPattern.test(id))) throw new AppError('テンプレートは12個まで選べます。', 'INVALID_LAYERS', 400);
    layers = input.templateIds.map(id => templates.get(id));
  }
  if (!Array.isArray(layers) || layers.length > 12) throw new AppError('テンプレートは12個まで選べます。', 'INVALID_LAYERS', 400);
  layers = layers.map(layer => {
    if (!layer || typeof layer.id !== 'string' || !idPattern.test(layer.id)) throw new AppError('テンプレートの指定を確認してください。', 'INVALID_LAYERS', 400);
    if (layer.version !== undefined && (!Number.isSafeInteger(layer.version) || layer.version < 1)) throw new AppError('テンプレートのバージョンを確認してください。', 'INVALID_TEMPLATE_VERSION', 400);
    return { id: layer.id, ...validateTemplate(layer), ...(layer.version !== undefined ? { version: layer.version } : {}) };
  });
  if (new Set(layers.map(layer => layer.id)).size !== layers.length) throw new AppError('同じテンプレートが重複しています。', 'DUPLICATE_LAYER', 400);
  const valid = validateInput(input, { allowEmptyPrompt: layers.length > 0 });
  const prompt = composePrompt(valid.prompt, layers);
  if (prompt.length > 12000) throw new AppError('組み合わせたプロンプトは12,000文字までです。', 'PROMPT_TOO_LONG', 400);
  for (const layer of layers) if (layer.version !== undefined) {
    if (!templates || typeof templates.getVersion !== 'function') throw new AppError('テンプレートのバージョンを確認してください。', 'INVALID_TEMPLATE_VERSION', 400);
    const source = validateTemplate(templates.getVersion(layer.id, layer.version));
    if (['name', 'body', 'category', 'favorite'].some(key => layer[key] !== source[key]) || JSON.stringify([...layer.tags].sort()) !== JSON.stringify([...source.tags].sort())) throw new AppError('テンプレートの内容が指定されたバージョンと一致しません。履歴から選び直してください。', 'TEMPLATE_VERSION_MISMATCH', 400);
  }
  const references = input.references ?? [];
  if (!Array.isArray(references) || references.length > 4) throw new AppError('参照画像は4枚まで選べます。', 'INVALID_REFERENCES', 400);
  const resolved = references.map(reference => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference) || Object.keys(reference).some(key => !['jobId', 'uploadId', 'role'].includes(key)) ||
      (typeof reference.jobId === 'string') === (typeof reference.uploadId === 'string') ||
      !idPattern.test(reference.jobId ?? reference.uploadId) || !referenceRoles.some(([id]) => id === reference.role) ||
      (reference.jobId !== undefined && reference.uploadId !== undefined)) throw new AppError('参照画像の指定を確認してください。', 'INVALID_REFERENCES', 400);
    lineage?.assertActive(reference.jobId ?? reference.uploadId);
    if (reference.uploadId !== undefined) {
      if (!uploads) throw new AppError('アップロード画像が見つかりません。', 'UPLOAD_NOT_FOUND', 404);
      const source = uploads.get(reference.uploadId);
      return { uploadId: source.id, role: reference.role };
    }
    const source = jobs.get(reference.jobId);
    if (source.status !== 'succeeded' || !source.image || !/^image\.(png|jpg|webp)$/.test(source.image.fileName)) throw new AppError('完成した画像を参照に選んでください。', 'INVALID_REFERENCE_IMAGE', 400);
    return { jobId: source.id, role: reference.role };
  });
  if (new Set(resolved.map(reference => reference.jobId ?? reference.uploadId)).size !== resolved.length) throw new AppError('同じ参照画像が重複しています。', 'DUPLICATE_REFERENCE', 400);
  const lineageContext = validateLineageContext(input.lineageContext, resolved, jobs, uploads, lineage);
  return { ...valid, prompt, basePrompt: valid.prompt, layers, references: resolved, ...(lineageContext ? { lineageContext } : {}) };
}

function validateLineageContext(context, references, jobs, uploads, lineage) {
  if (context === undefined) return null;
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).some(key => !['sourceJobId', 'operation', 'newBranch'].includes(key)) ||
    typeof context.sourceJobId !== 'string' || !idPattern.test(context.sourceJobId) || !['derive', 'edit'].includes(context.operation) ||
    (context.newBranch !== undefined && typeof context.newBranch !== 'boolean')) throw new AppError('生成元の指定を確認してください。', 'INVALID_LINEAGE_CONTEXT', 400);
  lineage?.assertActive(context.sourceJobId);
  let source;
  try { source = jobs?.get(context.sourceJobId); } catch { /* An upload can also be an ancestry source. */ }
  if (!source) try { source = uploads?.get(context.sourceJobId); } catch { /* Report one consistent ancestry error. */ }
  if (!source) throw new AppError('生成元の画像が見つかりません。', 'INVALID_LINEAGE_CONTEXT', 400);
  if (context.operation === 'derive' && !references.some(reference => (reference.jobId ?? reference.uploadId) === context.sourceJobId)) throw new AppError('生成元の画像を参照に含めてください。', 'INVALID_LINEAGE_CONTEXT', 400);
  return { sourceJobId: context.sourceJobId, operation: context.operation, newBranch: context.newBranch ?? false };
}
