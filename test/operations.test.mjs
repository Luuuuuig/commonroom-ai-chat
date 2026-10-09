import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/orchestrator.mjs';
import { createAdapters } from '../src/providers.mjs';
import { acquireLock } from '../src/runtime.mjs';

test('setup excludes plaintext, backup is consistent, restore blocks active workers and retains old database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'group-ops-test-'));
  const password = randomUUID() + randomUUID();
  const run = (script, args = [], extra = {}) => spawnSync(process.execPath, [resolve('scripts', script), ...args], {
    env: { ...process.env, DATA_DIR: directory, ...extra }, encoding: 'utf8',
  });
  let engine; let release;
  try {
    const setup = run('setup.mjs', [], { GROUP_CHAT_PASSWORD: password });
    assert.equal(setup.status, 0, setup.stderr);
    const config = readFileSync(join(directory, 'config.json'), 'utf8');
    assert.ok(!config.includes(password));
    assert.equal(statSync(join(directory, 'config.json')).mode & 0o077, 0);
    assert.equal(run('setup.mjs', [], { GROUP_CHAT_PASSWORD: password }).status, 1);
    engine = new Engine({ dbPath: join(directory, 'chat.sqlite'), adapters: createAdapters({ mode: 'mock' }) });
    const room = engine.createConversation('Restore proof');
    engine.setContext(room.id, { text: 'Restored value 14', sources: [] });
    engine.submit({ conversationId: room.id, text: 'Hello', requestKey: randomUUID() }); await engine.drain();
    const pending = engine.submit({ conversationId: room.id, text: 'Queued at backup time', requestKey: randomUUID() });
    const backup = join(directory, 'backup.sqlite');
    const backed = run('backup.mjs', [backup]);
    assert.equal(backed.status, 0, backed.stderr);
    await engine.drain(); // This request completed after the snapshot. Restore must NOT resend it.
    engine.setContext(room.id, { text: 'Changed after backup', sources: [] }); engine.close(); engine = undefined;
    release = acquireLock(directory);
    assert.equal(run('restore.mjs', [backup]).status, 1);
    release(); release = undefined;
    const restored = run('restore.mjs', [backup]);
    assert.equal(restored.status, 0, restored.stderr);
    engine = new Engine({ dbPath: join(directory, 'chat.sqlite'), adapters: createAdapters({ mode: 'mock' }) });
    assert.equal(engine.snapshot(room.id).messages.length, 4);
    assert.equal(engine.snapshot(room.id).context.text, 'Restored value 14');
    assert.equal(engine.getJob(pending.job.id).status, 'ambiguous');
    await engine.drain();
    assert.equal(engine.snapshot(room.id).messages.length, 4);
    assert.ok(readdirSync(directory).some(name => name.startsWith('chat.sqlite.before-restore')));
  } finally { release?.(); engine?.close(); rmSync(directory, { recursive: true, force: true }); }
});
