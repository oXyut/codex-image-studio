import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { close, listen, serverPort } from './helpers.js';

test('ビルドしたサーバーは別の作業ディレクトリからも画面を配信し、プロジェクト直下にデータを保存する', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'studio-entrypoint-'));
  const project = join(temporary, 'project'), unrelated = join(temporary, 'unrelated');
  await mkdir(unrelated);
  await cp(new URL('../', import.meta.url), join(project, 'dist'), { recursive: true });
  await cp(new URL('../../public/build/', import.meta.url), join(project, 'public/build'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../node_modules/', import.meta.url)), join(project, 'node_modules'), 'dir');
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  const socket = createServer(); await listen(socket);
  const port = serverPort(socket); await close(socket);
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), CODEX_BIN: fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url)) };
  delete env.DATA_DIR;
  const child = spawn(process.execPath, [join(project, 'dist/server.js')], { cwd: unrelated, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await stopped; } finally { clearTimeout(timer); }
    }
    await rm(temporary, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('サーバー起動がタイムアウトしました。')), 10000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`サーバー起動に失敗しました (${code}): ${diagnostics}`)); });
    child.stdout.on('data', chunk => {
      if (String(chunk).includes(`http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); }
    });
  });
  const page = await fetch(`http://127.0.0.1:${port}`);
  assert.equal(page.status, 200); assert.match(await page.text(), /Codex Image Studio/);
  assert.ok((await readFile(join(project, 'data/server.lock'), 'utf8')).includes(String(child.pid)));
  await stat(join(project, 'data/templates.json'));
  await assert.rejects(stat(join(project, 'dist/data')), { code: 'ENOENT' });
  await assert.rejects(stat(join(unrelated, 'data')), { code: 'ENOENT' });
});
