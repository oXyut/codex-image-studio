import assert from 'node:assert/strict';
import test from 'node:test';
import { generationError, publicFailure } from '../src/generation-errors.js';
import { AppError } from '../src/validation.js';

test('公式TurnErrorの型を原文から独立して分類し、型と追加説明を公開する', () => {
  const expected = new Map([
    ['usageLimitExceeded', 'usage'], ['rateLimitExceeded', 'transient'], ['serverOverloaded', 'transient'],
    ['internalServerError', 'transient'], ['unauthorized', 'auth'], ['misalignmentPolicyViolation', 'content'],
    ['cyberPolicy', 'content'], ['contextWindowExceeded', 'unknown'], ['newFutureError', 'unknown'],
  ]);
  for (const [codexErrorInfo, category] of expected) {
    const error = generationError({ message: 'Generation failed', codexErrorInfo, additionalDetails: 'A concrete provider explanation.' }, 'CODEX_TURN_FAILED');
    assert.equal(error.category, category, codexErrorInfo);
    assert.ok(error.details!.includes(codexErrorInfo));
    assert.ok(error.details!.includes('Generation failed'));
    assert.ok(error.details!.includes('A concrete provider explanation.'));
    assert.equal(publicFailure(error).details!, error.details);
    assert.equal(error.retryable, ['transient', 'content'].includes(category));
  }
});

test('公式の接続エラーobjectからHTTPステータスを読み、400や403を内容拒否と推測しない', () => {
  for (const type of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']) {
    for (const [httpStatusCode, category] of [[503, 'transient'], [502, 'transient'], [504, 'transient'], [429, 'transient'], [401, 'auth'], [400, 'unknown'], [403, 'unknown'], [null, 'transient']]) {
      const error = generationError({ message: 'Request failed', codexErrorInfo: { [type]: { httpStatusCode } } });
      assert.equal(error.category, category, `${type}: ${httpStatusCode}`);
      assert.ok(error.details!.includes(type));
      if (httpStatusCode !== null) assert.ok(error.details!.includes(`HTTP: ${httpStatusCode}`));
    }
  }
});

test('画像のusageLimitExceededと一時的なrateLimitExceededを区別する', () => {
  const usage = generationError({ failure: { type: 'usageLimitExceeded', limitId: 'image_generation', resetsAt: 12345 } });
  assert.equal(usage.code, 'IMAGE_USAGE_LIMIT'); assert.equal(usage.retryable, false); assert.equal(usage.autoRetryAllowed, false);
  const throttle = generationError({ message: 'Request failed', codexErrorInfo: 'rateLimitExceeded' });
  assert.equal(throttle.code, 'TRANSIENT_ERROR'); assert.equal(throttle.retryable, true);
});

test('内容拒否の明示コードと追加説明を認識し、具体的な説明を失わない', () => {
  for (const code of ['content_policy_violation', 'moderation_blocked', 'safety_policy_violation']) {
    const error = generationError({ error: { code, message: 'The image request was rejected.' } });
    assert.equal(error.category, 'content'); assert.equal(error.autoRetryAllowed, true);
    assert.ok(error.details!.includes(code)); assert.ok(error.details!.includes('The image request was rejected.'));
  }
  for (const text of ['moderation_blocked', 'The image request could not be completed because it violates our content policies.', 'The request violates the content policy.']) {
    const additional = generationError({ message: 'Generation failed', additionalDetails: text });
    assert.equal(additional.category, 'content'); assert.ok(additional.details!.includes(text));
  }
});

test('未知の失敗は内容拒否と断定せず、最終説明の原文を保持する', () => {
  for (const message of ['画像の生成に失敗しました。', 'I could not generate this image.', 'The generation tool returned an unspecified error.']) {
    const error = generationError(message, 'IMAGE_GENERATION_FAILED');
    assert.equal(error.category, 'unknown'); assert.equal(error.message, message); assert.equal(error.details!, message);
    assert.equal(error.autoRetryAllowed, false);
  }
});

test('実際に返された日本語の性的内容による拒否を認識し、曖昧な失敗から区別する', () => {
  const message = '画像生成ツールが性的内容としてリクエストを拒否したため、画像を生成できませんでした（完了率0%）。\n\n再試行せず終了します。ユーザー側での操作は不要です。';
  const result = publicFailure(generationError(message, 'IMAGE_GENERATION_FAILED'));
  assert.equal(result.code, 'CONTENT_REVIEW'); assert.equal(result.category, 'content'); assert.equal(result.retryable, true); assert.equal(result.details, message);
  assert.equal(generationError('性的内容による判定か、通信障害かは不明です。').category, 'unknown');
});

test('再正規化で分類・詳細・慎重な再試行判定を保持し、診断を重複追加しない', () => {
  const error = generationError({ message: 'stream ended unexpectedly', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: 'generation may already have started' });
  error.autoRetryAllowed = false;
  const second = generationError(error), third = generationError(second);
  for (const field of ['code', 'category', 'message', 'details', 'advice', 'retryable', 'autoRetryAllowed'] as const) {
    assert.equal(second[field], error[field]); assert.equal(third[field], error[field]);
  }
  assert.deepEqual(publicFailure(third), { code: error.code, category: error.category, message: error.message,
    details: error.details!, advice: error.advice, retryable: true });
});

test('キャンセルと全体タイムアウトを通信障害より優先し、自動再試行しない', () => {
  for (const [code, category] of [['CANCELLED', 'cancelled'], ['TIMEOUT', 'timeout'], ['RPC_TIMEOUT', 'timeout']]) {
    const first = generationError(Object.assign(new AppError('connection reset after timeout', code), { autoRetryAllowed: true }));
    assert.equal(first.code, code); assert.equal(first.category, category); assert.equal(first.retryable, false); assert.equal(first.autoRetryAllowed, false);
    const second = generationError(first); assert.equal(second.category, category); assert.equal(second.autoRetryAllowed, false);
  }
});

test('内容判定の再正規化でも、未確定の生成を再試行しない判定を保持する', () => {
  const error = generationError({ code: 'content_policy_violation', message: 'Rejected' });
  error.autoRetryAllowed = false;
  const normalized = generationError(generationError(error));
  assert.equal(normalized.category, 'content'); assert.equal(normalized.retryable, true);
  assert.equal(normalized.autoRetryAllowed, false); assert.equal(normalized.details, error.details);
});

test('原文・追加説明・再正規化した詳細に含まれる認証情報をマスクする', () => {
  const secret = 'Bearer private-token sk-secret-key eyJheader.payload.signature';
  const error = generationError({ message: secret, additionalDetails: `Additional ${secret}`, codexErrorInfo: 'other' });
  const serialized = JSON.stringify(publicFailure(error));
  assert.doesNotMatch(serialized, /private-token|sk-secret-key|eyJheader/); assert.match(serialized, /redacted/);
  error.details = secret;
  assert.doesNotMatch(publicFailure(error).details!, /private-token|sk-secret-key|eyJheader/);
});

test('詳細の総量を制限し、長い原文でも公式の型とHTTPステータスを残す', () => {
  const error = generationError({ message: '説明文'.repeat(2000), additionalDetails: '追加情報'.repeat(2000), codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } });
  assert.ok(error.details!.length <= 1200); assert.ok(error.details!.includes('httpConnectionFailed')); assert.ok(error.details!.includes('HTTP: 503'));
  assert.ok(error.details!.includes('説明文')); assert.ok(error.details!.includes('追加情報'));
});

test('任意objectや画像のbase64を詳細として保存しない', () => {
  const base64 = 'iVBORw0KGgo' + 'A'.repeat(5000);
  const cases = [base64, `data:image/png;base64,${base64}`, { message: base64 },
    base64.match(/.{1,64}/g)!.join('\n'),
    { additionalDetails: `data:image/png;base64,${base64.match(/.{1,64}/g)!.join('\n')}` },
    { message: `image data: data:image/png;base64,${base64}` },
    { result: base64, arguments: { secret: 'unrelated-sensitive-data' }, arbitrary: 'unrelated-sensitive-data' },
    { message: { secret: 'unrelated-sensitive-data' }, additionalDetails: { result: base64 } },
    JSON.stringify({ result: base64, arbitrary: 'unrelated-sensitive-data' }),
    JSON.stringify({ arbitrary: 'unrelated-sensitive-data', result: 'A'.repeat(65000) }),
    '{"arbitrary":"unrelated-sensitive-data",'];
  for (const input of cases) {
    const output = JSON.stringify(publicFailure(generationError(input)));
    assert.doesNotMatch(output, /iVBORw0KGgo|AAAA{20}|unrelated-sensitive-data|\[object Object\]/);
  }
});

test('将来のcodexErrorInfo objectにある任意の内部データは保存しない', () => {
  const error = generationError({ message: 'Provider error', codexErrorInfo: { futureInternalError: { secret: 'unrelated-sensitive-data' } },
    misalignment: { detailedExplanation: 'A public localized explanation.', steer: { message: 'unrequested continuation command' } } });
  assert.equal(error.category, 'unknown'); assert.ok(error.details!.includes('A public localized explanation.'));
  assert.doesNotMatch(JSON.stringify(publicFailure(error)), /unrelated-sensitive-data|unrequested continuation command/);
});
