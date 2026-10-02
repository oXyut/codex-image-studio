import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (entry.name.endsWith('.js')) execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  }
}
await check('src'); await check('public'); await check('scripts'); await check('test');
execFileSync(process.execPath, ['--check', 'server.js'], { stdio: 'inherit' });
console.log('JavaScript構文チェック: OK');
