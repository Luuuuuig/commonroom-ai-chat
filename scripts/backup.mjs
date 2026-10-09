import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { dataDirectory } from '../src/runtime.mjs';

try {
  const argument = process.argv[2];
  if (!argument || !isAbsolute(argument)) throw new Error('Supply a new absolute backup filename.');
  const destination = resolve(argument);
  if (existsSync(destination)) throw new Error('Backup destination exists. Choose a new filename.');
  const source = join(dataDirectory(), 'chat.sqlite');
  if (!existsSync(source)) throw new Error('No chat database exists yet.');
  process.umask(0o077);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, destination); } finally { db.close(); }
  chmodSync(destination, 0o600);
  const check = new DatabaseSync(destination, { readOnly: true });
  try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed.'); } finally { check.close(); }
  console.log('Consistent database backup created and integrity checked. Store it privately. Credentials are excluded.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
