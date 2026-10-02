import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { CodexAdapter } from './src/codex-adapter.js';
import { JobStore, JobManager } from './src/job-store.js';
import { createApp } from './src/http-app.js';
import { TemplateStore } from './src/template-store.js';
import { LineageStore } from './src/lineage-store.js';
import { UploadStore } from './src/upload-store.js';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4317);
const timeoutMs = Number(process.env.GENERATION_TIMEOUT_MS || 600000);
const concurrency = Number(process.env.GENERATION_CONCURRENCY || 5);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORTは1〜65535で指定してください。');
if (!Number.isInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 1800000) throw new Error('GENERATION_TIMEOUT_MSは30000〜1800000で指定してください。');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('GENERATION_CONCURRENCYは1〜10の整数で指定してください。');
const dataDirectory = resolve(process.env.DATA_DIR || join(root, 'data'));
await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
const lockPath = join(dataDirectory, 'server.lock');
async function acquireLock() {
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(String(process.pid)); await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('data/server.lock を確認してください。');
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { await unlink(lockPath); return acquireLock(); } }
    throw new Error('このデータフォルダを使用するアプリが既に起動しています。');
  }
}
await acquireLock();
const store = new JobStore(join(dataDirectory, 'jobs'));
await store.initialize();
const uploads = new UploadStore(join(dataDirectory, 'uploads'));
await uploads.initialize();
const adapter = new CodexAdapter({ timeoutMs });
const lineage = new LineageStore(join(dataDirectory, 'lineage.json'));
await lineage.initialize(store, uploads);
const manager = new JobManager(store, adapter, { lineage, uploads, concurrency });
const templates = new TemplateStore(join(dataDirectory, 'templates.json'));
await templates.initialize();
const server = createApp({ store, manager, adapter, templates, lineage, uploads, publicDirectory: join(root, 'public') });
server.on('error', async error => {
  console.error(error.code === 'EADDRINUSE' ? `ポート${port}は使用中です。PORT=4318 npm run dev をお試しください。` : error.message);
  await unlink(lockPath).catch(() => {}); process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Codex Image Studio: http://127.0.0.1:${port}\n停止: Ctrl+C`));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.close(); await manager.close(); await unlink(lockPath).catch(() => {});
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
