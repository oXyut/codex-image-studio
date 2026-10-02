import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { cliEnvironment, CodexAdapter, extractImage } from '../src/codex-adapter.js';
import { prepareGeneration } from '../src/prompt-builder.js';
import { AppError, cliErrorMessage, imageType, safeMessage, validateInput } from '../src/validation.js';
import { generationError } from '../src/generation-errors.js';

const binary = resolve('dist/test/fixtures/fake-codex.js');
await chmod(binary, 0o755);
test('APIキーと認証上書きをCLIの環境から除外する', () => {
  const env = cliEnvironment({ OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret', OPENAI_BASE_URL: 'https://example.com', PATH: '/usr/bin' });
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL']) assert.equal(env[key], undefined);
  assert.match(env.PATH!, /\.local\/bin/);
});
test('入力の上限とサイズを検証する', () => {
  assert.deepEqual(validateInput({ prompt: ' cat ' }), { prompt: 'cat', size: 'square', style: 'auto', transparent: false });
  for (const input of [{ prompt: '' }, { prompt: 'a'.repeat(4001) }, { prompt: 'cat', size: '__proto__' }, { prompt: 'cat', transparent: 'true' }]) assert.throws(() => validateInput(input));
});
test('自動アスペクト比を生成入力として保持し、省略時の正方形を維持する', () => {
  const prepared = prepareGeneration({ prompt: '人物を自然な構図で', size: 'auto' });
  assert.equal(prepared.size, 'auto');
  assert.equal(prepared.prompt, '人物を自然な構図で');
  assert.equal(prepareGeneration({ prompt: '従来の入力' }).size, 'square');
});
test('認証を示す文字列をマスクする', () => { assert.equal(safeMessage('Bearer abc sk-secret'), 'Bearer [redacted] [redacted]'); });
test('CLIのモデル・利用枠エラーを読みやすくする', () => {
  assert.match(cliErrorMessage('{"error":{"message":"The model is not supported"}}'), /CODEX_MODEL/);
  assert.match(cliErrorMessage('usage limit reached'), /利用上限/);
});
test('不正な画像とURLを拒否する', async () => {
  assert.throws(() => imageType(Buffer.from('<svg></svg>')));
  await assert.rejects(extractImage({ result: 'https://example.com/image.png' }), { code: 'MISSING_IMAGE_DATA' });
});
test('CLIの診断でChatGPT認証と画像生成機能を検出する', async () => {
  const health = await new CodexAdapter({ binary }).health(); assert.equal(health.ready, true); assert.equal(health.auth, 'chatgpt');
});
test('構造化されたネイティブ画像イベントからPNGを保存する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-adapter-')); t.after(() => rm(root, { recursive: true, force: true }));
  const messages = [];
  const result = await new CodexAdapter({ binary }).generate(validateInput({ prompt: 'a red cup' }), { workspace: join(root, 'workspace'), onProgress: text => messages.push(text) });
  assert.equal(result.mime, 'image/png'); assert.ok(messages.length >= 3); assert.equal(imageType(await readFile(join(root, result.fileName))).mime, 'image/png');
});
test('CLIが文章だけを返した場合は成功扱いにしない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-no-image-')); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(new CodexAdapter({ binary }).generate(validateInput({ prompt: 'NO_IMAGE' }), { workspace: join(root, 'workspace') }), { code: 'IMAGE_TOOL_UNAVAILABLE' });
});
test('CLIの生成エラーを伝える', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-fail-')); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(new CodexAdapter({ binary }).generate(validateInput({ prompt: 'FAIL' }), { workspace: join(root, 'workspace') }), { code: 'CODEX_TURN_FAILED' });
});
test('実行中のCLIをキャンセルできる', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-cancel-')); t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const result = new CodexAdapter({ binary }).generate(validateInput({ prompt: 'SLOW' }), { workspace: join(root, 'workspace'), signal: controller.signal, onProgress: () => setTimeout(() => controller.abort(), 25) });
  await assert.rejects(result, { code: 'CANCELLED' });
});
test('利用できないモデル指定を拒否する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-model-')); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(new CodexAdapter({ binary, model: 'unsupported' }).generate(validateInput({ prompt: 'cat' }), { workspace: join(root, 'workspace') }), { code: 'MODEL_UNAVAILABLE' });
});
test('APIキー認証の場合は生成を開始しない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const original = process.env.FAKE_AUTH; process.env.FAKE_AUTH = 'apiKey';
  try { await assert.rejects(new CodexAdapter({ binary }).generate(validateInput({ prompt: 'cat' }), { workspace: join(root, 'workspace') }), { code: 'CHATGPT_LOGIN_REQUIRED' }); }
  finally { if (original === undefined) delete process.env.FAKE_AUTH; else process.env.FAKE_AUTH = original; }
});
test('応答しない画像生成をタイムアウトで停止する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-timeout-')); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(new CodexAdapter({ binary, timeoutMs: 150 }).generate(validateInput({ prompt: 'SLOW' }), { workspace: join(root, 'workspace') }), { code: 'TIMEOUT' });
});
test('参照画像を作業フォルダにコピーし、役割と透過指定を画像ツールへ渡す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-reference-')); t.after(() => rm(root, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7cAAAAASUVORK5CYII=', 'base64'); const original = join(root, 'source.png'); await writeFile(original, png); const workspace = join(root, 'workspace');
  await new CodexAdapter({ binary }).generate(validateInput({ prompt: 'REFERENCE_TOOL_CHECK', transparent: true }), { workspace, referenceImages: [{ path: original, role: 'face' }] });
  const captured = JSON.parse(await readFile(join(workspace, 'captured-turn.json'), 'utf8')); assert.equal(captured.input[1].type, 'localImage'); assert.notEqual(captured.input[1].path, original); assert.equal(captured.input[1].path, join(workspace, 'reference-1.png')); assert.match(captured.input[0].text, /顔立ち/); assert.match(captured.input[0].text, /transparent_background=true/);
});
test('自動では固定寸法を指定せず、説明と参照構図に適した比率を画像ツールに委ねる', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-auto-aspect-')); t.after(() => rm(root, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7cAAAAASUVORK5CYII=', 'base64');
  const original = join(root, 'source.png'); await writeFile(original, png); const workspace = join(root, 'workspace');
  const description = 'REFERENCE_TOOL_CHECK: 自然な写真。4×4のカメラロール。';
  await new CodexAdapter({ binary }).generate(validateInput({ prompt: description, size: 'auto', style: 'photo' }), { workspace, referenceImages: [{ path: original, role: 'person' }] });
  const captured = JSON.parse(await readFile(join(workspace, 'captured-turn.json'), 'utf8'));
  const text = captured.input[0].text;
  assert.match(text, /Automatic aspect ratio/); assert.match(text, /image description.*reference composition/);
  assert.doesNotMatch(text, /Requested dimensions:|Requested aspect ratio:|1024×1024|1:1/);
  assert.ok(text.includes(`Image description (JSON-encoded): ${JSON.stringify(description)}`));
  assert.ok(text.includes('"role":"人物"')); assert.match(text, /Photorealistic photography/);
  assert.equal(captured.input[1].path, join(workspace, 'reference-1.png'));
});
test('画像ツールの内容判定・利用上限・一時障害を外側のエラーで隠さない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-tool-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [prompt, category, autoRetryAllowed] of [['CONTENT_FAILURE', 'content', true], ['USAGE_FAILURE', 'usage', false], ['TRANSIENT_FAILURE', 'transient', true]] as const) {
    await assert.rejects(new CodexAdapter({ binary }).generate(validateInput({ prompt }), { workspace: join(root, prompt) }), error => error instanceof AppError && error.category === category && error.autoRetryAllowed === autoRetryAllowed);
  }
});
test('最終応答が失敗しても、既に完成した画像を回収する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-recovered-')); t.after(() => rm(root, { recursive: true, force: true })); const result = await new CodexAdapter({ binary }).generate(validateInput({ prompt: 'RECOVER_IMAGE' }), { workspace: join(root, 'workspace') }); assert.equal(result.recovered, true); assert.equal(imageType(await readFile(join(root, result.fileName))).mime, 'image/png');
});
test('画像生成開始後の切断は、結果が不明なため自動再生成しない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-ambiguous-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const prompt of ['AMBIGUOUS_DISCONNECT', 'TRANSIENT_THEN_NEW_DISCONNECT']) {
    await assert.rejects(new CodexAdapter({ binary }).generate(validateInput({ prompt }), { workspace: join(root, prompt) }), error => error instanceof AppError && error.category === 'transient' && error.autoRetryAllowed === false);
  }
});
test('内容拒否後に別の画像生成が始まって切断した場合は、自動再生成しない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-content-ambiguous-')); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(new CodexAdapter({ binary }).generate(validateInput({ prompt: 'CONTENT_THEN_NEW_DISCONNECT' }), { workspace: join(root, 'workspace') }), error => error instanceof AppError && error.autoRetryAllowed === false);
});
test('画像の結果にエラーJSONが入った場合も、内容判定や利用枠を表示する', async () => {
  await assert.rejects(extractImage({ result: JSON.stringify({ error: { code: 'content_policy_violation', message: 'Rejected' } }) }), { code: 'CONTENT_REVIEW' });
  await assert.rejects(extractImage({ result: { error: { type: 'usageLimitExceeded' } } }), { code: 'IMAGE_USAGE_LIMIT' });
});

test('空の画像失敗でも最終説明・公式TurnErrorを保持し、内容拒否だけ再試行を許可する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-error-details-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [prompt, category, detail] of [
    ['EMPTY_TOOL_CONTENT_COMPLETED', 'content', /content policies/],
    ['EMPTY_TOOL_CONTENT_FAILED', 'content', /content policies/],
    ['EMPTY_TOOL_JAPANESE_CONTENT', 'content', /性的内容としてリクエストを拒否/],
    ['EMPTY_TOOL_JAPANESE_SAFETY', 'content', /安全システムがリクエストを拒否/],
    ['EMPTY_TOOL_USAGE_TURN', 'usage', /usageLimitExceeded/],
    ['EMPTY_TOOL_503_TURN', 'transient', /503/],
    ['EMPTY_TOOL_AGENT_TRANSIENT', 'transient', /temporarily unavailable/],
    ['EMPTY_TOOL_ITEMS_ONLY', 'unknown', /diagnostic-42/],
    ['EMPTY_TOOL_NOTIFICATION_USAGE', 'usage', /usageLimitExceeded/],
    ['AUTHORITATIVE_CONTENT', 'content', /moderation_blocked/],
    ['EMPTY_TOOL_TRANSIENT_THEN_CONTENT', 'content', /content policies/],
    ['EMPTY_TOOL_CONTENT_THEN_TRANSIENT', 'content', /misalignmentPolicyViolation/],
    ['EMPTY_TOOL_UNKNOWN_TURN', 'unknown', /Selected model cannot generate images/],
    ['EMPTY_TOOL_UNKNOWN_TURN_WITH_AGENT', 'unknown', /MODEL_UNAVAILABLE/],
  ] as const) {
    const progress: string[] = [];
    await assert.rejects(new CodexAdapter({ binary }).generate(validateInput({ prompt }), { workspace: join(root, prompt), onProgress: text => progress.push(text) }), error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.category, category, prompt); assert.equal(error.autoRetryAllowed, category === 'content', prompt);
      assert.match(error.details!, detail); assert.doesNotMatch(error.details!, /private-token|private-key/);
      return true;
    });
    assert.ok(!progress.includes('画像を受信しています。'));
    assert.ok(!progress.includes('画像生成のエラーを確認しています。'));
    if (category === 'content') assert.ok(progress.every(text => generationError(text).category !== 'content'));
  }
});
