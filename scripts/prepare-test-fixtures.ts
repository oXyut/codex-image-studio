import { chmod } from 'node:fs/promises';

// The adapter starts the fake CLI directly, just as it starts the real CLI.
await chmod(new URL('../test/fixtures/fake-codex.js', import.meta.url), 0o755);
