import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Small synchronous persistence boundary. All provider work happens outside transactions. */
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, imported_from TEXT
      );
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        version INTEGER NOT NULL, text TEXT NOT NULL, sources_json TEXT NOT NULL,
        created_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(conversation_id, version)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        status TEXT NOT NULL, kind TEXT NOT NULL, stage TEXT NOT NULL,
        primary_provider TEXT NOT NULL, review_provider TEXT NOT NULL,
        user_message_id TEXT, primary_message_id TEXT, review_message_id TEXT, revision_message_id TEXT,
        auto_review INTEGER NOT NULL, auto_revision INTEGER NOT NULL,
        error_json TEXT, prompts_json TEXT NOT NULL DEFAULT '{}', attempts_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id), task_id TEXT,
        role TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, text TEXT NOT NULL,
        reply_to TEXT, created_at TEXT NOT NULL, provider_session_ref TEXT,
        provider_mode TEXT, model TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
        job_id TEXT, stage TEXT, UNIQUE(job_id, stage)
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS imports (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        original_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,seq);
      CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,seq);
      CREATE INDEX IF NOT EXISTS context_versions ON contexts(conversation_id,version);
    `);
  }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
