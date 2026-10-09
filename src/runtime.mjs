import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const dataDirectory = () => resolve(process.env.DATA_DIR || './data');
export function acquireLock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A dedicated SQLite file provides an OS-held cross-process lock. Kernel locks
  // release on crashes; there are no stale PID files or racy unlink takeovers.
  // Use a local persistent disk, never a network filesystem with weak locking.
  const db = new DatabaseSync(join(directory, 'worker-lock.sqlite'));
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch { db.close(); throw new Error('Another worker or restore is active. Stop it before continuing.'); }
  let closed = false;
  return () => { if (!closed) { closed = true; db.exec('ROLLBACK'); db.close(); } };
}
