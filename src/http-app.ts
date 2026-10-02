import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Health, Job, Upload } from '../shared/types.js';
import { isRecord, record } from '../shared/unknown.js';
import type { JobManager, JobStore } from './job-store.js';
import type { LineageStore } from './lineage-store.js';
import type { LanAccess } from './lan-access.js';
import { lanDisabledPage } from './lan-access.js';
import { prepareGeneration } from './prompt-builder.js';
import type { TemplateStore } from './template-store.js';
import type { UploadStore } from './upload-store.js';
import { MAX_UPLOAD_BYTES } from './upload-store.js';
import { AppError, validateBatchCount } from './validation.js';

type AppOptions = { store: JobStore; manager: JobManager; adapter: { health: (force?: boolean) => Promise<Health> }; templates?: TemplateStore; lineage?: LineageStore; uploads?: UploadStore; publicDirectory: string; lanAccess?: LanAccess; lanHost?: string };

const assetTypes: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2' };

export function createApp({ store, manager, adapter, templates, lineage, uploads, publicDirectory, lanAccess, lanHost }: AppOptions) {
  if (lanHost && !lanAccess) throw new Error('LAN接続には端末認証が必要です。');
  if (lineage) { store.lineage = lineage; if (uploads) uploads.lineage = lineage; }
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const styleNonce = randomBytes(18).toString('base64');
    response.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self' data:; style-src 'self' 'nonce-${styleNonce}'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    response.setHeader('Cache-Control', 'no-store');
    try {
      const expectedPort = String((server.address() as AddressInfo | null)?.port);
      const allowedHosts = lanHost ? [`${lanHost}:${expectedPort}`] : [`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`];
      if (!allowedHosts.includes(request.headers.host ?? '')) throw new AppError('ローカル接続のみ利用できます。', 'INVALID_HOST', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('別サイトからのリクエストは許可されていません。', 'CROSS_SITE_REQUEST', 403);
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw new AppError('接続元が一致しません。', 'INVALID_ORIGIN', 403);
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      const { pathname } = url;
      if (!lanAccess && request.method === 'GET' && pathname === '/lan') { lanDisabledPage(response, styleNonce); return; }
      if (lanAccess && await lanAccess.handle(request, response, pathname, Boolean(lanHost), token, styleNonce)) return;
      if (request.method === 'GET' && pathname === '/api/session') return json(response, 200, { token });
      if (request.method === 'GET' && pathname === '/api/health') return json(response, 200, await adapter.health(url.searchParams.get('refresh') === '1'));
      if (request.method === 'GET' && pathname === '/api/jobs') return json(response, 200, { jobs: store.list().filter(job => !lineage || lineage.isVisible(job.id)).map(job => publicJob(job, lineage, store)) });
      if (request.method === 'GET' && pathname === '/api/jobs/failed/deletion-preview' && lineage) return json(response, 200, lineage.failedDeletionPreview(store));
      if (request.method === 'GET' && pathname === '/api/lineage' && lineage) return json(response, 200, { ...lineage.activeSnapshot(), ...(uploads ? { uploads: uploads.list().filter(upload => lineage.isVisible(upload.id)).map(upload => publicUpload(upload, lineage)) } : {}) });
      if (request.method === 'GET' && pathname === '/api/uploads' && uploads) return json(response, 200, { uploads: uploads.list().filter(upload => !lineage || lineage.isVisible(upload.id)).map(upload => publicUpload(upload, lineage)) });
      if (request.method === 'GET' && pathname === '/api/trash' && lineage) return json(response, 200, { deletions: lineage.trash() });
      const deletionPreviewRoute = pathname.match(/^\/api\/lineage\/nodes\/([a-f0-9-]{36})\/deletion-preview$/);
      if (request.method === 'GET' && deletionPreviewRoute && lineage) return json(response, 200, lineage.deletionPreview(deletionPreviewRoute[1], store, uploads));
      if (request.method === 'GET' && pathname === '/api/templates' && templates) return json(response, 200, { templates: url.searchParams.get('all') === '1' ? templates.all() : templates.list({ query: url.searchParams.get('q') || '', category: url.searchParams.get('category') || '', favorite: url.searchParams.get('favorite') === '1', archived: url.searchParams.get('archived') === '1' }) });
      const templateVersions = pathname.match(/^\/api\/templates\/([a-f0-9-]{36})\/versions$/);
      if (request.method === 'GET' && templateVersions && templates) return json(response, 200, templates.versions(templateVersions[1]));
      if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(request.method ?? '')) {
        const supplied = Buffer.from(typeof request.headers['x-studio-token'] === 'string' ? request.headers['x-studio-token'] : '');
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AppError('ページを再読み込みしてからお試しください。', 'INVALID_SESSION', 403);
      }
      const deletionRoute = pathname.match(/^\/api\/lineage\/nodes\/([a-f0-9-]{36})$/);
      if (request.method === 'DELETE' && pathname === '/api/jobs/failed' && lineage) {
        const input = await readJson(request);
        if (!input || !isRecord(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'planToken')) throw new AppError('確認した削除対象を指定してください。', 'INVALID_DELETE_PLAN', 400);
        return json(response, 200, await lineage.softDeleteFailed(store, input.planToken));
      }
      if (request.method === 'DELETE' && deletionRoute && lineage) {
        const input = await readJson(request);
        if (!input || !isRecord(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'planToken')) throw new AppError('確認した削除対象を指定してください。', 'INVALID_DELETE_PLAN', 400);
        return json(response, 200, await manager.softDelete(deletionRoute[1], input.planToken));
      }
      const restoreRoute = pathname.match(/^\/api\/trash\/([a-f0-9-]{36})\/restore$/);
      if (request.method === 'POST' && restoreRoute && lineage) {
        const input = await readOptionalJson(request);
        if (!input || !isRecord(input) || Object.keys(input).length) throw new AppError('復元する削除履歴を指定してください。', 'INVALID_RESTORE_INPUT', 400);
        return json(response, 200, await lineage.restore(restoreRoute[1]));
      }
      const lineageRoute = pathname.match(/^\/api\/lineage\/(jobs|uploads|branches)\/([a-f0-9-]{36})$/);
      if (request.method === 'PATCH' && lineageRoute && lineage) {
        const [, kind, id] = lineageRoute;
        const input = await readJson(request);
        if (kind !== 'branches') lineage.assertActive(id);
        if (kind === 'jobs') { store.get(id); return json(response, 200, await lineage.annotate(id, input)); }
        if (kind === 'uploads') { if (!uploads) throw new AppError('アップロード画像が見つかりません。', 'UPLOAD_NOT_FOUND', 404); uploads.get(id); return json(response, 200, await lineage.annotate(id, input)); }
        return json(response, 200, await lineage.renameBranch(id, input));
      }
      if (request.method === 'POST' && pathname === '/api/uploads' && uploads) {
        const mime = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime ?? '')) throw new AppError('PNG・JPEG・WebPの画像を選んでください。', 'UNSUPPORTED_UPLOAD_TYPE', 415);
        const upload = await uploads.create(await readUpload(request), { name: url.searchParams.get('name') || 'アップロード画像', mime });
        await lineage?.recordUpload(upload);
        return json(response, 201, publicUpload(upload, lineage));
      }
      const uploadRoute = pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})\/image$/);
      if (request.method === 'GET' && uploadRoute && uploads) {
        lineage?.assertActive(uploadRoute[1]);
        const upload = uploads.get(uploadRoute[1]);
        const image = await uploads.readImage(upload.id);
        response.setHeader('Content-Type', upload.image.mime);
        if (url.searchParams.get('download') === '1') response.setHeader('Content-Disposition', `attachment; filename="reference-${upload.id.slice(0, 8)}.${upload.image.fileName.split('.').pop()}"`);
        response.end(image); return;
      }
      if (request.method === 'POST' && pathname === '/api/templates' && templates) return json(response, 201, await templates.create(await readJson(request)));
      const templateRoute = pathname.match(/^\/api\/templates\/([a-f0-9-]{36})(?:\/(restore|revert))?$/);
      if (templateRoute && templates) {
        const [, id, action] = templateRoute;
        if (request.method === 'PATCH' && !action) return json(response, 200, await templates.update(id, await readJson(request)));
        if (request.method === 'DELETE' && !action) return json(response, 200, await templates.archive(id, false, await readOptionalJson(request)));
        if (request.method === 'POST' && action === 'restore') return json(response, 200, await templates.archive(id, true, await readOptionalJson(request)));
        if (request.method === 'POST' && action === 'revert') return json(response, 200, await templates.revert(id, await readJson(request)));
      }
      if (request.method === 'POST' && pathname === '/api/jobs') {
        const input = prepareGeneration(await readJson(request), templates, store, uploads, lineage);
        const health = await adapter.health();
        if (!health.ready) throw new AppError(health.message, 'CODEX_NOT_READY', 503);
        return json(response, 202, publicJob(await manager.enqueue(input), lineage));
      }
      if (request.method === 'POST' && pathname === '/api/batches') {
        const raw = await readJson(request);
        const count = validateBatchCount(record(raw).count);
        const input = prepareGeneration(raw, templates, store, uploads, lineage);
        const health = await adapter.health();
        if (!health.ready) throw new AppError(health.message, 'CODEX_NOT_READY', 503);
        const batch = await manager.enqueueBatch(input, count);
        return json(response, 202, { batchId: batch.batchId, jobs: batch.jobs.map(job => publicJob(job, lineage)) });
      }
      const route = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(image|cancel|retry|retry-batch|favorite))?$/);
      if (route) {
        const [, id, action] = route;
        lineage?.assertActive(id);
        const job = store.get(id);
        if (lineage && !lineage.isVisible(id)) throw new AppError('画像の管理情報がまだ保存されていません。', 'LINEAGE_NOT_FOUND', 404);
        if (request.method === 'GET' && !action) return json(response, 200, publicJob(job, lineage));
        if (request.method === 'PATCH' && action === 'favorite') {
          const input = await readJson(request);
          if (!input || !isRecord(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'favorite')) throw new AppError('お気に入りの状態だけを指定してください。', 'INVALID_FAVORITE', 400);
          return json(response, 200, publicJob(await store.setFavorite(id, input.favorite), lineage));
        }
        if (request.method === 'POST' && action === 'cancel') return json(response, 200, publicJob(await manager.cancel(id), lineage));
        if (request.method === 'POST' && ['retry', 'retry-batch'].includes(action)) {
          let count;
          if (action === 'retry-batch') {
            const raw = await readJson(request);
            if (!raw || !isRecord(raw) || Object.keys(raw).some(key => key !== 'count')) throw new AppError('再生成には生成枚数だけを指定してください。', 'INVALID_BATCH_INPUT', 400);
            count = validateBatchCount(raw.count);
          }
          const health = await adapter.health();
          if (!health.ready) throw new AppError(health.message, 'CODEX_NOT_READY', 503);
          const input = prepareGeneration({ ...job, prompt: job.basePrompt ?? job.prompt }, templates, store, uploads, lineage);
          if (action === 'retry-batch') {
            const batch = await manager.enqueueBatch(input, count!, { regenerateFrom: job.id });
            return json(response, 202, { batchId: batch.batchId, jobs: batch.jobs.map(item => publicJob(item, lineage)) });
          }
          return json(response, 202, publicJob(await manager.enqueue(input, { regenerateFrom: job.id }), lineage));
        }
        if (request.method === 'GET' && action === 'image') {
          if (job.status !== 'succeeded' || !job.image || !/^image\.(png|jpg|webp)$/.test(job.image.fileName)) throw new AppError('画像はまだ生成されていません。', 'IMAGE_NOT_READY', 404);
          const path = join(store.directory, id, job.image.fileName);
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError('画像が見つかりません。', 'NOT_FOUND', 404);
          response.setHeader('Content-Type', job.image.mime ?? 'application/octet-stream');
          if (url.searchParams.get('download') === '1') response.setHeader('Content-Disposition', `attachment; filename="codex-${id.slice(0, 8)}.${job.image.fileName.split('.').pop()}"`);
          response.end(await readFile(path)); return;
        }
      }
      if (request.method === 'GET' && pathname === '/') {
        let page;
        try { page = await readFile(join(publicDirectory, 'build', 'index.html'), 'utf8'); }
        catch (error) { if (record(error).code === 'ENOENT') throw new AppError('npm run build を実行してから起動してください。', 'BUILD_MISSING', 503); throw error; }
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(page.replace('__STYLE_NONCE__', styleNonce)); return;
      }
      const asset = pathname.match(/^\/assets\/([A-Za-z0-9_-]+\.(js|css|woff2))$/);
      if (request.method === 'GET' && (asset || pathname === '/favicon.svg')) {
        const path = asset ? join(publicDirectory, 'build', 'assets', asset[1]) : join(publicDirectory, 'favicon.svg');
        let stat;
        try { stat = await lstat(path); } catch (error) { if (record(error).code === 'ENOENT') throw new AppError('ページが見つかりません。', 'NOT_FOUND', 404); throw error; }
        if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError('ページが見つかりません。', 'NOT_FOUND', 404);
        response.setHeader('Content-Type', asset ? assetTypes[asset[2]] : 'image/svg+xml');
        response.end(await readFile(path)); return;
      }
      throw new AppError('ページが見つかりません。', 'NOT_FOUND', 404);
    } catch (error) {
      const known = error instanceof AppError;
      if (!known) console.error('リクエスト処理に失敗:', record(error).code || record(error).name);
      if (!response.headersSent) json(response, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '処理に失敗しました。もう一度お試しください。' } });
      else response.end();
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return server;
}

export function publicJob(job: Job, lineage?: LineageStore, store?: JobStore) {
  const { image, lineageContext, lineageIntent, ...rest } = job;
  const deletedCount = job.batch && lineage && store ? store.list().filter(item => item.batch?.id === job.batch!.id && lineage.isDeleted(item.id)).length : 0;
  return { ...rest, favorite: job.favorite === true, ...(deletedCount ? { batch: { ...job.batch!, deletedCount } } : {}), ...(lineage ? { lineage: lineage.get(job.id) } : {}), image: image ? { mime: image.mime, bytes: image.bytes, revisedPrompt: image.revisedPrompt, recovered: image.recovered ?? false, url: `/api/jobs/${job.id}/image`, downloadUrl: `/api/jobs/${job.id}/image?download=1` } : null };
}

export function publicUpload(upload: Upload, lineage?: LineageStore) {
  const { image, ...rest } = upload;
  return { ...rest, ...(lineage ? { lineage: lineage.get(upload.id) } : {}), image: { mime: image.mime, bytes: image.bytes, width: image.width, height: image.height, url: `/api/uploads/${upload.id}/image`, downloadUrl: `/api/uploads/${upload.id}/image?download=1` } };
}

function json(response: ServerResponse, status: number, value: unknown) { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)); }
async function readOptionalJson(request: IncomingMessage): Promise<unknown> {
  return request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0 ? readJson(request) : {};
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) throw new AppError('JSON形式で送信してください。', 'INVALID_CONTENT_TYPE', 415);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 64000) throw new AppError('入力が大きすぎます。', 'PAYLOAD_TOO_LARGE', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('入力の形式を確認してください。', 'INVALID_JSON', 400); }
}
async function readUpload(request: IncomingMessage) {
  if (Number(request.headers['content-length'] || 0) > MAX_UPLOAD_BYTES) throw new AppError('アップロードできる画像は10MBまでです。', 'UPLOAD_TOO_LARGE', 413);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_UPLOAD_BYTES) throw new AppError('アップロードできる画像は10MBまでです。', 'UPLOAD_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
