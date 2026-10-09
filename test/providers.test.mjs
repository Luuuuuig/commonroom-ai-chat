import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeCliAdapter, MockAdapter, OpenAIBlockedAdapter, createAdapters, parseClaudeResult, sanitizeChildEnv } from '../src/providers.mjs';

const FLAGS = '--safe-mode --tools --disallowedTools --strict-mcp-config --permission-mode --permission-prompts --no-session-persistence';
const SUCCESS = JSON.stringify({ type: 'system', subtype: 'init', model: 'fixture-claude' }) + '\n' + JSON.stringify({ type: 'result', subtype: 'success', result: 'Fixture response', session_id: 'session-fixture', is_error: false }) + '\n';

function fixtureSpawn(responses, calls = []) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; return true; };
    let input = '';
    child.stdin.on('data', (value) => { input += value; });
    const record = { executable, args, options, child, get input() { return input; } };
    calls.push(record);
    const response = responses.shift();
    process.nextTick(() => {
      child.emit('spawn');
      response?.onSpawn?.();
      if (response?.hang) return;
      if (response?.error) { child.emit('error', new Error('SECRET diagnostic')); return; }
      child.stdout.end(response?.stdout ?? '');
      child.stderr.end(response?.stderr ?? '');
      child.emit('close', response?.code ?? 0);
    });
    return child;
  };
}

function readyResponses(stateDir, last = { stdout: SUCCESS }) {
  return [
    { stdout: '2.1.290 (Claude Code)' }, { stdout: FLAGS },
    { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: path.join(stateDir, 'claude') }) }, last,
  ];
}

async function tempState(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'group-chat-provider-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('mock outputs are deterministic and explicitly mark no intelligent generation', async () => {
  const adapters = createAdapters();
  const a = await adapters.claude.run({ prompt: 'Two plus two', role: 'review' });
  assert.deepEqual(a, await adapters.claude.run({ prompt: 'Two plus two', role: 'review' }));
  assert.match(a.text, /^MOCK PEER REVIEW/);
  assert.match(a.text, /does not perform intelligent generation/);
  assert.equal(a.billing, 'mock');
  assert.equal((await adapters.codex.health()).status, 'mock');
});

test('mock honors both preexisting and immediate cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new MockAdapter().run({ prompt: 'x', signal: controller.signal }), { code: 'ABORTED', ambiguous: false });
  const later = new AbortController();
  const result = new MockAdapter().run({ prompt: 'x', signal: later.signal });
  later.abort();
  await assert.rejects(result, { code: 'ABORTED' });
});

test('live OpenAI route stays blocked with no fallback', async () => {
  const adapter = new OpenAIBlockedAdapter();
  assert.equal((await adapter.health()).status, 'blocked');
  await assert.rejects(adapter.run({ prompt: 'hello' }), { code: 'POLICY_UNVERIFIED', ambiguous: false });
  assert.ok(createAdapters({ mode: 'subscription' }).codex instanceof OpenAIBlockedAdapter);
  assert.throws(() => createAdapters({ mode: 'api' }), { detail: 'invalid_provider_mode' });
});

test('environment rejects billing/auth overrides and never inherits host home or secrets', () => {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL', 'NODE_OPTIONS']) {
    assert.throws(() => sanitizeChildEnv('/tmp/dedicated-group-chat', { [key]: 'secret' }), { detail: 'forbidden_provider_environment' });
  }
  const env = sanitizeChildEnv('/tmp/dedicated-group-chat', { HOME: '/original/home', SECRET: 'secret', PATH: '/usr/bin', LANG: 'C.UTF-8' });
  assert.equal(env.HOME, '/tmp/dedicated-group-chat/home');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/dedicated-group-chat/claude');
  assert.equal(env.SECRET, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('parser accepts only complete successful final result', () => {
  assert.deepEqual(parseClaudeResult(SUCCESS), { text: 'Fixture response', sessionRef: 'session-fixture', model: 'fixture-claude', billing: 'subscription' });
  for (const raw of ['', 'secret diagnostic', '{"type":"assistant","message":"partial"}', SUCCESS + '{"type":"assistant"}\n', SUCCESS + SUCCESS, '{"type":"result","subtype":"error","result":"SECRET","session_id":"x"}']) {
    assert.throws(() => parseClaudeResult(raw), (error) => error.ambiguous && !error.message.includes('SECRET') && !error.message.includes('diagnostic'));
  }
});

test('Claude preflight requires native subscription, invokes no tools, and uses stdin', async (t) => {
  const stateDir = await tempState(t); const calls = [];
  const adapter = new ClaudeCliAdapter({ subscriptionOnlyConfirmed: true, claudePath: '/fixture/claude', stateDir, env: { PATH: '/usr/bin' }, spawnImpl: fixtureSpawn(readyResponses(stateDir), calls) });
  const response = await adapter.run({ prompt: 'A user prompt with $(not shell code)' });
  assert.equal(response.billing, 'subscription');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2].args, ['auth', 'status']);
  const request = calls[3];
  assert.equal(request.options.shell, false);
  assert.equal(request.options.detached, true);
  assert.equal(request.input, 'A user prompt with $(not shell code)');
  assert.ok(request.args.includes('--safe-mode'));
  assert.ok(!request.args.includes('--bare'));
  assert.equal(request.args[request.args.indexOf('--tools') + 1], '');
  assert.equal(request.args[request.args.indexOf('--disallowedTools') + 1], 'mcp__*');
  assert.equal(request.args[request.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(request.args[request.args.indexOf('--permission-prompts') + 1], 'none');
});

test('API authentication is rejected before a model call and cannot fall back', async (t) => {
  const stateDir = await tempState(t); const calls = [];
  const responses = readyResponses(stateDir);
  responses[2].stdout = JSON.stringify({ loggedIn: true, authMethod: 'api_key' });
  const adapter = new ClaudeCliAdapter({ subscriptionOnlyConfirmed: true, claudePath: '/fixture/claude', stateDir, env: {}, spawnImpl: fixtureSpawn(responses, calls) });
  await assert.rejects(adapter.run({ prompt: 'hi' }), { code: 'AUTH_REQUIRED', ambiguous: false });
  assert.equal(calls.length, 3);
});

test('missing authentication reports auth_required without leaking raw stderr', async (t) => {
  const stateDir = await tempState(t);
  const responses = readyResponses(stateDir);
  responses[2] = { code: 1, stderr: 'SECRET token and email' };
  const adapter = new ClaudeCliAdapter({ subscriptionOnlyConfirmed: true, claudePath: '/fixture/claude', stateDir, env: {}, spawnImpl: fixtureSpawn(responses) });
  const health = await adapter.health();
  assert.equal(health.status, 'auth_required');
  assert.ok(!JSON.stringify(health).includes('SECRET'));
});

test('old CLI and missing flags are rejected before authentication/model calls', async (t) => {
  const stateDir = await tempState(t);
  for (const [responses, code] of [ [[{ stdout: '2.1.200' }], 'unsupported_cli_version'], [[{ stdout: '2.1.290' }, { stdout: '--tools' }], 'unsupported_cli_flags'] ]) {
    const adapter = new ClaudeCliAdapter({ subscriptionOnlyConfirmed: true, claudePath: '/fixture/claude', stateDir, env: {}, spawnImpl: fixtureSpawn(responses) });
    await assert.rejects(adapter.run({ prompt: 'hi' }), { detail: code });
  }
});

test('timeout after model spawn is ambiguous and kills the process', async (t) => {
  const stateDir = await tempState(t); const calls = [];
  const adapter = new ClaudeCliAdapter({ subscriptionOnlyConfirmed: true, claudePath: '/fixture/claude', stateDir, timeoutMs: 20, env: {}, spawnImpl: fixtureSpawn(readyResponses(stateDir, { hang: true }), calls) });
  await assert.rejects(adapter.run({ prompt: 'hi' }), { code: 'TIMEOUT', ambiguous: true });
  assert.equal(calls[3].child.killed, true);
});

test('timeout during preflight is not ambiguous', async (t) => {
  const stateDir = await tempState(t);
  const adapter = new ClaudeCliAdapter({ subscriptionOnlyConfirmed: true, claudePath: '/fixture/claude', stateDir, timeoutMs: 20, env: {}, spawnImpl: fixtureSpawn([{ hang: true }]) });
  await assert.rejects(adapter.run({ prompt: 'hi' }), { code: 'TIMEOUT', ambiguous: false });
});

test('no configuration means blocked health without attempting account discovery', async () => {
  assert.equal((await new ClaudeCliAdapter().health()).status, 'blocked');
});

test('spend confirmation is mandatory and separate from native authentication', async (t) => {
  const stateDir = await tempState(t); const calls = [];
  const adapter = new ClaudeCliAdapter({ claudePath: '/fixture/claude', stateDir, env: {}, spawnImpl: fixtureSpawn(readyResponses(stateDir), calls) });
  await assert.rejects(adapter.run({ prompt: 'hi' }), { code: 'CONFIGURATION_ERROR', detail: 'spend_controls_unverified', ambiguous: false });
  assert.equal(calls.length, 0);
  const health = await adapter.health();
  assert.equal(health.status, 'blocked');
  assert.equal(health.authStatus, 'ready');
  assert.equal(health.spendVerified, false);
  assert.equal(health.verified, false);
  assert.equal(calls.length, 3);
});

test('cancellation after model spawn kills child and records ambiguous outcome', async (t) => {
  const stateDir = await tempState(t); const calls = []; const controller = new AbortController();
  const adapter = new ClaudeCliAdapter({ subscriptionOnlyConfirmed: true, claudePath: '/fixture/claude', stateDir, env: {}, spawnImpl: fixtureSpawn(readyResponses(stateDir, { hang: true, onSpawn: () => controller.abort() }), calls) });
  await assert.rejects(adapter.run({ prompt: 'hi', signal: controller.signal }), { code: 'ABORTED', ambiguous: true });
  assert.equal(calls[3].child.killed, true);
});

test('structured quota failure pauses safely without retry or paid fallback', async (t) => {
  const stateDir = await tempState(t); const calls = [];
  const failure = { code: 1, stdout: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Usage limit reached SECRET'] }) };
  const adapter = new ClaudeCliAdapter({ subscriptionOnlyConfirmed: true, claudePath: '/fixture/claude', stateDir, env: {}, spawnImpl: fixtureSpawn(readyResponses(stateDir, failure), calls) });
  await assert.rejects(adapter.run({ prompt: 'hi' }), (error) => error.code === 'QUOTA_EXHAUSTED' && !error.message.includes('SECRET'));
  assert.equal(calls.length, 4);
});
