import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, renameSync, chmodSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDirectory, acquireLock } from '../src/runtime.mjs';

let release;
try {
  const argument = process.argv[2];
  if (!argument || !isAbsolute(argument)) throw new Error('Supply an absolute backup filename. Stop the app first.');
  const source = resolve(argument), directory = dataDirectory(), target = join(directory, 'chat.sqlite');
  if (source === target) throw new Error('The backup must be a separate file.');
  release = acquireLock(directory);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
    for (const table of ['conversations', 'messages', 'contexts', 'jobs', 'requests', 'imports'])
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('This is not a group chat backup.');
  } finally { db.close(); }
  const temporary = join(directory, `restore-${randomUUID()}.sqlite`);
  copyFileSync(source, temporary); chmodSync(temporary, 0o600);
  const restored = new DatabaseSync(temporary);
  try {
    // The original deployment may have completed work AFTER this backup.
    // Even queued work from an old snapshot is now ambiguous, never auto-send it.
    restored.prepare("UPDATE jobs SET status='ambiguous', error_json=?, updated_at=? WHERE status IN ('queued','running')").run(
      JSON.stringify({ code: 'RESTORE_AMBIGUOUS', message: 'This backup predates current provider state. Check whether this work completed after the backup before deliberately retrying.', ambiguous: true }),
      new Date().toISOString());
    restored.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  } finally { restored.close(); }
  const archiveSuffix = `.before-restore-${Date.now()}`;
  // Preserve the old database together with its journal files for operator recovery.
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(target + suffix)) renameSync(target + suffix, target + archiveSuffix + suffix);
  renameSync(temporary, target);
  console.log('Database restored. Previous data was retained. All unfinished restored jobs require deliberate recovery.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { release?.(); }
