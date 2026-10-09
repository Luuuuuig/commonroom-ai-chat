import { Engine } from '../src/orchestrator.mjs';
import { createAdapters } from '../src/providers.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'group-chat-proof-'));
const dbPath = join(directory, 'chat.sqlite');
let engine;
try {
  const started = new Date();
  engine = new Engine({ dbPath, adapters: createAdapters({ mode: 'mock' }) });
  const room = engine.createConversation('MOCK acceptance transcript');
  engine.setContext(room.id, { text: 'Agreed project name: Harbor. The selected value is 8.', sources: ['Synthetic test facts. No private user data.'] });
  for (const text of ['@ChatGPT restate the selected value.', '@Claude check the previous discussion.']) {
    engine.submit({ conversationId: room.id, text, requestKey: randomUUID() }); await engine.drain();
  }
  engine.setContext(room.id, { text: 'Correction: the selected value is 14. This supersedes 8. Agreed project name: Harbor.', sources: ['Synthetic correction'] });
  engine.close();
  engine = new Engine({ dbPath, adapters: createAdapters({ mode: 'mock' }) });
  engine.submit({ conversationId: room.id, text: '@ChatGPT use the corrected value.', requestKey: randomUUID() });
  await engine.drain();
  const snapshot = engine.snapshot(room.id);
  const report = {
    evidenceType: 'MOCK ONLY: deterministic fixtures, no intelligent answers or factual peer review',
    startedAt: started.toISOString(), completedAt: new Date().toISOString(), runtime: process.version,
    realProviderCalls: 0, separateModelApiCalls: 0, deploymentTest: 'not run',
    transcript: snapshot.messages,
    jobs: snapshot.jobs.map(j => ({ id: j.id, status: j.status, primaryProvider: j.primaryProvider, reviewProvider: j.reviewProvider, attempts: j.attempts })),
    contextVersions: snapshot.contextVersions,
    correctedContextAfterRestart: snapshot.jobs.at(-1).prompts.primary?.prompt?.includes('selected value is 14') ?? false,
    explanation: 'Prompts, queue state, context delivery and persistence are tested. Model understanding and real collaboration remain blocked.',
  };
  const output = resolve('docs/mock-proof.json');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log('Recorded mock-only transcript and restart evidence in docs/mock-proof.json. Real providers remain untested.');
} finally { engine?.close(); rmSync(directory, { recursive: true, force: true }); }
