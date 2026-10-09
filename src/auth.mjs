import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024)
    throw new Error('Choose a password between 16 and 1024 characters.');
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
export function verifyPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const [algorithm, salt, digest] = String(hash).split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(digest)) return false;
  return timingSafeEqual(scryptSync(password, salt, 32), Buffer.from(digest, 'hex'));
}
export function signSession(secret, now = Date.now()) {
  const data = Buffer.from(JSON.stringify({ expires: now + 12 * 60 * 60 * 1000, id: randomBytes(16).toString('hex') })).toString('base64url');
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}
export function verifySession(cookie, secret, now = Date.now()) {
  try {
    const token = /(?:^|;\s*)group_session=([^;]+)/.exec(cookie || '')?.[1];
    if (!token || token.length > 400) return false;
    const [data, signature, extra] = token.split('.');
    const expected = createHmac('sha256', secret).update(data).digest();
    const supplied = Buffer.from(signature || '', 'base64url');
    if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString());
    return Number.isFinite(parsed.expires) && parsed.expires > now && parsed.expires <= now + 12 * 60 * 60 * 1000;
  } catch { return false; }
}
