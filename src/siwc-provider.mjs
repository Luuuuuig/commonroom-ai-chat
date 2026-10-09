import { ProviderError } from './providers.mjs';

// The OAuth subscription route uses these public endpoints. Neither endpoint
// nor authentication can be overridden with a model API key or a proxy URL.
const MODELS_URL = 'https://api.openai.com/v1/models';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_ENV = /^(OPENAI_|ANTHROPIC_|AZURE_OPENAI_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_CLOUD_|VERTEX_|BEDROCK_|ACCESS_TOKEN$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NODE_OPTIONS$)/i;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function checkEnvironment(env) {
  if (!env || typeof env !== 'object') throw new ProviderError('forbidden_provider_environment');
  for (const [key, value] of Object.entries(env)) {
    if (value && FORBIDDEN_ENV.test(key)) throw new ProviderError('forbidden_provider_environment');
  }
}

function errorForStatus(status, code, ambiguous = false) {
  // Interpret structured codes only. Never return raw diagnostics or a token.
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) return new ProviderError('quota_exhausted', { ambiguous });
  if (['subscription_sharing_invalid_user', 'invalid_api_key', 'invalid_token', 'authentication_error'].includes(code) || status === 401) return new ProviderError('auth_required', { ambiguous });
  if (['subscription_sharing_user_not_eligible', 'subscription_sharing_route_not_supported', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'].includes(code) || status === 403) return new ProviderError('policy_unverified', { ambiguous });
  if (['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(code) || status === 503) return new ProviderError('preflight_failed', { ambiguous });
  return new ProviderError('provider_failed', { ambiguous });
}

function authError(error) {
  if (error?.code === 'ABORTED') return new ProviderError('cancelled');
  if (['AUTH_REQUIRED', 'PLAN_PERMISSION_REQUIRED', 'AUTH_TOKEN_INVALID', 'AUTH_REFRESH_REJECTED'].includes(error?.code)) return new ProviderError('subscription_auth_required');
  return new ProviderError('preflight_failed');
}

function abortable(promise, signal) {
  if (signal.aborted) {
    // A transport may synchronously trigger cancellation before returning a
    // promise. Still consume any later rejection from that started operation.
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(new ProviderError('cancelled'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ProviderError('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readBody(response, limit, signal) {
  if (!response.body?.getReader) throw new ProviderError('invalid_provider_output');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) return text + decoder.decode();
      if (!(chunk.value instanceof Uint8Array)) throw new ProviderError('invalid_provider_output');
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new ProviderError('output_limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    // Cancellation is best effort and must not keep an interrupted job running.
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
}

async function checkResponse(response, signal, modelCall) {
  if (!response || !Number.isInteger(response.status)) throw new ProviderError('invalid_provider_output', { ambiguous: modelCall });
  if (response.status >= 200 && response.status < 300 && response.redirected !== true) return;
  let code;
  try {
    const data = JSON.parse(await readBody(response, MAX_ERROR_BYTES, signal));
    code = typeof data?.error?.code === 'string' ? data.error.code : undefined;
  } catch (error) {
    if (signal.aborted) throw error;
  }
  // An explicit admission rejection is known to have failed. A server or
  // transport failure after submitting inference may have consumed usage.
  const ambiguous = modelCall && (response.status >= 500 || response.status < 400);
  throw errorForStatus(response.status, code, ambiguous);
}

function completeOutput(response, model) {
  if (response?.status !== 'completed') throw new ProviderError('incomplete_provider_result', { ambiguous: true });
  if (!SAFE_ID.test(response.id ?? '') || !Array.isArray(response.output)) throw new ProviderError('invalid_provider_output', { ambiguous: true });
  const pieces = [];
  for (const item of response.output) {
    if (item?.type !== 'message') continue;
    if (item.role !== 'assistant' || !Array.isArray(item.content) || (item.status !== undefined && item.status !== 'completed')) throw new ProviderError('invalid_provider_output', { ambiguous: true });
    for (const part of item.content) {
      if (part?.type === 'output_text') {
        if (typeof part.text !== 'string') throw new ProviderError('invalid_provider_output', { ambiguous: true });
        pieces.push(part.text);
      }
    }
  }
  const text = pieces.join('');
  if (!text.trim()) throw new ProviderError('incomplete_provider_result', { ambiguous: true });
  if (response.model !== undefined && (typeof response.model !== 'string' || !SAFE_MODEL.test(response.model))) throw new ProviderError('invalid_provider_output', { ambiguous: true });
  return { text, sessionRef: response.id, model: response.model ?? model, billing: 'subscription' };
}

async function readCompletion(response, signal, model) {
  if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers?.get('content-type') ?? '') || !response.body?.getReader) throw new ProviderError('invalid_provider_output', { ambiguous: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  let eventName = '';
  let data = [];

  const dispatch = () => {
    if (!data.length) { eventName = ''; return; }
    const payload = data.join('\n');
    const name = eventName;
    data = [];
    eventName = '';
    if (payload === '[DONE]') throw new ProviderError('incomplete_provider_result', { ambiguous: true });
    let event;
    try { event = JSON.parse(payload); }
    catch { throw new ProviderError('invalid_provider_output', { ambiguous: true }); }
    if (!event || typeof event.type !== 'string' || (name && name !== event.type)) throw new ProviderError('invalid_provider_output', { ambiguous: true });
    if (event.type === 'response.completed') return completeOutput(event.response, model);
    if (event.type === 'response.failed') throw errorForStatus(undefined, event.response?.error?.code, true);
    if (event.type === 'error') throw errorForStatus(undefined, event.code ?? event.error?.code, true);
    if (event.type === 'response.incomplete') throw new ProviderError('incomplete_provider_result', { ambiguous: true });
    // Deltas are provisional. A quota failure may follow already streamed text.
  };

  const line = (value) => {
    if (!value) return dispatch();
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    else if (field === 'event') eventName = content;
  };

  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (!chunk.done) {
        if (!(chunk.value instanceof Uint8Array)) throw new ProviderError('invalid_provider_output', { ambiguous: true });
        bytes += chunk.value.byteLength;
        if (bytes > MAX_STREAM_BYTES) throw new ProviderError('output_limit', { ambiguous: true });
        buffer += decoder.decode(chunk.value, { stream: true });
      } else buffer += decoder.decode();

      // Support CR, LF, and CRLF even when either UTF-8 or CRLF is fragmented.
      let start = 0;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] !== '\r' && buffer[index] !== '\n') continue;
        if (buffer[index] === '\r' && index === buffer.length - 1 && !chunk.done) break;
        const result = line(buffer.slice(start, index));
        if (buffer[index] === '\r' && buffer[index + 1] === '\n') index++;
        start = index + 1;
        if (result) return result;
      }
      buffer = buffer.slice(start);
      // An event without its empty-line delimiter is an interrupted frame.
      if (chunk.done) throw new ProviderError('incomplete_provider_result', { ambiguous: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
}

export class OpenAIPlanAdapter {
  constructor({ authClient, model, subscriptionOnlyConfirmed = false, releasePublished = false, timeoutMs = 120_000, fetchImpl = fetch, env = process.env } = {}) {
    this.authClient = authClient;
    this.model = model;
    this.subscriptionOnlyConfirmed = subscriptionOnlyConfirmed === true;
    this.releasePublished = releasePublished === true;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.sourceEnv = env;
  }

  validateConfiguration() {
    checkEnvironment(this.sourceEnv);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) throw new ProviderError('invalid_timeout');
    if (this.model !== undefined && (typeof this.model !== 'string' || !SAFE_MODEL.test(this.model))) throw new ProviderError('invalid_model');
    if (typeof this.fetchImpl !== 'function') throw new ProviderError('invalid_provider_configuration');
    if (!this.releasePublished) throw new ProviderError('policy_unverified');
    if (!this.subscriptionOnlyConfirmed) throw new ProviderError('spend_controls_unverified');
    if (typeof this.authClient?.status !== 'function' || typeof this.authClient?.getAccessToken !== 'function') throw new ProviderError('auth_required');
  }

  async health() {
    let authStatus = 'unverified';
    try {
      this.validateConfiguration();
      let status;
      try { status = await this.authClient.status(); }
      catch (error) { throw authError(error); }
      authStatus = status?.status === 'ready' ? 'ready' : 'auth_required';
      if (authStatus !== 'ready') throw new ProviderError('subscription_auth_required');
      return { status: 'ready', provider: 'codex', authStatus, spendVerified: true, releasePublished: true, billing: 'subscription', verified: false };
    } catch (error) {
      const safe = error instanceof ProviderError ? error : new ProviderError('invalid_provider_configuration');
      return { status: safe.code === 'AUTH_REQUIRED' ? 'auth_required' : 'blocked', provider: 'codex', authStatus, code: safe.code, detail: safe.detail, spendVerified: this.subscriptionOnlyConfirmed, releasePublished: this.releasePublished, billing: 'subscription', verified: false };
    }
  }

  async run({ prompt, signal } = {}) {
    if (signal?.aborted) throw new ProviderError('cancelled');
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_STREAM_BYTES) throw new ProviderError('invalid_prompt');
    this.validateConfiguration();
    const controller = new AbortController();
    let timedOut = false;
    let submitted = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const requestSignal = controller.signal;
    try {
      let token;
      try { token = await abortable(this.authClient.getAccessToken({ signal: requestSignal }), requestSignal); }
      catch (error) { throw authError(error); }
      if (typeof token !== 'string' || token.length > 16_384 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token) || /^sk-/i.test(token)) throw new ProviderError('subscription_auth_required');
      const headers = { Authorization: `Bearer ${token}` };
      if (requestSignal.aborted) throw new ProviderError('cancelled');
      const catalogResponse = await abortable(this.fetchImpl(MODELS_URL, { method: 'GET', headers, signal: requestSignal, redirect: 'error' }), requestSignal);
      await checkResponse(catalogResponse, requestSignal, false);
      let catalog;
      try { catalog = JSON.parse(await readBody(catalogResponse, MAX_CATALOG_BYTES, requestSignal)); }
      catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError('invalid_provider_output'); }
      if (!Array.isArray(catalog?.models)) throw new ProviderError('invalid_provider_output');
      const available = catalog.models.filter((entry) => entry?.visibility === 'list' && typeof entry.slug === 'string' && SAFE_MODEL.test(entry.slug));
      // Discover every time so an account switch never reuses another catalog.
      const model = this.model === undefined ? available[0]?.slug : available.find((entry) => entry.slug === this.model)?.slug;
      if (!model) throw new ProviderError('model_unavailable');
      if (requestSignal.aborted) throw new ProviderError('cancelled');
      submitted = true;
      const response = await abortable(this.fetchImpl(RESPONSES_URL, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model, input: [{ role: 'user', content: prompt }], store: false, stream: true }),
        signal: requestSignal, redirect: 'error',
      }), requestSignal);
      await checkResponse(response, requestSignal, true);
      return await readCompletion(response, requestSignal, model);
    } catch (error) {
      if (requestSignal.aborted) throw new ProviderError(timedOut ? 'timeout' : 'cancelled', { ambiguous: submitted });
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(submitted ? 'provider_failed' : 'preflight_failed', { ambiguous: submitted });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
