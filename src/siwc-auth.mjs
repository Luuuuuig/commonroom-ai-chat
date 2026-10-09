import { randomBytes, randomUUID, createHash, createPublicKey, verify as verifySignature, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, lstat, chmod, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// Public-client SIWC only. No configurable provider origin or API-key fallback.
export const SIWC = Object.freeze({
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  resource: 'https://api.openai.com/v1',
  scopes: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  appName: 'Commonroom AI Group Chat',
});

const MAX_JSON_BYTES = 128 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const SAFE_OAUTH_ERRORS = new Set([...TERMINAL_REFRESH_ERRORS, 'invalid_client', 'invalid_request', 'invalid_scope', 'access_denied', 'temporarily_unavailable', 'server_error']);
const safeString = (value, max = 32768) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clientIdValid = (value) => typeof value === 'string' && /^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(value);
const nowSeconds = (now) => Math.floor(now / 1000);
const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class SiwcAuthError extends Error {
  constructor(code, { status, oauthCode, requestId } = {}) {
    super(code);
    this.name = 'SiwcAuthError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
    if (SAFE_OAUTH_ERRORS.has(oauthCode)) this.oauthCode = oauthCode;
    if (typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId)) this.requestId = requestId;
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new SiwcAuthError('ABORTED');
}

function decodeSegment(segment) {
  if (!safeString(segment) || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new SiwcAuthError('AUTH_TOKEN_INVALID');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new SiwcAuthError('AUTH_TOKEN_INVALID');
  return bytes;
}

function parseJwt(token) {
  try {
    if (!safeString(token)) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeSegment(parts[0])));
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeSegment(parts[1])));
    const signature = decodeSegment(parts[2]);
    if (!isObject(header) || !isObject(payload)) throw new Error();
    return { header, payload, signature, signed: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii') };
  } catch { throw new SiwcAuthError('AUTH_TOKEN_INVALID'); }
}

/** Explicit implementation limit: RS256 only, rejected closed for other algorithms.
 * The current documentation does not guarantee a particular signing algorithm.
 * Account verification remains unverified until a real sign-in succeeds.
 */
export function verifyIdToken(token, { jwks, clientId, nonce, subject, now = Date.now() } = {}) {
  const { header, payload, signature, signed } = parseJwt(token);
  if (header.alg !== 'RS256' || !safeString(header.kid, 256) || header.crit !== undefined || header.b64 !== undefined || (header.typ !== undefined && header.typ !== 'JWT')) {
    throw new SiwcAuthError('AUTH_TOKEN_ALGORITHM_UNSUPPORTED');
  }
  if (!clientIdValid(clientId) || !isObject(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > 100) throw new SiwcAuthError('AUTH_TOKEN_INVALID');
  const matching = jwks.keys.filter((key) => isObject(key) && key.kid === header.kid);
  if (matching.length === 0) throw new SiwcAuthError('AUTH_JWKS_KEY_MISSING');
  if (matching.length !== 1) throw new SiwcAuthError('AUTH_TOKEN_INVALID');
  const jwk = matching[0];
  if (jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256') || (jwk.use !== undefined && jwk.use !== 'sig') || (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))) {
    throw new SiwcAuthError('AUTH_TOKEN_INVALID');
  }
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048 || !verifySignature('RSA-SHA256', signed, key, signature)) throw new Error();
  } catch { throw new SiwcAuthError('AUTH_TOKEN_INVALID'); }
  const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
  const clock = nowSeconds(now);
  if (payload.iss !== SIWC.issuer || !Array.isArray(audiences) || !audiences.length || !audiences.every((value) => safeString(value, 256)) || !audiences.includes(clientId)
    || ((audiences.length > 1 || payload.azp !== undefined) && payload.azp !== clientId)
    || !Number.isInteger(payload.exp) || payload.exp <= clock - 5
    || !Number.isInteger(payload.iat) || payload.iat > clock + 5 || payload.iat >= payload.exp
    || (payload.nbf !== undefined && (!Number.isInteger(payload.nbf) || payload.nbf > clock + 5))
    || !safeString(payload.sub, 1024)
    || (nonce !== undefined && (!safeString(nonce, 256) || !equalSecret(payload.nonce, nonce)))
    || (subject !== undefined && payload.sub !== subject)) {
    throw new SiwcAuthError('AUTH_TOKEN_INVALID');
  }
  return payload;
}

async function privateDirectory(directory, create = true) {
  // Reject symlink ancestors before creating anything below them.
  const root = path.parse(directory).root;
  let current = root;
  for (const component of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new SiwcAuthError('AUTH_STATE_UNAVAILABLE');
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw new SiwcAuthError('AUTH_STATE_UNAVAILABLE'); }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SiwcAuthError('AUTH_STATE_UNSAFE');
  }
  if (create) await chmod(directory, 0o700);
  return true;
}

async function readProtectedJson(filename) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw new SiwcAuthError('AUTH_STATE_UNSAFE');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SiwcAuthError) throw error;
    throw new SiwcAuthError(error.code === 'ELOOP' ? 'AUTH_STATE_UNSAFE' : 'AUTH_STATE_UNAVAILABLE');
  } finally { await handle?.close(); }
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle;
  try {
    try {
      const existing = await lstat(filename);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new SiwcAuthError('AUTH_STATE_UNSAFE');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filename);
    // fsync the directory so a successful rotation is durable after a crash.
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(filename), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    if (error instanceof SiwcAuthError) throw error;
    throw new SiwcAuthError('AUTH_STATE_UNAVAILABLE');
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
}

function validateRecord(record) {
  if (record === null) return null;
  if (!isObject(record) || record.version !== 1 || !clientIdValid(record.client_id)
    || record.issuer !== SIWC.issuer || (record.subject !== null && !safeString(record.subject, 1024))
    || !Array.isArray(record.scopes) || !record.scopes.every((scope) => safeString(scope, 200))
    || (record.expires_at !== null && !Number.isFinite(record.expires_at))) throw new SiwcAuthError('AUTH_STATE_INVALID');
  for (const field of ['access_token', 'refresh_token', 'id_token']) {
    if (record[field] !== undefined && !safeString(record[field])) throw new SiwcAuthError('AUTH_STATE_INVALID');
  }
  if ((record.access_token || record.refresh_token) && !record.subject) throw new SiwcAuthError('AUTH_STATE_INVALID');
  if (record.access_token && (!Number.isFinite(record.expires_at) || record.token_type !== 'Bearer')) throw new SiwcAuthError('AUTH_STATE_INVALID');
  return record;
}

function publicStatus(record, now) {
  const account = record?.subject ? { issuer: record.issuer, subject: record.subject, clientId: record.client_id, ...(safeString(record.email, 320) ? { email: record.email } : {}) } : null;
  const planUsage = Boolean(record?.scopes.includes('chatgpt.tokens.use.direct'));
  let status = 'auth_required';
  let detail = 'sign_in_required';
  if (account && !planUsage && record.id_token) { status = 'blocked'; detail = 'plan_permission_required'; }
  else if (account && planUsage && record.access_token && (record.expires_at > now || record.refresh_token)) { status = 'ready'; detail = 'credentials_available'; }
  return { status, detail, planUsage, account, expiresAt: record?.expires_at ?? null, renewable: Boolean(record?.refresh_token), verified: false };
}

async function jsonResponse(response) {
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_JSON_BYTES) throw new Error();
      chunks.push(chunk);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!isObject(value)) throw new Error();
    return value;
  } catch { throw new SiwcAuthError('AUTH_RESPONSE_INVALID'); }
}

export class SiwcAuthClient {
  constructor({ stateDir, fetchImpl = globalThis.fetch, now = Date.now, lockTimeoutMs = 30_000, requestTimeoutMs = 20_000 } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || path.resolve(stateDir) === path.parse(path.resolve(stateDir)).root
      || typeof fetchImpl !== 'function' || typeof now !== 'function'
      || !Number.isFinite(lockTimeoutMs) || lockTimeoutMs <= 0 || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new SiwcAuthError('AUTH_CONFIGURATION_INVALID');
    this.stateDir = path.resolve(stateDir);
    this.credentialsPath = path.join(this.stateDir, 'credentials.json');
    this.hostPath = path.join(this.stateDir, 'host.json');
    this.lockPath = path.join(this.stateDir, 'credentials.lock');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.jwksCache = null;
  }

  async status() {
    if (!await privateDirectory(this.stateDir, false)) return publicStatus(null, this.now());
    return publicStatus(validateRecord(await readProtectedJson(this.credentialsPath)), this.now());
  }

  async _locked(action, signal) {
    checkAbort(signal);
    await privateDirectory(this.stateDir);
    const deadline = Date.now() + this.lockTimeoutMs;
    let lock;
    let identity;
    while (!lock) {
      checkAbort(signal);
      try {
        lock = await open(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
        identity = await lock.stat();
        await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        await lock.sync();
      } catch (error) {
        if (lock) { await lock.close(); await unlink(this.lockPath).catch(() => {}); throw new SiwcAuthError('AUTH_STATE_UNAVAILABLE'); }
        if (error.code !== 'EEXIST') throw new SiwcAuthError('AUTH_STATE_UNAVAILABLE');
        if (Date.now() >= deadline) throw new SiwcAuthError('AUTH_LOCK_BUSY');
        try { await delay(50, undefined, { signal }); } catch { throw new SiwcAuthError('ABORTED'); }
      }
    }
    try { return await action(); }
    finally {
      await lock.close();
      // Never delete a different process's lock. Stale locks fail closed; stop all
      // app/helper processes before manually removing an abandoned lock file.
      try {
        const current = await lstat(this.lockPath);
        if (current.ino === identity.ino && current.dev === identity.dev) await unlink(this.lockPath);
      } catch {}
    }
  }

  async _hostId() {
    const saved = await readProtectedJson(this.hostPath);
    if (saved !== null) {
      if (!isObject(saved) || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved.ext_agent_host_id)) throw new SiwcAuthError('AUTH_STATE_INVALID');
      return saved.ext_agent_host_id;
    }
    const hostId = `urn:uuid:${randomUUID()}`;
    await atomicJson(this.hostPath, { ext_agent_host_id: hostId });
    return hostId;
  }

  async _fetchJson(url, { signal, method = 'GET', body } = {}) {
    checkAbort(signal);
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method, redirect: 'error',
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        ...(body ? { body } : {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch { throw new SiwcAuthError(signal?.aborted ? 'ABORTED' : timeout.aborted ? 'AUTH_TIMEOUT' : 'AUTH_NETWORK_ERROR'); }
    let data;
    try { data = await jsonResponse(response); }
    catch (error) {
      if (signal?.aborted) throw new SiwcAuthError('ABORTED');
      if (timeout.aborted) throw new SiwcAuthError('AUTH_TIMEOUT');
      if (!response.ok) throw new SiwcAuthError('AUTH_REQUEST_REJECTED', { status: response.status });
      throw error;
    }
    if (!response.ok) throw new SiwcAuthError('AUTH_REQUEST_REJECTED', {
      status: response.status,
      oauthCode: typeof data.error === 'string' ? data.error : data.error?.code,
      requestId: response.headers.get('openai-request-id') ?? response.headers.get('x-request-id'),
    });
    return data;
  }

  async _keys(signal, force = false) {
    if (!force && this.jwksCache && this.jwksCache.until > this.now()) return this.jwksCache.value;
    const value = await this._fetchJson(SIWC.jwks, { signal });
    if (!Array.isArray(value.keys) || !value.keys.length || value.keys.length > 100) throw new SiwcAuthError('AUTH_RESPONSE_INVALID');
    this.jwksCache = { value, until: this.now() + 60 * 60 * 1000 };
    return value;
  }

  async _identity(token, { clientId, nonce, subject, signal }) {
    const options = { clientId, nonce, subject, now: this.now() };
    try { return verifyIdToken(token, { ...options, jwks: await this._keys(signal) }); }
    catch (error) {
      if (error.code !== 'AUTH_JWKS_KEY_MISSING') throw error;
      return verifyIdToken(token, { ...options, jwks: await this._keys(signal, true) });
    }
  }

  async _tokenRecord(data, { clientId, prior = null, nonce, signal, refresh = false }) {
    let scopes;
    if (data.scope === undefined && refresh) scopes = prior.scopes;
    else if (typeof data.scope === 'string' && data.scope.length <= 2048 && /^[\x20-\x7E]*$/.test(data.scope)) scopes = [...new Set(data.scope.split(/ +/).filter(Boolean))];
    else throw new SiwcAuthError('AUTH_RESPONSE_INVALID');
    let identity;
    if (data.id_token !== undefined) {
      identity = await this._identity(data.id_token, { clientId, nonce, subject: prior?.subject ?? undefined, signal });
    } else if (!refresh || !prior?.subject) throw new SiwcAuthError('AUTH_RESPONSE_INVALID');
    else identity = { sub: prior.subject, email: prior.email };
    const hasAccess = data.access_token !== undefined;
    if ((scopes.includes('chatgpt.tokens.use.direct') && !hasAccess)
      || (hasAccess && (!safeString(data.access_token) || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' || !Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400))
      || (data.refresh_token !== undefined && !safeString(data.refresh_token))
      || ((refresh || scopes.includes('offline_access')) && hasAccess && !safeString(data.refresh_token))) throw new SiwcAuthError('AUTH_RESPONSE_INVALID');
    const record = {
      version: 1, issuer: SIWC.issuer, client_id: clientId, subject: identity.sub,
      ...(safeString(identity.email, 320) ? { email: identity.email } : {}),
      scopes, saved_at: new Date(this.now()).toISOString(), expires_at: hasAccess ? this.now() + data.expires_in * 1000 : null,
      ...(hasAccess ? { access_token: data.access_token, token_type: 'Bearer' } : {}),
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
      ...(data.id_token ?? prior?.id_token ? { id_token: data.id_token ?? prior.id_token } : {}),
    };
    // The docs do not specify units/type; retain this field without guessing.
    if (['string', 'number'].includes(typeof data.earliest_refresh_at)) record.earliest_refresh_at = data.earliest_refresh_at;
    return validateRecord(record);
  }

  async getAccessToken({ signal } = {}) {
    return this._locked(async () => {
      const record = validateRecord(await readProtectedJson(this.credentialsPath));
      if (!record?.subject) throw new SiwcAuthError('AUTH_REQUIRED');
      if (!record.scopes.includes('chatgpt.tokens.use.direct')) throw new SiwcAuthError('PLAN_PERMISSION_REQUIRED');
      if (!record.access_token) throw new SiwcAuthError('AUTH_REQUIRED');
      if (record.expires_at > this.now() + 60_000 || (!record.refresh_token && record.expires_at > this.now())) return record.access_token;
      if (!record.refresh_token) throw new SiwcAuthError('AUTH_REQUIRED');
      let data;
      try {
        data = await this._fetchJson(SIWC.token, { signal, method: 'POST', body: new URLSearchParams({
          grant_type: 'refresh_token', client_id: record.client_id, refresh_token: record.refresh_token, resource: SIWC.resource,
        }) });
      } catch (error) {
        if (TERMINAL_REFRESH_ERRORS.has(error.oauthCode)) {
          const cleared = { version: 1, issuer: record.issuer, client_id: record.client_id, subject: record.subject, ...(record.email ? { email: record.email } : {}), scopes: [], expires_at: null };
          await atomicJson(this.credentialsPath, cleared);
          throw new SiwcAuthError('AUTH_REQUIRED', { status: error.status, oauthCode: error.oauthCode, requestId: error.requestId });
        }
        throw error;
      }
      const renewed = await this._tokenRecord(data, { clientId: record.client_id, prior: record, signal, refresh: true });
      await atomicJson(this.credentialsPath, renewed);
      if (!renewed.scopes.includes('chatgpt.tokens.use.direct')) throw new SiwcAuthError('PLAN_PERMISSION_REQUIRED');
      return renewed.access_token;
    }, signal);
  }

  async beginAuthorization({ port = 1455, onAuthorizationUrl, signal, timeoutMs = 10 * 60 * 1000 } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof onAuthorizationUrl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60 * 1000) throw new SiwcAuthError('AUTH_CONFIGURATION_INVALID');
    return this._locked(async () => {
      const prior = validateRecord(await readProtectedJson(this.credentialsPath));
      const hostId = await this._hostId();
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(64).toString('base64url');
      let redirectUri;
      let server;
      let timer;
      let abortListener;
      let used = false;
      let rejectCallback;
      const callback = new Promise((resolve, reject) => {
        rejectCallback = reject;
        server = createServer((request, response) => {
          response.setHeader('cache-control', 'no-store');
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.setHeader('referrer-policy', 'no-referrer');
          if (request.method !== 'GET' || request.headers.host !== new URL(redirectUri).host) { response.writeHead(400); response.end('Invalid callback.'); return; }
          if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//')) { response.writeHead(400); response.end('Invalid callback.'); return; }
          let url;
          try { url = new URL(request.url, redirectUri); }
          catch { response.writeHead(400); response.end('Invalid callback.'); return; }
          if (url.pathname !== '/auth/callback') { response.writeHead(404); response.end('Not found.'); return; }
          if (used) { response.writeHead(409); response.end('Sign-in attempt already used.'); return; }
          const states = url.searchParams.getAll('state');
          if (states.length !== 1 || !equalSecret(states[0], state)) {
            response.writeHead(400); response.end('Sign-in could not be verified.'); return;
          }
          used = true;
          if (url.searchParams.has('error')) {
            response.writeHead(400); response.end('Sign-in was not completed.'); reject(new SiwcAuthError('AUTH_DENIED')); return;
          }
          const codes = url.searchParams.getAll('code');
          const clients = url.searchParams.getAll('client_id');
          const clientId = clients[0] ?? prior?.client_id;
          if (codes.length !== 1 || !safeString(codes[0], 8192) || clients.length > 1 || !clientIdValid(clientId) || (prior?.client_id && clientId !== prior.client_id)) {
            response.writeHead(400); response.end('Sign-in response is incomplete.'); reject(new SiwcAuthError('AUTH_CALLBACK_INVALID')); return;
          }
          response.writeHead(200); response.end('Sign-in callback received. Return to the terminal.');
          resolve({ code: codes[0], clientId });
        });
      });
      // Attach a handler before publishing the URL to avoid an unhandled rejection
      // if the browser returns while an async URL callback is still completing.
      callback.catch(() => {});
      try {
        await new Promise((resolve, reject) => {
          server.once('error', () => reject(new SiwcAuthError('AUTH_LISTENER_UNAVAILABLE')));
          server.listen(port, '127.0.0.1', resolve);
        });
        redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
        const authorization = new URL(SIWC.authorize);
        authorization.search = new URLSearchParams({
          client_id: prior?.client_id ?? 'dynamic_agent_client',
          ...(!prior ? { agent_name_hint: SIWC.appName } : {}),
          ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri, scope: SIWC.scopes,
          resource: SIWC.resource, state, nonce, code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        }).toString();
        // ID-token/login hints are optional. Deliberately omit retained ID tokens
        // because the CLI displays this URL and must never print credentials.
        timer = setTimeout(() => rejectCallback(new SiwcAuthError('AUTH_TIMEOUT')), timeoutMs);
        abortListener = () => rejectCallback(new SiwcAuthError('ABORTED'));
        signal?.addEventListener('abort', abortListener, { once: true });
        checkAbort(signal);
        await onAuthorizationUrl(authorization.toString());
        const { code, clientId } = await callback;
        clearTimeout(timer);
        const mapping = prior ?? { version: 1, issuer: SIWC.issuer, client_id: clientId, subject: null, scopes: [], expires_at: null };
        // The callback state has been verified. Retain new registration even if
        // code exchange fails, without activating any unverified identity.
        if (!prior) await atomicJson(this.credentialsPath, mapping);
        const data = await this._fetchJson(SIWC.token, { signal, method: 'POST', body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: SIWC.resource,
        }) });
        const record = await this._tokenRecord(data, { clientId, prior: mapping, nonce, signal });
        await atomicJson(this.credentialsPath, record);
        return publicStatus(record, this.now());
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortListener);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }, signal);
  }
}
