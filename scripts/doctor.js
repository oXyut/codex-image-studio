import { CodexAdapter } from '../src/codex-adapter.js';
const health = await new CodexAdapter().health(true);
console.log(`Codex CLI: ${health.version || '見つかりません'}\nChatGPT認証: ${health.auth === 'chatgpt' ? 'OK' : '要ログイン'}\n画像生成機能: ${health.supportsImages ? '対応' : '未確認'}\n${health.message}`);
process.exitCode = health.ready ? 0 : 1;
