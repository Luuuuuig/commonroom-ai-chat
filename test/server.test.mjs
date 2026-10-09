import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Engine } from '../src/orchestrator.mjs';
import { createAdapters } from '../src/providers.mjs';
import { createApplication } from '../src/server.mjs';
import { hashPassword, verifyPassword, signSession, verifySession } from '../src/auth.mjs';

test('private login, origin guard, automatic mock review, context and export through HTTP', async t => {
  const adapters = createAdapters({ mode: 'mock' });
  const engine = new Engine({ dbPath: ':memory:', adapters });
  const password = randomBytes(24).toString('hex');
  const app = createApplication({ engine, adapters, passwordHash: hashPassword(password), sessionSecret: randomBytes(32).toString('hex') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stop(); engine.close(); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = (path, data, method = data ? 'POST' : 'GET', overrides = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...overrides },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/api/login', { password }, 'POST', { Origin: 'https://hostile.invalid' })).status, 403);
  const login = await call('/api/login', { password });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const state = await (await call('/api/state')).json();
  assert.equal(state.mode, 'mock'); assert.equal(state.paidApisEnabled, false);
  assert.equal(state.liveIntegrationVerified, false);
  const conversation = await (await call('/api/conversations', { title: 'HTTP proof' })).json();
  assert.ok(conversation.id);
  const input = { conversationId: conversation.id, text: '@Claude check the agreed number', autoReview: true, requestKey: randomUUID() };
  const submission = await (await call('/api/submit', input)).json();
  assert.ok(submission.job.id);
  await engine.drain();
  const snapshot = await (await call(`/api/conversations/${conversation.id}`)).json();
  assert.equal(snapshot.messages.length, 3);
  assert.equal(snapshot.messages[1].provider, 'claude');
  assert.equal(snapshot.messages[2].provider, 'codex');
  assert.equal(snapshot.messages[2].kind, 'review');
  assert.equal((await (await call('/api/submit', input)).json()).duplicate, true);
  assert.equal((await call(`/api/conversations/${conversation.id}/context`, { text: 'The corrected number is 14.', sources: ['user decision'] }, 'PUT')).status, 200);
  const preview = await (await call('/api/context-preview', { conversationId: conversation.id, text: 'Repeat it' })).json();
  assert.match(preview.prompt, /corrected number is 14/);
  const exported = await (await call(`/api/conversations/${conversation.id}/export`)).json();
  const restored = await (await call('/api/import', { data: exported })).json();
  assert.equal(restored.messages.length, 3);
  assert.equal(restored.context.text, 'The corrected number is 14.');
  const home = await call('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await call('/api/logout', {})).status, 200);
});

test('password hashes and signed sessions reject tampering and expiry', () => {
  const hash = hashPassword('test-only-long-password');
  assert.equal(verifyPassword('test-only-long-password', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.throws(() => hashPassword('short'));
  const secret = randomBytes(32).toString('hex'), now = Date.now();
  const session = signSession(secret, now);
  assert.equal(verifySession(`group_session=${session}`, secret, now), true);
  assert.equal(verifySession(`group_session=${session.slice(0, -4)}oops`, secret, now), false);
  assert.equal(verifySession(`group_session=${session}`, secret, now + 13 * 60 * 60_000), false);
});

test('private proxy health and rate limits use only explicitly trusted client addresses', async t => {
  const adapters = createAdapters({ mode: 'mock' });
  const engine = new Engine({ dbPath: ':memory:', adapters });
  const app = createApplication({ engine, adapters, passwordHash: hashPassword('test-private-long-password'), sessionSecret: randomBytes(32).toString('hex'), publicOrigin: 'https://chat.example.test', trustedProxy: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stop(); engine.close(); });
  const local = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(local + '/healthz')).status, 200);
  assert.equal((await fetch(local + '/api/state')).status, 403);
  const login = ip => new Promise((resolve, reject) => {
    const req = httpRequest(local + '/api/login', { method: 'POST', headers: {
      Host: 'chat.example.test', Origin: 'https://chat.example.test', 'Content-Type':'application/json', ...(ip ? {'X-Private-Client-IP':ip} : {}),
    } }, response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode })); });
    req.on('error', reject); req.end(JSON.stringify({password:'wrong'}));
  });
  assert.equal((await login()).status, 403);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await login('192.0.2.10')).status, 401);
  assert.equal((await login('192.0.2.10')).status, 429);
  assert.equal((await login('192.0.2.20')).status, 401);
});
