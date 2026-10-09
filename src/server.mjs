import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { Engine } from './orchestrator.mjs';
import { createAdapters } from './providers.mjs';
import { signSession, verifyPassword, verifySession } from './auth.mjs';
import { acquireLock, dataDirectory } from './runtime.mjs';

const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw fail(415, 'CONTENT_TYPE', 'Send JSON.');
  let total = 0; const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 4 * 1024 * 1024) throw fail(413, 'BODY_LIMIT', 'The request exceeds 4 MB.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch { throw fail(400, 'INVALID_JSON', 'Send a JSON object.'); }
}

/** HTTP boundary. No credential, shell-command, provider-endpoint, or billing controls are exposed. */
export function createApplication({ engine, adapters, mode = 'mock', passwordHash, sessionSecret, publicOrigin, trustedProxy = false }) {
  if (!passwordHash || !sessionSecret || sessionSecret.length < 32) throw new Error('Run npm run setup first.');
  if (!['mock', 'subscription'].includes(mode)) throw new Error('Unsupported mode. Paid model APIs are disabled.');
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN must be an exact HTTP(S) origin.');
  if (publicOrigin && !['http:', 'https:'].includes(new URL(publicOrigin).protocol)) throw new Error('Use an HTTP(S) origin.');
  if (trustedProxy && !publicOrigin?.startsWith('https://')) throw new Error('Trusted proxy mode requires a configured HTTPS origin.');
  let draining; let closing = false;
  const kick = () => {
    if (closing || draining) return;
    draining = engine.drain().catch(() => console.error('worker_error: inspect authenticated run status'))
      .finally(() => { draining = undefined; });
  };
  const loginAttempts = new Map();
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  const server = createServer(async (request, response) => {
    for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    try {
      const origin = publicOrigin || `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url, origin);
      // The local container probe has a loopback Host. This endpoint exposes no account or run data.
      if (request.method === 'GET' && url.pathname === '/healthz') return send(200, { status: 'ok' });
      if (request.headers.host !== new URL(origin).host) throw fail(403, 'HOST_MISMATCH', 'Use the configured application address.');
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site')
          throw fail(403, 'ORIGIN_MISMATCH', 'Open this app directly before making changes.');
      }
      if (request.method === 'GET' && ['/', '/index.html', '/app.mjs', '/styles.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript';
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        response.end(readFileSync(join(publicDirectory, name))); return;
      }
      const secure = origin.startsWith('https://') ? '; Secure' : '';
      if (request.method === 'POST' && url.pathname === '/api/login') {
        // Enabled only on the unexposed app service behind our Caddy instance.
        // Caddy overwrites this header. Never trust forwarded headers by default.
        const client = request.headers['x-private-client-ip'];
        if (trustedProxy && (typeof client !== 'string' || !isIP(client))) throw fail(403, 'PROXY_REQUIRED', 'Use the configured private HTTPS endpoint.');
        const address = trustedProxy ? client : request.socket.remoteAddress || 'unknown';
        const now = Date.now();
        for (const [key, value] of loginAttempts) if (value.until < now) loginAttempts.delete(key);
        if (loginAttempts.size >= 10000 && !loginAttempts.has(address)) throw fail(429, 'LOGIN_LIMIT', 'Wait before trying again.');
        const attempt = loginAttempts.get(address) || { count: 0, until: now + 5 * 60_000 };
        if (attempt.count >= 5) throw fail(429, 'LOGIN_LIMIT', 'Wait five minutes before trying again.');
        attempt.count++; loginAttempts.set(address, attempt);
        const { password } = await readBody(request);
        if (!verifyPassword(password, passwordHash)) throw fail(401, 'LOGIN_FAILED', 'Password not accepted.');
        loginAttempts.delete(address);
        response.setHeader('Set-Cookie', `group_session=${signSession(sessionSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
        return send(200, { ok: true });
      }
      if (!verifySession(request.headers.cookie, sessionSecret)) throw fail(401, 'AUTH_REQUIRED', 'Sign in to your private group chat.');
      if (request.method === 'POST' && url.pathname === '/api/logout') {
        response.setHeader('Set-Cookie', `group_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
        return send(200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const connections = [];
        for (const [id, adapter] of Object.entries(adapters)) {
          let health;
          try { health = await adapter.health(); } catch { health = { status: 'blocked', detail: 'Provider health could not be verified.' }; }
          connections.push({ id, name: id === 'codex' ? 'OpenAI via intended SIWC / Codex' : 'Claude via Claude Code', ...health });
        }
        return send(200, { conversations: engine.listConversations(), connections, mode, paidApisEnabled: false, liveIntegrationVerified: false });
      }
      if (request.method === 'POST' && url.pathname === '/api/conversations') return send(201, engine.createConversation((await readBody(request)).title || 'New conversation'));
      if (request.method === 'POST' && url.pathname === '/api/submit') {
        const result = engine.submit(await readBody(request)); kick(); return send(202, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/context-preview') {
        const data = await readBody(request); return send(200, engine.previewContext(data.conversationId, data.text));
      }
      if (request.method === 'POST' && url.pathname === '/api/import') return send(201, engine.importConversation((await readBody(request)).data));
      const conversation = /^\/api\/conversations\/([\w-]+)(?:\/(context|export))?$/.exec(url.pathname);
      if (conversation) {
        const [, id, action] = conversation;
        if (request.method === 'GET' && !action) return send(200, engine.snapshot(id));
        if (request.method === 'GET' && action === 'export') {
          response.setHeader('Content-Disposition', `attachment; filename="conversation-${id}.json"`);
          return send(200, engine.exportConversation(id));
        }
        if (request.method === 'PUT' && action === 'context') return send(200, engine.setContext(id, await readBody(request)));
      }
      const job = /^\/api\/jobs\/([\w-]+)\/(cancel|retry)$/.exec(url.pathname);
      if (job && request.method === 'POST') {
        const body = await readBody(request);
        const result = job[2] === 'cancel' ? engine.cancel(job[1]) : engine.retry(job[1], body);
        kick(); return send(200, result);
      }
      const message = /^\/api\/messages\/([\w-]+)\/review$/.exec(url.pathname);
      if (message && request.method === 'POST') { const result = engine.manualReview(message[1], await readBody(request)); kick(); return send(202, result); }
      throw fail(404, 'NOT_FOUND', 'That page or operation is unavailable.');
    } catch (error) {
      const safe = error.status || error.name === 'AppError';
      const status = error.status || (error.code === 'NOT_FOUND' ? 404 : safe ? 400 : 500);
      if (!response.headersSent) send(status, { error: { code: safe ? error.code : 'INTERNAL_ERROR', message: safe ? error.message : 'Operation failed. Your saved messages remain available.' } });
      else response.end();
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  const timer = setInterval(kick, 1000); timer.unref();
  return { server, kick, async stop() { closing = true; clearInterval(timer); await new Promise(resolve => server.close(resolve)); if (draining) await draining; } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let release;
  try {
    process.umask(0o077);
    const directory = dataDirectory();
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
    if ((statSync(join(directory, 'config.json')).mode & 0o077) !== 0) throw new Error('Restrict data/config.json permissions to 0600.');
    // Live activation is a release gate, not an environment-variable override.
    const mode = process.env.APP_MODE || 'mock';
    if (mode !== 'mock') throw new Error('Live mode remains blocked until OpenAI route eligibility and both account proofs pass. No paid API fallback exists.');
    release = acquireLock(directory);
    const adapters = createAdapters({ mode });
    const engine = new Engine({ dbPath: join(directory, 'chat.sqlite'), adapters });
    engine.recover();
    const app = createApplication({ engine, adapters, mode, ...config, publicOrigin: process.env.PUBLIC_ORIGIN, trustedProxy: process.env.TRUST_PROXY === '1' });
    const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
    if (host !== '127.0.0.1' && !process.env.PUBLIC_ORIGIN) throw new Error('Set PUBLIC_ORIGIN before accepting non-local connections.');
    app.server.listen(port, host, () => { console.log('Group chat ready. MOCK providers only; separately billed model APIs disabled.'); app.kick(); });
    app.server.on('error', () => { console.error('Server could not listen. Check host and port.'); release(); process.exitCode = 1; });
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.stop(); engine.close(); release(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { release?.(); console.error(error.code === 'ENOENT' ? 'Run npm run setup before starting the app.' : error.message); process.exitCode = 1; }
}
