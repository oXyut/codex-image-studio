import { referenceRoles } from './prompt-utils.js';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function referenceSourceId(reference) { return reference?.uploadId || reference?.jobId; }
export function normalizeReferences(values) {
  if (!Array.isArray(values)) return [];
  const ids = new Set();
  return values.filter(value => {
    const id = referenceSourceId(value);
    if (!value || Boolean(value.jobId) === Boolean(value.uploadId) || !uuid.test(id) || !referenceRoles.some(([role]) => role === value.role) || ids.has(id)) return false;
    ids.add(id); return true;
  }).slice(0, 4).map(value => ({ [value.uploadId ? 'uploadId' : 'jobId']: referenceSourceId(value), role: value.role }));
}
export function reconcileDraftSources({ references, lineageContext }, { jobs = [], uploads = [], jobsLoaded = false, uploadsLoaded = false, removedIds = new Set() } = {}) {
  const jobIds = new Set(jobs.map(job => job.id)), uploadIds = new Set(uploads.map(upload => upload.id));
  const visible = references.filter(reference => !removedIds.has(referenceSourceId(reference)) && (reference.uploadId ? !uploadsLoaded || uploadIds.has(reference.uploadId) : !jobsLoaded || jobIds.has(reference.jobId)));
  const contextId = lineageContext?.sourceJobId;
  const context = removedIds.has(contextId) || (jobsLoaded && uploadsLoaded && contextId && !jobIds.has(contextId) && !uploadIds.has(contextId)) ? null : lineageContext;
  return { references: visible, lineageContext: context };
}
export function uploadFileType(file) {
  if (!file || !file.size) throw new Error('空のファイルはアップロードできません。');
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} は10MBを超えています。小さい画像を選んでください。`);
  const types = ['image/png', 'image/jpeg', 'image/webp'];
  if (types.includes(file.type)) return file.type;
  if (file.type && file.type !== 'application/octet-stream') throw new Error(`${file.name} は対応していない形式です。PNG・JPEG・WebPを選んでください。`);
  const extension = file.name?.split('.').pop()?.toLowerCase();
  const mime = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]).get(extension);
  if (!mime) throw new Error(`${file.name} は対応していない形式です。PNG・JPEG・WebPを選んでください。`);
  return mime;
}
