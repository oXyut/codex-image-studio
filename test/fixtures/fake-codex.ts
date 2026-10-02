#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli test'); process.exit(0); }
if (args.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args.includes('list')) { console.log('image_generation stable true'); process.exit(0); }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7cAAAAASUVORK5CYII=';
function send(message: unknown) { process.stdout.write(`${JSON.stringify(message)}\n`); }
let workspace = "";
createInterface({ input: process.stdin }).on('line', async line => {
  const { id, method, params } = JSON.parse(line) as {
    id: number; method: string; params: { cwd: string; model: string; input: { type: string; text: string; path: string }[] };
  };
  if (method === 'initialize') send({ id, result: {} });
  if (method === 'account/read') send({ id, result: { account: { type: process.env.FAKE_AUTH || 'chatgpt' } } });
  if (method === 'model/list') send({ id, result: { data: [{ id: 'test-default', model: 'test-default', isDefault: true }] } });
  if (method === 'thread/start') {
    workspace = params.cwd;
    if (params.model !== 'test-default') send({ id, error: { message: 'The model must come from the advertised catalog' } });
    else send({ id, result: { thread: { id: 'test-thread' } } });
  }
  if (method === 'turn/start') {
    if (!params.input[0].text.includes('image_gen.imagegen')) throw new Error('Must invoke the installed image tool by its actual name');
    send({ id, result: { turn: { id: 'test-turn' } } });
    const prompt = params.input[0].text;
    if (prompt.includes('REFERENCE_TOOL_CHECK')) {
      const refs = params.input.filter(input => input.type === 'localImage');
      if (refs.length !== 1 || !prompt.includes(`referenced_image_paths=${JSON.stringify(refs.map(ref => ref.path))}`)) throw new Error('Reference paths must match localImage inputs');
      if ((await readFile(refs[0].path)).toString('base64') !== png) throw new Error('Copied reference must retain image bytes');
      await writeFile(join(workspace, 'captured-turn.json'), JSON.stringify(params));
    }
    if (prompt.includes('SLOW')) return;
    if (prompt.includes('CONTENT_THEN_NEW_DISCONNECT')) {
      send({ method: 'item/started', params: { item: { id: 'image-1', type: 'imageGeneration', status: 'in_progress' } } });
      send({ method: 'item/completed', params: { item: { id: 'image-1', type: 'imageGeneration', status: 'failed', failure: { code: 'content_policy_violation', message: 'Rejected' } } } });
      send({ method: 'item/started', params: { item: { id: 'image-2', type: 'imageGeneration', status: 'in_progress' } } });
      setTimeout(() => process.exit(1), 10); return;
    }
    if (prompt.includes('TRANSIENT_THEN_NEW_DISCONNECT')) {
      send({ method: 'item/started', params: { item: { id: 'image-1', type: 'imageGeneration', status: 'in_progress' } } });
      send({ method: 'item/completed', params: { item: { id: 'image-1', type: 'imageGeneration', status: 'failed', result: JSON.stringify({ error: { code: 'internal_server_error', message: 'Service temporarily unavailable' } }) } } });
      send({ method: 'item/started', params: { item: { id: 'image-2', type: 'imageGeneration', status: 'in_progress' } } });
      setTimeout(() => process.exit(1), 10); return;
    }
    if (prompt.includes('EMPTY_TOOL_') || prompt.includes('AUTHORITATIVE_CONTENT')) {
      const image = { id: 'image-1', type: 'imageGeneration', status: 'failed', result: '', failure: null };
      let text = 'Image backend returned an unrecognized error: diagnostic-42. Bearer private-token sk-private-key';
      let error: unknown = null;
      if (prompt.includes('CONTENT_')) text = 'The image request could not be completed because it violates our content policies.';
      if (prompt.includes('JAPANESE_CONTENT')) text = '画像生成ツールが性的内容としてリクエストを拒否したため、画像を生成できませんでした。';
      if (prompt.includes('AGENT_TRANSIENT')) text = 'Image service temporarily unavailable; try again later.';
      if (prompt.includes('USAGE_TURN')) error = { message: 'Generation failed', codexErrorInfo: 'usageLimitExceeded', additionalDetails: 'Image quota exhausted' };
      if (prompt.includes('503_TURN')) error = { message: 'Generation failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } }, additionalDetails: 'Backend unavailable' };
      if (prompt.includes('UNKNOWN_TURN')) { error = { code: 'MODEL_UNAVAILABLE', message: 'Selected model cannot generate images' }; if (!prompt.includes('WITH_AGENT')) text = ''; }
      if (prompt.includes('NOTIFICATION_USAGE')) send({ method: 'error', params: { willRetry: false, error: { message: 'Generation failed', codexErrorInfo: 'usageLimitExceeded' } } });
      if (prompt.includes('AUTHORITATIVE_CONTENT')) { image.result = JSON.stringify({ error: { code: 'moderation_blocked', message: 'Image request rejected' } }); text = 'Service temporarily unavailable'; }
      if (prompt.includes('TRANSIENT_THEN_CONTENT')) { image.result = JSON.stringify({ error: { code: 'internal_server_error', message: 'Service temporarily unavailable' } }); text = 'The image request violates our content policies.'; }
      if (prompt.includes('CONTENT_THEN_TRANSIENT')) {
        send({ method: 'error', params: { willRetry: false, error: { message: 'Image request rejected', codexErrorInfo: 'misalignmentPolicyViolation' } } });
        error = { message: 'Generation failed', codexErrorInfo: 'serverOverloaded' }; text = 'Service temporarily unavailable';
      }
      const message = { id: 'explanation', type: 'agentMessage', phase: 'final_answer', text };
      const itemsOnly = prompt.includes('ITEMS_ONLY');
      if (!itemsOnly) {
        send({ method: 'item/started', params: { item: { id: image.id, type: image.type, status: 'in_progress' } } });
        send({ method: 'item/completed', params: { item: image } });
        send({ method: 'item/completed', params: { item: message } });
      }
      const failed = prompt.includes('FAILED') || error || prompt.includes('NOTIFICATION_USAGE');
      send({ method: 'turn/completed', params: { turn: { status: failed ? 'failed' : 'completed', items: itemsOnly ? [image, message] : [], error: error || (failed ? { message: 'Outer turn failed' } : null) } } }); return;
    }
    if (prompt.includes('CONTENT_FAILURE') || prompt.includes('USAGE_FAILURE') || prompt.includes('TRANSIENT_FAILURE')) {
      const failure = prompt.includes('CONTENT_FAILURE') ? { code: 'content_policy_violation', message: 'Rejected by image content policy' } : prompt.includes('USAGE_FAILURE') ? { type: 'usageLimitExceeded' } : { code: 'internal_server_error', message: 'service temporarily unavailable' };
      send({ method: 'item/started', params: { item: { id: 'image-1', type: 'imageGeneration', status: 'in_progress' } } });
      send({ method: 'item/completed', params: { item: { id: 'image-1', type: 'imageGeneration', status: 'failed', result: JSON.stringify({ error: failure }) } } });
      send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'Outer turn failed' } } } }); return;
    }
    if (prompt.includes('AMBIGUOUS_DISCONNECT')) { send({ method: 'item/started', params: { item: { id: 'image-1', type: 'imageGeneration', status: 'in_progress' } } }); setTimeout(() => process.exit(1), 10); return; }
    if (!prompt.includes('NO_IMAGE') && !prompt.includes('FAIL')) {
      send({ method: 'item/started', params: { item: { id: 'image-1', type: 'imageGeneration', status: 'in_progress', result: '' } } });
      send({ method: 'item/completed', params: { item: { id: 'image-1', type: 'imageGeneration', status: 'completed', result: png } } });
    }
    send({ method: 'turn/completed', params: { turn: { status: prompt.includes('FAIL') || prompt.includes('RECOVER_IMAGE') ? 'failed' : 'completed', error: prompt.includes('FAIL') ? { message: 'Test generation failed' } : prompt.includes('RECOVER_IMAGE') ? { message: 'connection lost after completed image' } : null } } });
  }
});
