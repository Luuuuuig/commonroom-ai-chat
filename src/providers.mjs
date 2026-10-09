import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const REQUIRED_FLAGS = ['--safe-mode', '--tools', '--disallowedTools', '--strict-mcp-config', '--permission-mode', '--permission-prompts', '--no-session-persistence'];
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SAFE_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TZ'];
const FORBIDDEN_ENV = /^(ANTHROPIC_|OPENAI_|AZURE_OPENAI_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|CLAUDE_CODE_SIMPLE$|CLAUDE_CODE_SAFE_MODE$|CLAUDE_CONFIG_DIR$|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_CLOUD_|VERTEX_|BEDROCK_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NODE_OPTIONS$)/i;

export class ProviderError extends Error {
  constructor(code, { ambiguous = false } = {}) {
    // Messages intentionally contain only stable codes, never CLI output or credentials.
    const standardCode = ({
      auth_required: 'AUTH_REQUIRED', subscription_auth_required: 'AUTH_REQUIRED',
      quota_exhausted: 'QUOTA_EXHAUSTED', timeout: 'TIMEOUT', cancelled: 'ABORTED',
      policy_unverified: 'POLICY_UNVERIFIED', cli_unavailable: 'PROVIDER_UNAVAILABLE',
      cli_process_failed: 'PROVIDER_FAILED', provider_failed: 'PROVIDER_FAILED',
      output_limit: 'PROVIDER_FAILED', invalid_provider_output: 'PROVIDER_FAILED',
      incomplete_provider_result: 'PROVIDER_FAILED', preflight_failed: 'PROVIDER_UNAVAILABLE',
    })[code] ?? 'CONFIGURATION_ERROR';
    super(standardCode);
    this.name = 'ProviderError';
    this.code = standardCode;
    this.detail = code;
    this.ambiguous = ambiguous;
  }
}

export function sanitizeChildEnv(stateDir, sourceEnv = process.env) {
  if (!stateDir || !path.isAbsolute(stateDir) || path.resolve(stateDir) === path.resolve(homedir())) {
    throw new ProviderError('dedicated_state_required');
  }
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value && FORBIDDEN_ENV.test(key)) throw new ProviderError('forbidden_provider_environment');
  }
  const result = {};
  for (const key of SAFE_ENV_KEYS) if (sourceEnv[key]) result[key] = sourceEnv[key];
  result.HOME = path.join(path.resolve(stateDir), 'home');
  result.CLAUDE_CONFIG_DIR = path.join(path.resolve(stateDir), 'claude');
  result.TERM = 'dumb';
  result.NO_COLOR = '1';
  return result;
}

function abortError(ambiguous = false) {
  return new ProviderError('cancelled', { ambiguous });
}

function failureDetail(raw) {
  // Classify only a structured terminal failure, never user text or stderr.
  try {
    const last = JSON.parse(raw.trim().split(/\r?\n/).at(-1));
    if (last?.type !== 'result' || last.subtype === 'success') return 'provider_failed';
    const values = [last.result, last.error?.type, last.error?.code, ...(Array.isArray(last.errors) ? last.errors : [])];
    const reason = values.filter((value) => typeof value === 'string').join(' ');
    if (/rate.?limit|quota|usage.?limit|hit your limit/i.test(reason)) return 'quota_exhausted';
    if (/authentication_failed|login expired|not logged in|please (?:run \/login|log in)|unauthorized/i.test(reason)) return 'auth_required';
  } catch {}
  return 'provider_failed';
}

function runProcess({ executable, args, env, cwd, input = '', signal, timeoutMs, modelCall = false, spawnImpl = spawn }) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let started = false;
    let output = '';
    let outputBytes = 0;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const stop = () => {
      if (!child) return;
      // Every real child has a separate process group. Kill descendants too.
      try {
        if (Number.isInteger(child.pid) && child.pid > 1) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const onAbort = () => {
      stop();
      finish(abortError(modelCall && started));
    };
    try {
      child = spawnImpl(executable, args, { env, cwd, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      finish(new ProviderError('cli_unavailable'));
      return;
    }
    child.once('spawn', () => { started = true; });
    child.once('error', () => finish(new ProviderError(started ? 'cli_process_failed' : 'cli_unavailable', { ambiguous: modelCall && started })));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop();
        finish(new ProviderError('output_limit', { ambiguous: modelCall && started }));
      } else output += chunk.toString('utf8');
    });
    // Never retain, log, or return stderr. CLI diagnostics can contain secrets.
    child.stderr.on('data', () => {});
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new ProviderError(modelCall ? failureDetail(output) : 'preflight_failed', { ambiguous: modelCall && started }));
      } else finish(null, output);
    });
    child.stdin.on('error', () => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    timer = setTimeout(() => {
      stop();
      finish(new ProviderError('timeout', { ambiguous: modelCall && started }));
    }, timeoutMs);
    child.stdin.end(input);
  });
}

export function parseClaudeResult(raw) {
  let events;
  try {
    events = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch { throw new ProviderError('invalid_provider_output', { ambiguous: true }); }
  const result = events.at(-1);
  if (!result || result.type !== 'result' || result.subtype !== 'success' || result.is_error === true || typeof result.result !== 'string' || !result.result.trim()) {
    const detail = failureDetail(raw);
    throw new ProviderError(detail === 'provider_failed' ? 'incomplete_provider_result' : detail, { ambiguous: true });
  }
  const results = events.filter((event) => event?.type === 'result');
  if (results.length !== 1 || typeof result.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(result.session_id)) {
    throw new ProviderError('invalid_provider_output', { ambiguous: true });
  }
  const init = events.find((event) => event?.type === 'system' && event.subtype === 'init');
  return {
    text: result.result,
    sessionRef: result.session_id,
    ...(typeof init?.model === 'string' ? { model: init.model } : {}),
    billing: 'subscription',
  };
}

export class MockAdapter {
  constructor(provider = 'mock') { this.provider = provider; }
  async health() { return { status: 'mock', provider: this.provider, billing: 'mock', verified: false }; }
  async run({ prompt, role = 'answer', signal } = {}) {
    if (signal?.aborted) throw abortError();
    const content = String(prompt ?? '');
    const seed = createHash('sha256').update(content).digest('hex').slice(0, 12);
    const stage = /review/i.test(role) ? 'PEER REVIEW' : /revis/i.test(role) ? 'REVISION' : 'ANSWER';
    await Promise.resolve();
    if (signal?.aborted) throw abortError();
    return {
      text: `MOCK ${stage} (${this.provider}). Deterministic test fixture ${seed}. This verifies message routing and storage only. It does not perform intelligent generation, factual review, or revision.\n\nContext received: ${content.slice(-240)}`,
      sessionRef: `mock-${this.provider}-${seed}`,
      model: 'deterministic-test-fixture',
      billing: 'mock',
    };
  }
}

export class OpenAIBlockedAdapter {
  async health() {
    return { status: 'blocked', provider: 'codex', code: 'POLICY_UNVERIFIED', detail: 'policy_unverified', billing: 'subscription', verified: false };
  }
  async run({ signal } = {}) {
    if (signal?.aborted) throw abortError();
    throw new ProviderError('policy_unverified');
  }
}

export class ClaudeCliAdapter {
  constructor({ claudePath, stateDir, timeoutMs = 120_000, env = process.env, spawnImpl = spawn, subscriptionOnlyConfirmed = false } = {}) {
    this.claudePath = claudePath;
    this.stateDir = stateDir;
    this.timeoutMs = timeoutMs;
    this.sourceEnv = env;
    this.spawnImpl = spawnImpl;
    // Set true only after the owner verifies paid extra usage is disabled in
    // Anthropic's native billing UI. OAuth alone cannot prove this account state.
    this.subscriptionOnlyConfirmed = subscriptionOnlyConfirmed === true;
  }
  async preflight(signal) {
    if (signal?.aborted) throw abortError();
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new ProviderError('invalid_timeout');
    if (!this.claudePath || !path.isAbsolute(this.claudePath)) throw new ProviderError('claude_path_required');
    const env = sanitizeChildEnv(this.stateDir, this.sourceEnv);
    try {
      for (const dir of [this.stateDir, env.HOME, env.CLAUDE_CONFIG_DIR]) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        if ((await lstat(dir)).isSymbolicLink()) throw new ProviderError('dedicated_state_required');
        await chmod(dir, 0o700);
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('state_unavailable');
    }
    const call = (args) => runProcess({ executable: this.claudePath, args, env, cwd: env.HOME, signal, timeoutMs: Math.min(this.timeoutMs, 15_000), spawnImpl: this.spawnImpl });
    const versionOutput = await call(['--version']);
    const version = versionOutput.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 1) || (Number(version[1]) === 2 && Number(version[2]) === 1 && Number(version[3]) < 268)) {
      throw new ProviderError('unsupported_cli_version');
    }
    const help = await call(['--help']);
    if (REQUIRED_FLAGS.some((flag) => !help.includes(flag))) throw new ProviderError('unsupported_cli_flags');
    let auth;
    try { auth = JSON.parse(await call(['auth', 'status'])); }
    catch (error) {
      if (error instanceof ProviderError && ['cancelled', 'timeout', 'cli_unavailable'].includes(error.detail)) throw error;
      throw new ProviderError('auth_required');
    }
    if (!auth.loggedIn || auth.authMethod === 'none') throw new ProviderError('auth_required');
    if (auth.authMethod !== 'claude.ai') throw new ProviderError('subscription_auth_required');
    if (typeof auth.configDirectory !== 'string' || path.resolve(auth.configDirectory) !== path.resolve(env.CLAUDE_CONFIG_DIR)) throw new ProviderError('dedicated_state_required');
    return { env, version: version[0] };
  }
  async health() {
    try {
      const { version } = await this.preflight();
      return {
        status: this.subscriptionOnlyConfirmed ? 'ready' : 'blocked', provider: 'claude', version,
        authStatus: 'ready', spendVerified: this.subscriptionOnlyConfirmed,
        ...(!this.subscriptionOnlyConfirmed ? { code: 'CONFIGURATION_ERROR', detail: 'spend_controls_unverified' } : {}),
        billing: 'subscription', verified: false,
      };
    } catch (error) {
      return {
        status: error.code === 'AUTH_REQUIRED' ? 'auth_required' : 'blocked',
        provider: 'claude', code: error instanceof ProviderError ? error.code : 'CONFIGURATION_ERROR',
        detail: error instanceof ProviderError ? error.detail : 'configuration_error',
        authStatus: error.code === 'AUTH_REQUIRED' ? 'auth_required' : 'unverified',
        spendVerified: this.subscriptionOnlyConfirmed, billing: 'subscription', verified: false,
      };
    }
  }
  async run({ prompt, signal } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new ProviderError('invalid_prompt');
    if (!this.subscriptionOnlyConfirmed) throw new ProviderError('spend_controls_unverified');
    const { env } = await this.preflight(signal);
    const args = ['--safe-mode', '-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--max-turns', '1', '--no-session-persistence'];
    const raw = await runProcess({ executable: this.claudePath, args, env, cwd: env.HOME, input: prompt, signal, timeoutMs: this.timeoutMs, modelCall: true, spawnImpl: this.spawnImpl });
    return parseClaudeResult(raw);
  }
}

export function createAdapters({ mode = 'mock', ...options } = {}) {
  if (mode === 'mock') return { codex: new MockAdapter('codex'), claude: new MockAdapter('claude') };
  if (mode !== 'subscription') throw new ProviderError('invalid_provider_mode');
  return { codex: new OpenAIBlockedAdapter(), claude: new ClaudeCliAdapter(options) };
}
