import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { SiwcAuthClient, SIWC, verifyIdToken } from '../src/siwc-auth.mjs';

// All tokens, accounts and fetch responses below are synthetic. The only HTTP
// traffic is to an ephemeral 127.0.0.1 callback listener created by each test.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const jwks = { keys: [jwk] };
const clock = 1_800_000_000_000;
const clientId = 'oaiapp_fixture';
const defaults = { iss: SIWC.issuer, sub: 'fixture-user', aud: clientId, iat: clock / 1000 - 10, exp: clock / 1000 + 3600, nonce: 'nonce-fixture', email: 'fixture@example.test' };
function jwt(overrides = {}, header = {}) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT', ...header })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...defaults, ...overrides })).toString('base64url');
  const input = `${head}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
function tokens(nonce, overrides = {}) {
  return { access_token: 'fixture-access-only', refresh_token: 'fixture-refresh-only', id_token: jwt({ nonce }), token_type: 'Bearer', expires_in: 3600, scope: SIWC.scopes, ...overrides };
}
const verify = (token, options = {}) => verifyIdToken(token, { jwks, clientId, nonce: 'nonce-fixture', now: clock, ...options });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
async function directory(t) {
  const value = await mkdtemp(path.join(tmpdir(), 'siwc-auth-fixture-'));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}
async function recordAt(stateDir, overrides = {}) {
  const value = { version: 1, issuer: SIWC.issuer, client_id: clientId, subject: defaults.sub, email: defaults.email,
    scopes: SIWC.scopes.split(' '), access_token: 'fixture-old-access', refresh_token: 'fixture-old-refresh',
    id_token: jwt(), token_type: 'Bearer', expires_at: clock - 1, saved_at: new Date(clock - 3600000).toISOString(), ...overrides };
  await writeFile(path.join(stateDir, 'credentials.json'), JSON.stringify(value), { mode: 0o600 });
  return value;
}
async function callbackFor(authorization, changes = {}) {
  const parsed = new URL(authorization);
  const callback = new URL(parsed.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: parsed.searchParams.get('state'), code: 'fixture-code', client_id: clientId, ...changes });
  return fetch(callback);
}

test('RS256 identity verification checks issuer, nonce, subject, audience and authorized party', () => {
  assert.equal(verify(jwt()).sub, defaults.sub);
  assert.equal(verify(jwt({ aud: [clientId, 'other-audience'], azp: clientId })).sub, defaults.sub);
  for (const invalid of [{ iss: 'https://wrong.example' }, { nonce: 'wrong' }, { sub: '' }, { aud: 'wrong' },
    { aud: [clientId, 'other-audience'] }, { azp: 'wrong' }, { exp: clock / 1000 - 6 }, { iat: clock / 1000 + 6 },
    { iat: undefined }, { exp: undefined }, { exp: '1800003600' }, { nbf: clock / 1000 + 6 }]) {
    assert.throws(() => verify(jwt(invalid)), { code: 'AUTH_TOKEN_INVALID' });
  }
  assert.throws(() => verify(jwt(), { subject: 'different-account' }), { code: 'AUTH_TOKEN_INVALID' });
});

test('JWT verifier rejects forged, ambiguous and incompatible keys and algorithms', () => {
  const token = jwt();
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...defaults, sub: 'forged' })).toString('base64url');
  assert.throws(() => verify(parts.join('.')), { code: 'AUTH_TOKEN_INVALID' });
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { crit: ['jku'] }, { b64: false }]) {
    assert.throws(() => verify(jwt({}, header)), { code: 'AUTH_TOKEN_ALGORITHM_UNSUPPORTED' });
  }
  assert.throws(() => verify(`${token}=`), { code: 'AUTH_TOKEN_INVALID' });
  assert.throws(() => verify('a.b.c'), { code: 'AUTH_TOKEN_INVALID' });
  assert.throws(() => verify(token, { jwks: { keys: [] } }), { code: 'AUTH_JWKS_KEY_MISSING' });
  for (const keys of [[jwk, jwk], [{ ...jwk, alg: 'PS256' }], [{ ...jwk, use: 'enc' }], [{ ...jwk, key_ops: ['sign'] }], [{ ...jwk, kty: 'oct' }]]) {
    assert.throws(() => verify(token, { jwks: { keys } }), { code: 'AUTH_TOKEN_INVALID' });
  }
});

test('loopback registration enforces public-client contract, PKCE and safe credential output', async (t) => {
  const stateDir = await directory(t);
  const calls = [];
  let authorization;
  const client = new SiwcAuthClient({ stateDir, now: () => clock, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    if (url === SIWC.jwks) return json(jwks);
    assert.equal(url, SIWC.token);
    const form = options.body;
    assert.equal(form.get('client_id'), clientId);
    assert.equal(form.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
    assert.equal(form.get('resource'), SIWC.resource);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.has('client_secret'), false);
    assert.equal(form.has('scope'), false);
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
    return json(tokens(authorization.searchParams.get('nonce')));
  } });
  assert.equal((await client.status()).status, 'auth_required');
  const status = await client.beginAuthorization({ port: 0, onAuthorizationUrl: async (url) => {
    authorization = new URL(url);
    assert.equal(authorization.origin + authorization.pathname, SIWC.authorize);
    assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(authorization.searchParams.get('agent_name_hint'), SIWC.appName);
    assert.match(authorization.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
    assert.equal(authorization.searchParams.get('scope'), SIWC.scopes);
    assert.equal(authorization.searchParams.get('id_token_hint'), null);
    const response = await callbackFor(url);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes('fixture-access'), false);
  } });
  assert.equal(status.status, 'ready');
  assert.equal(status.verified, false);
  assert.equal(JSON.stringify(status).includes('fixture-access'), false);
  assert.equal(JSON.stringify(status).includes('fixture-refresh'), false);
  assert.deepEqual(calls, [SIWC.token, SIWC.jwks]);
  const saved = JSON.parse(await readFile(path.join(stateDir, 'credentials.json')));
  assert.equal(saved.client_id, clientId);
  assert.equal(saved.subject, defaults.sub);
  assert.equal(saved.access_token, 'fixture-access-only');
  assert.equal((await stat(path.join(stateDir, 'credentials.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal(await client.getAccessToken(), 'fixture-access-only');
  assert.equal(calls.length, 2);
});

test('invalid callback states, missing clients, changed clients and denial never exchange a code', async (t) => {
  for (const [changes, expected, returning] of [
    [{ client_id: '' }, 'AUTH_CALLBACK_INVALID', false],
    [{ client_id: 'dynamic_agent_client' }, 'AUTH_CALLBACK_INVALID', false],
    [{ client_id: 'oaiapp_changed' }, 'AUTH_CALLBACK_INVALID', true],
    [{ error: 'access_denied' }, 'AUTH_DENIED', false],
  ]) {
    const stateDir = await directory(t);
    if (returning) await recordAt(stateDir);
    const client = new SiwcAuthClient({ stateDir, fetchImpl: async () => { assert.fail('Network exchange must not occur'); } });
    await assert.rejects(client.beginAuthorization({ port: 0, onAuthorizationUrl: async (url) => { await callbackFor(url, changes); } }), { code: expected });
  }
});

test('callback timeout and cancellation fail closed', async (t) => {
  const stateDir = await directory(t);
  const client = new SiwcAuthClient({ stateDir, fetchImpl: async () => assert.fail('No network request expected') });
  await assert.rejects(client.beginAuthorization({ port: 0, timeoutMs: 20, onAuthorizationUrl: () => {} }), { code: 'AUTH_TIMEOUT' });
  const controller = new AbortController();
  await assert.rejects(client.beginAuthorization({ port: 0, signal: controller.signal, onAuthorizationUrl: () => controller.abort() }), { code: 'ABORTED' });
});

test('malformed callbacks and invalid states do not crash or consume pending sign-in', async (t) => {
  const stateDir = await directory(t);
  let nonce;
  let calls = 0;
  const client = new SiwcAuthClient({ stateDir, now: () => clock, fetchImpl: async (url) => { calls++; return url === SIWC.jwks ? json(jwks) : json(tokens(nonce)); } });
  const status = await client.beginAuthorization({ port: 0, onAuthorizationUrl: async (url) => {
    const parsed = new URL(url);
    nonce = parsed.searchParams.get('nonce');
    const callback = new URL(parsed.searchParams.get('redirect_uri'));
    const malformedStatus = await new Promise((resolve, reject) => {
      const req = request({ hostname: callback.hostname, port: callback.port, path: '//[', method: 'GET' }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(malformedStatus, 400);
    assert.equal((await callbackFor(url, { state: 'wrong-state' })).status, 400);
    callback.search = new URLSearchParams({ state: parsed.searchParams.get('state'), code: 'fixture-code', client_id: clientId });
    callback.searchParams.append('state', parsed.searchParams.get('state'));
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(calls, 0);
    assert.equal((await callbackFor(url)).status, 200);
  } });
  assert.equal(status.status, 'ready');
});

test('new issued client survives failed exchange; reauthorization uses same host and client', async (t) => {
  const stateDir = await directory(t);
  let host;
  let attempt = 0;
  const client = new SiwcAuthClient({ stateDir, fetchImpl: async () => json({ error: 'invalid_grant', error_description: 'SECRET MUST NOT ESCAPE' }, 400) });
  const run = () => client.beginAuthorization({ port: 0, onAuthorizationUrl: async (url) => {
    const parameters = new URL(url).searchParams;
    if (attempt++ === 0) host = parameters.get('ext_agent_host_id');
    else {
      assert.equal(parameters.get('client_id'), clientId);
      assert.equal(parameters.get('agent_name_hint'), null);
      assert.equal(parameters.get('ext_agent_host_id'), host);
    }
    await callbackFor(url);
  } });
  for (let i = 0; i < 2; i++) await assert.rejects(run(), (error) => error.code === 'AUTH_REQUEST_REJECTED' && error.oauthCode === 'invalid_grant' && !JSON.stringify(error).includes('SECRET'));
  const saved = JSON.parse(await readFile(path.join(stateDir, 'credentials.json')));
  assert.equal(saved.client_id, clientId);
  assert.equal(saved.subject, null);
  assert.equal((await client.status()).status, 'auth_required');
});

test('valid identity without direct permission is saved but cannot supply inference credentials', async (t) => {
  const stateDir = await directory(t);
  let nonce;
  const client = new SiwcAuthClient({ stateDir, now: () => clock, fetchImpl: async (url) => url === SIWC.jwks ? json(jwks) : json({ id_token: jwt({ nonce }), scope: 'openid profile email' }) });
  const status = await client.beginAuthorization({ port: 0, onAuthorizationUrl: async (url) => { nonce = new URL(url).searchParams.get('nonce'); await callbackFor(url); } });
  assert.equal(status.status, 'blocked');
  assert.equal(status.detail, 'plan_permission_required');
  await assert.rejects(client.getAccessToken(), { code: 'PLAN_PERMISSION_REQUIRED' });
});

test('reauthorization rejects a different verified subject and keeps original credentials', async (t) => {
  const stateDir = await directory(t);
  const original = await recordAt(stateDir);
  let nonce;
  const client = new SiwcAuthClient({ stateDir, now: () => clock, fetchImpl: async (url) => url === SIWC.jwks ? json(jwks) : json(tokens(nonce, { id_token: jwt({ nonce, sub: 'other-user' }) })) });
  await assert.rejects(client.beginAuthorization({ port: 0, onAuthorizationUrl: async (url) => { nonce = new URL(url).searchParams.get('nonce'); await callbackFor(url); } }), { code: 'AUTH_TOKEN_INVALID' });
  assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, 'credentials.json'))), original);
});

test('refresh serializes separate clients, rotates credentials and retains scopes when omitted', async (t) => {
  const stateDir = await directory(t);
  await recordAt(stateDir);
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, SIWC.token);
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    assert.equal(options.body.get('client_id'), clientId);
    assert.equal(options.body.get('resource'), SIWC.resource);
    assert.equal(options.body.get('refresh_token'), 'fixture-old-refresh');
    assert.equal(options.body.has('scope'), false);
    await new Promise((resolve) => setTimeout(resolve, 70));
    return json({ access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh', token_type: 'Bearer', expires_in: 3600 });
  };
  const options = { stateDir, now: () => clock, fetchImpl };
  assert.deepEqual(await Promise.all([new SiwcAuthClient(options).getAccessToken(), new SiwcAuthClient(options).getAccessToken()]), ['fixture-new-access', 'fixture-new-access']);
  assert.equal(calls, 1);
  const saved = JSON.parse(await readFile(path.join(stateDir, 'credentials.json')));
  assert.equal(saved.refresh_token, 'fixture-new-refresh');
  assert.equal(saved.id_token, jwt());
  assert.equal(saved.expires_at, clock + 3600000);
});

test('refresh lock also serializes distinct Node processes', async (t) => {
  const stateDir = await directory(t);
  await recordAt(stateDir);
  const moduleUrl = new URL('../src/siwc-auth.mjs', import.meta.url).href;
  const program = `import {SiwcAuthClient} from ${JSON.stringify(moduleUrl)};
    import {appendFile} from 'node:fs/promises';
    const client = new SiwcAuthClient({stateDir:process.argv[1],now:()=>${clock},fetchImpl:async()=>{
      await appendFile(process.argv[1]+'/fixture-calls.txt','refresh\\n');
      await new Promise(r=>setTimeout(r,100));
      return new Response(JSON.stringify({access_token:'fixture-process-access',refresh_token:'fixture-process-refresh',token_type:'Bearer',expires_in:3600}));
    }}); await client.getAccessToken();`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, stateDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (data) => { errors += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  });
  await Promise.all([run(), run()]);
  assert.equal(await readFile(path.join(stateDir, 'fixture-calls.txt'), 'utf8'), 'refresh\n');
});

test('terminal refresh clears credentials, temporary errors preserve them, errors omit secrets', async (t) => {
  for (const [oauthCode, status, terminal] of [['invalid_grant', 400, true], ['refresh_token_reused', 400, true], ['server_error', 503, false]]) {
    const stateDir = await directory(t);
    const original = await recordAt(stateDir);
    const client = new SiwcAuthClient({ stateDir, now: () => clock, fetchImpl: async () => json({ error: oauthCode, error_description: 'fixture-old-refresh SECRET' }, status) });
    await assert.rejects(client.getAccessToken(), (error) => error.oauthCode === oauthCode && !JSON.stringify(error).includes('SECRET') && !error.message.includes('fixture-old-refresh'));
    const saved = JSON.parse(await readFile(path.join(stateDir, 'credentials.json')));
    if (terminal) {
      assert.equal(saved.refresh_token, undefined);
      assert.equal(saved.id_token, undefined);
      assert.equal(saved.client_id, clientId);
      assert.equal((await client.status()).status, 'auth_required');
    } else assert.deepEqual(saved, original);
  }
});

test('invalid refresh response cannot overwrite a saved credential set', async (t) => {
  const stateDir = await directory(t);
  const original = await recordAt(stateDir);
  const client = new SiwcAuthClient({ stateDir, now: () => clock, fetchImpl: async () => json({ access_token: 'fixture-new-access', token_type: 'Bearer', expires_in: 3600 }) });
  await assert.rejects(client.getAccessToken(), { code: 'AUTH_RESPONSE_INVALID' });
  assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, 'credentials.json'))), original);
});

test('JWKS refreshes for an unknown key identifier before accepting a verified token', async (t) => {
  const stateDir = await directory(t);
  let nonce;
  let keyRequests = 0;
  const client = new SiwcAuthClient({ stateDir, now: () => clock, fetchImpl: async (url) => {
    if (url === SIWC.jwks) return json({ keys: [keyRequests++ ? jwk : { ...jwk, kid: 'old-key' }] });
    return json(tokens(nonce));
  } });
  assert.equal((await client.beginAuthorization({ port: 0, onAuthorizationUrl: async (url) => { nonce = new URL(url).searchParams.get('nonce'); await callbackFor(url); } })).status, 'ready');
  assert.equal(keyRequests, 2);
});

test('unsafe files and symlinks are rejected, abandoned lock fails closed', async (t) => {
  const stateDir = await directory(t);
  await recordAt(stateDir);
  const client = new SiwcAuthClient({ stateDir, now: () => clock, lockTimeoutMs: 50, fetchImpl: async () => assert.fail('No external request expected') });
  await chmod(path.join(stateDir, 'credentials.json'), 0o644);
  await assert.rejects(client.status(), { code: 'AUTH_STATE_UNSAFE' });
  await chmod(path.join(stateDir, 'credentials.json'), 0o600);
  await writeFile(path.join(stateDir, 'credentials.lock'), '{}', { mode: 0o600 });
  await assert.rejects(client.getAccessToken(), { code: 'AUTH_LOCK_BUSY' });
  const linked = path.join(await directory(t), 'linked');
  await symlink(stateDir, linked);
  await assert.rejects(new SiwcAuthClient({ stateDir: linked }).status(), { code: 'AUTH_STATE_UNSAFE' });
});

test('aborted requests make no provider calls and network errors remain sanitized', async (t) => {
  const stateDir = await directory(t);
  await recordAt(stateDir);
  let calls = 0;
  const client = new SiwcAuthClient({ stateDir, now: () => clock, fetchImpl: async () => { calls++; throw new Error('fixture-old-refresh SECRET'); } });
  await assert.rejects(client.getAccessToken({ signal: AbortSignal.abort() }), { code: 'ABORTED' });
  assert.equal(calls, 0);
  await assert.rejects(client.getAccessToken(), (error) => error.code === 'AUTH_NETWORK_ERROR' && !JSON.stringify(error).includes('SECRET'));
});
