import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIPlanAdapter } from '../src/siwc-provider.mjs';

// All responses and access tokens in this file are fixtures. No provider
// inference, real sign-in, billing status, or hosting is verified by these tests.
const OAUTH_TOKEN = 'fixture.oauth.access-token';
const MODELS = { models: [
  { slug: 'fixture-hidden', display_name: 'Hidden', visibility: 'hidden' },
  { slug: 'fixture-first', display_name: 'First visible', visibility: 'list' },
  { slug: 'fixture-second', display_name: 'Second visible', visibility: 'list' },
] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const completed = (text = 'Completed fixture text', extra = {}) => ({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', model: 'fixture-first', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }], ...extra } });
const frame = (event, separator = '\n') => `event: ${event.type}${separator}data: ${JSON.stringify(event)}${separator}${separator}`;
const stream = (events = [completed()]) => new Response(events.map((event) => typeof event === 'string' ? event : frame(event)).join(''), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

function fixture(options = {}, responses = [json(MODELS), stream()]) {
  const calls = [];
  const authCalls = [];
  const authClient = {
    async status() { authCalls.push('status'); return { status: 'ready', planUsage: true, account: { email: 'SECRET-private-identity' } }; },
    async getAccessToken({ signal }) { authCalls.push('token'); assert.ok(signal instanceof AbortSignal); return OAUTH_TOKEN; },
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    const response = responses.shift();
    if (typeof response === 'function') return response(url, init);
    if (!response) throw new Error('Unexpected fixture call SECRET');
    return response;
  };
  return { adapter: new OpenAIPlanAdapter({ authClient, subscriptionOnlyConfirmed: true, releasePublished: true, env: {}, fetchImpl, ...options }), calls, authCalls };
}

test('FIXTURE subscription request uses discovered first visible model and only supported fields', async () => {
  const { adapter, calls, authCalls } = fixture();
  assert.deepEqual(await adapter.run({ prompt: 'Review this whole prompt', role: 'review' }), { text: 'Completed fixture text', sessionRef: 'resp_fixture', model: 'fixture-first', billing: 'subscription' });
  assert.deepEqual(authCalls, ['token']);
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [['https://api.openai.com/v1/models', 'GET'], ['https://api.openai.com/v1/responses', 'POST']]);
  assert.deepEqual(JSON.parse(calls[1].body), { model: 'fixture-first', input: [{ role: 'user', content: 'Review this whole prompt' }], store: false, stream: true });
  assert.deepEqual(calls[0].headers, { Authorization: `Bearer ${OAUTH_TOKEN}` });
  assert.equal(calls[1].headers.Authorization, `Bearer ${OAUTH_TOKEN}`);
  assert.ok(calls.every((call) => call.redirect === 'error'));
});

test('FIXTURE configured model must be in the visible account catalog and never falls back', async () => {
  const chosen = fixture({ model: 'fixture-second' }, [json(MODELS), stream([completed('Second', { model: 'fixture-second' })])]);
  assert.equal((await chosen.adapter.run({ prompt: 'x' })).model, 'fixture-second');
  for (const model of ['unlisted-model', 'fixture-hidden']) {
    const { adapter, calls } = fixture({ model });
    await assert.rejects(adapter.run({ prompt: 'x' }), { detail: 'model_unavailable', ambiguous: false });
    assert.equal(calls.length, 1);
  }
});

test('FIXTURE refreshed catalogs are used on every request, including account switches', async () => {
  const second = { models: [{ slug: 'fixture-other-account', display_name: 'Other', visibility: 'list' }] };
  const { adapter, calls } = fixture({}, [json(MODELS), stream(), json(second), stream([completed('Other', { model: 'fixture-other-account' })])]);
  await adapter.run({ prompt: 'one' });
  await adapter.run({ prompt: 'two' });
  assert.equal(calls.length, 4);
  assert.equal(JSON.parse(calls[3].body).model, 'fixture-other-account');
});

test('FIXTURE publication and spend gates must be literal true before network or credentials', async () => {
  for (const [options, detail] of [
    [{ releasePublished: false }, 'policy_unverified'], [{ releasePublished: 'true' }, 'policy_unverified'],
    [{ subscriptionOnlyConfirmed: false }, 'spend_controls_unverified'], [{ subscriptionOnlyConfirmed: 'true' }, 'spend_controls_unverified'],
  ]) {
    const { adapter, calls, authCalls } = fixture(options);
    await assert.rejects(adapter.run({ prompt: 'x' }), { detail, ambiguous: false });
    assert.equal((await adapter.health()).status, 'blocked');
    assert.equal(calls.length, 0);
    assert.equal(authCalls.length, 0);
  }
});

test('FIXTURE dangerous provider, API-key, endpoint and proxy environment overrides are rejected', async () => {
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_API_KEY', 'ACCESS_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_OPTIONS', 'AWS_ACCESS_KEY_ID']) {
    const { adapter, calls, authCalls } = fixture({ env: { [key]: 'SECRET' } });
    await assert.rejects(adapter.run({ prompt: 'x' }), (error) => error.detail === 'forbidden_provider_environment' && !error.message.includes('SECRET'));
    assert.equal(calls.length, 0);
    assert.equal(authCalls.length, 0);
  }
});

test('FIXTURE API-key-shaped or invalid access tokens are never sent as OAuth credentials', async () => {
  for (const token of ['sk-project-secret', 'sk-SECRET', '', 'secret\r\nInjected: value', 'two tokens', 'x'.repeat(16_385), null]) {
    const { adapter, calls } = fixture({ authClient: { status: async () => ({ status: 'ready' }), getAccessToken: async () => token } });
    await assert.rejects(adapter.run({ prompt: 'x' }), { code: 'AUTH_REQUIRED', ambiguous: false });
    assert.equal(calls.length, 0);
  }
});

test('FIXTURE health exposes safe status only and never calls inference or reads credentials', async () => {
  const { adapter, calls, authCalls } = fixture();
  const health = await adapter.health();
  assert.equal(health.status, 'ready');
  assert.equal(health.verified, false);
  assert.equal(health.billing, 'subscription');
  assert.equal(calls.length, 0);
  assert.deepEqual(authCalls, ['status']);
  assert.ok(!JSON.stringify(health).includes('SECRET'));
  assert.ok(!JSON.stringify(health).includes(OAUTH_TOKEN));
  const signedOut = fixture({ authClient: { status: async () => ({ status: 'auth_required' }), getAccessToken: async () => { throw new Error(); } } });
  assert.equal((await signedOut.adapter.health()).status, 'auth_required');
  const declined = fixture({ authClient: { status: async () => ({ status: 'blocked', planUsage: false, detail: 'plan_permission_required' }), getAccessToken: async () => { throw Object.assign(new Error('SECRET'), { code: 'PLAN_PERMISSION_REQUIRED' }); } } });
  await assert.rejects(declined.adapter.run({ prompt: 'x' }), { code: 'AUTH_REQUIRED', ambiguous: false });
  assert.equal(declined.calls.length, 0);
});

test('FIXTURE fragmented UTF-8, CRLF and multiline data yield exact final text only', async () => {
  const delta = frame({ type: 'response.output_text.delta', delta: 'Wrong provisional text' }, '\r\n');
  const final = completed('你好, café 👋\nFinal text.');
  const finalData = JSON.stringify(final, null, 2).split('\n').map((line) => `data: ${line}\r\n`).join('');
  const bytes = new TextEncoder().encode(`: keepalive\r\n\r\n${delta}event: response.completed\r\n${finalData}\r\n`);
  let cursor = 0;
  const body = new ReadableStream({ pull(controller) { if (cursor === bytes.length) controller.close(); else controller.enqueue(bytes.slice(cursor, ++cursor)); } });
  const { adapter } = fixture({}, [json(MODELS), new Response(body, { headers: { 'content-type': 'text/event-stream' } })]);
  assert.equal((await adapter.run({ prompt: 'x' })).text, '你好, café 👋\nFinal text.');
});

test('FIXTURE SSE supports CR-only framing and joins final output parts without invented separators', async () => {
  const event = completed('first');
  event.response.output[0].content.push({ type: 'output_text', text: '\nsecond' });
  event.response.output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ' third' }] });
  const { adapter } = fixture({}, [json(MODELS), stream([frame(event, '\r')])]);
  assert.equal((await adapter.run({ prompt: 'x' })).text, 'first\nsecond third');
});

test('FIXTURE usage failures after text never become a success or trigger retry/fallback', async () => {
  for (const [code, expected] of [['subscription_sharing_usage_limit_exceeded', 'QUOTA_EXHAUSTED'], ['subscription_sharing_usage_unavailable', 'PROVIDER_UNAVAILABLE']]) {
    const { adapter, calls } = fixture({}, [json(MODELS), stream([{ type: 'response.output_text.delta', delta: 'Already streamed answer' }, { type: 'response.failed', response: { error: { code, message: 'SECRET raw diagnostic' } } }])]);
    await assert.rejects(adapter.run({ prompt: 'x' }), (error) => error.code === expected && error.ambiguous && !error.message.includes('SECRET'));
    assert.equal(calls.length, 2);
  }
});

test('FIXTURE terminal failures, EOF, malformed frames and incomplete status are never success', async () => {
  for (const events of [
    [], [{ type: 'response.output_text.delta', delta: 'partial' }],
    [{ type: 'response.incomplete', response: { status: 'incomplete' } }],
    [{ type: 'error', code: 'unknown_fixture_error', message: 'SECRET' }],
    [completed('partial', { status: 'in_progress' })], [completed('')],
    ['data: [DONE]\n\n'], ['data: SECRET-invalid-json\n\n'],
    [`event: response.failed\ndata: ${JSON.stringify(completed())}\n\n`],
    [`data: ${JSON.stringify(completed())}`],
  ]) {
    const { adapter, calls } = fixture({}, [json(MODELS), stream(events)]);
    await assert.rejects(adapter.run({ prompt: 'x' }), (error) => error.code === 'PROVIDER_FAILED' && error.ambiguous && !error.message.includes('SECRET'));
    assert.equal(calls.length, 2);
  }
});

test('FIXTURE completed output must contain a safe response ID and valid assistant text', async () => {
  for (const change of [
    { id: 'unsafe ID\nSECRET' }, { id: undefined }, { model: 'unsafe SECRET' },
    { output: [{ type: 'message', role: 'user', content: [{ type: 'output_text', text: 'Wrong role' }] }] },
    { output: [{ type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: 'Partial' }] }] },
    { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: null }] }] },
    { output: [{ type: 'function_call', arguments: 'Not an answer' }] },
  ]) {
    const { adapter } = fixture({}, [json(MODELS), stream([completed('text', change)])]);
    await assert.rejects(adapter.run({ prompt: 'x' }), { code: 'PROVIDER_FAILED', ambiguous: true });
  }
});

test('FIXTURE HTTP admission failures are classified safely with no retry', async () => {
  for (const [status, body, expected, ambiguous] of [
    [401, { detail: 'SECRET signed identity rejected' }, 'AUTH_REQUIRED', false],
    [403, { error: { code: 'subscription_sharing_user_not_eligible', message: 'SECRET' } }, 'POLICY_UNVERIFIED', false],
    [429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'SECRET' } }, 'QUOTA_EXHAUSTED', false],
    [503, { error: { code: 'subscription_sharing_usage_unavailable', message: 'SECRET' } }, 'PROVIDER_UNAVAILABLE', true],
    [400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'SECRET' } }, 'PROVIDER_FAILED', false],
    [500, { unexpected: 'SECRET' }, 'PROVIDER_FAILED', true],
  ]) {
    const { adapter, calls } = fixture({}, [json(MODELS), json(body, status)]);
    await assert.rejects(adapter.run({ prompt: 'x' }), (error) => error.code === expected && error.ambiguous === ambiguous && !JSON.stringify(error).includes('SECRET'));
    assert.equal(calls.length, 2);
  }
});

test('FIXTURE malformed, missing and oversized catalogs prevent inference', async () => {
  for (const response of [json({ data: [{ id: 'api-model' }] }), json({ models: [] }), json({ models: [{ slug: 'invalid SECRET\n', visibility: 'list' }] }), new Response('SECRET not json'), new Response('x'.repeat(1024 * 1024 + 1)), json({ detail: 'SECRET' }, 401)]) {
    const { adapter, calls } = fixture({}, [response]);
    await assert.rejects(adapter.run({ prompt: 'x' }), (error) => !error.ambiguous && !error.message.includes('SECRET'));
    assert.equal(calls.length, 1);
  }
});

test('FIXTURE response stream is bounded and rejects wrong content type or invalid UTF-8', async () => {
  for (const response of [
    json(completed()), stream(['data: ' + 'x'.repeat(2 * 1024 * 1024)]),
    new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'content-type': 'text/event-stream' } }),
  ]) {
    const { adapter } = fixture({}, [json(MODELS), response]);
    await assert.rejects(adapter.run({ prompt: 'x' }), { code: 'PROVIDER_FAILED', ambiguous: true });
  }
});

test('FIXTURE cancellation before request is certain and performs no work', async () => {
  const controller = new AbortController(); controller.abort();
  const { adapter, calls, authCalls } = fixture();
  await assert.rejects(adapter.run({ prompt: 'x', signal: controller.signal }), { code: 'ABORTED', ambiguous: false });
  assert.equal(calls.length, 0);
  assert.equal(authCalls.length, 0);
});

test('FIXTURE cancellation triggered during token lookup consumes its late rejection', async () => {
  const controller = new AbortController();
  const { adapter, calls } = fixture({ authClient: {
    status: async () => ({ status: 'ready' }),
    getAccessToken() { controller.abort(); return Promise.reject(new Error('SECRET late token failure')); },
  } });
  await assert.rejects(adapter.run({ prompt: 'x', signal: controller.signal }), { code: 'ABORTED', ambiguous: false });
  assert.equal(calls.length, 0);
});

test('FIXTURE cancellation during discovery is certain while cancellation after POST is ambiguous', async () => {
  for (const submitted of [false, true]) {
    const controller = new AbortController();
    const hanging = (_url, { signal }) => { queueMicrotask(() => controller.abort()); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('SECRET cancellation')), { once: true })); };
    const { adapter, calls } = fixture({}, submitted ? [json(MODELS), hanging] : [hanging]);
    await assert.rejects(adapter.run({ prompt: 'x', signal: controller.signal }), { code: 'ABORTED', ambiguous: submitted });
    assert.equal(calls.length, submitted ? 2 : 1);
    assert.ok(calls.at(-1).signal.aborted);
  }
});

test('FIXTURE timeouts abort requests without retries even if a transport ignores cancellation', async () => {
  for (const submitted of [false, true]) {
    const hanging = () => new Promise(() => {});
    const { adapter, calls } = fixture({ timeoutMs: 15 }, submitted ? [json(MODELS), hanging] : [hanging]);
    await assert.rejects(adapter.run({ prompt: 'x' }), { code: 'TIMEOUT', ambiguous: submitted });
    assert.equal(calls.length, submitted ? 2 : 1);
    assert.ok(calls.at(-1).signal.aborted);
  }
});

test('FIXTURE an interrupted stream is cancelled and preserves an ambiguous outcome', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame({ type: 'response.output_text.delta', delta: 'partial' }))); }, cancel() { cancelled = true; } });
  const { adapter } = fixture({ timeoutMs: 15 }, [json(MODELS), new Response(body, { headers: { 'content-type': 'text/event-stream' } })]);
  await assert.rejects(adapter.run({ prompt: 'x' }), { code: 'TIMEOUT', ambiguous: true });
  assert.equal(cancelled, true);
});

test('FIXTURE unknown auth and network errors are sanitized and cannot fall back', async () => {
  const failure = () => { throw new Error('SECRET upstream failure'); };
  const noAuth = fixture({ authClient: { status: failure, getAccessToken: failure } });
  await assert.rejects(noAuth.adapter.run({ prompt: 'x' }), { code: 'PROVIDER_UNAVAILABLE', ambiguous: false });
  assert.ok(!JSON.stringify(await noAuth.adapter.health()).includes('SECRET'));
  assert.equal(noAuth.calls.length, 0);
  const network = fixture({}, [json(MODELS), failure]);
  await assert.rejects(network.adapter.run({ prompt: 'x' }), { code: 'PROVIDER_FAILED', ambiguous: true });
  assert.equal(network.calls.length, 2);
});

test('FIXTURE invalid local configuration or prompt never reaches providers', async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2 ** 32 }, { model: 'SECRET invalid model' }, { authClient: null }, { fetchImpl: null }]) {
    const { adapter, calls } = fixture(options);
    await assert.rejects(adapter.run({ prompt: 'x' }), (error) => !error.ambiguous && !error.message.includes('SECRET'));
    assert.equal(calls.length, 0);
  }
  for (const prompt of [undefined, '', '   ', {}, 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const { adapter, calls } = fixture();
    await assert.rejects(adapter.run({ prompt }), { detail: 'invalid_prompt', ambiguous: false });
    assert.equal(calls.length, 0);
  }
});
