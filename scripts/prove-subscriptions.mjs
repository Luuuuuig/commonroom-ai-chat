import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/orchestrator.mjs';
import { createSubscriptionAdapters, readProviderSettings } from '../src/subscription-adapters.mjs';
import { acquireLock, dataDirectory } from '../src/runtime.mjs';

let engine, unlock;
try {
  if (!process.argv.includes('--confirm-subscription-limits-only')) throw new Error('First verify paid extra usage and auto-purchases are off in both native accounts. Then rerun with --confirm-subscription-limits-only.');
  process.umask(0o077);
  const directory = dataDirectory();
  const release = JSON.parse(readFileSync(new URL('../docs/release.json', import.meta.url), 'utf8'));
  if (release.sourcePublished !== true) throw new Error('Source publication has not been verified. This proof will not start model calls.');
  const settings = readProviderSettings(join(directory, 'provider-settings.json'));
  const adapters = createSubscriptionAdapters({ directory, release, settings });
  unlock = acquireLock(directory);
  for (const [name, adapter] of Object.entries(adapters)) {
    const health = await adapter.health();
    if (health.status !== 'ready') throw new Error(`${name}: ${health.code || health.status}. Complete its supported account setup first.`);
  }
  const proofDirectory = join(directory, 'proof');
  mkdirSync(proofDirectory, { recursive: true, mode: 0o700 });
  const runId = randomUUID(), started = new Date().toISOString();
  const dbPath = join(proofDirectory, `live-${runId}.sqlite`);
  engine = new Engine({ dbPath, adapters });
  const conversation = engine.createConversation('Synthetic subscription proof');
  engine.setContext(conversation.id, {text:'Synthetic test facts only: project Cedar, agreed count 8. Do not use tools or external services.',sources:['Synthetic proof runner']});
  const submit = async text => {
    const {job} = engine.submit({conversationId:conversation.id,text,requestKey:randomUUID()});
    await engine.drain();
    const completed = engine.getJob(job.id);
    if (completed.status !== 'completed') throw new Error(`Proof paused at ${completed.stage}: ${completed.error?.code || completed.status}. Inspect the private proof database before retrying.`);
  };
  await submit('@ChatGPT state the agreed project name and count in one short sentence.');
  await submit('@Claude check the earlier exchange and state the agreed count.');
  engine.setContext(conversation.id,{text:'Correction: project Cedar now has agreed count 14. This supersedes 8. Do not use tools or external services.',sources:['Synthetic corrected fact']});
  engine.close(); engine = new Engine({dbPath,adapters});
  await submit('@ChatGPT use the corrected count and explain what changed in one sentence.');
  const exportData=engine.exportConversation(conversation.id);
  // Saved locally because provider output is untrusted and requires redaction review.
  const evidence={type:'REAL SUBSCRIPTION RUN: review before publishing',runId,startedAt:started,completedAt:new Date().toISOString(),runtime:process.version,sourceRepository:release.repositoryUrl,
    transport:{openai:'SIWC OAuth Responses',claude:'unmodified Claude Code'},accountBillingCheckedByOwner:true,
    semanticAcceptance:'Needs human inspection of exact answers, reviews and corrected fact. No automatic success claim.',conversation:exportData};
  writeFileSync(join(proofDirectory,`live-${runId}.json`),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Both provider orders and a follow-up completed. Inspect private proof evidence for factual correctness and billing verification. Cloud availability is not established by this run.');
} catch(error) {
  // Only our controlled errors reach stdout; provider diagnostics remain private.
  console.error(error.name === 'ProviderError' || error.name === 'SiwcAuthError' ? `Proof blocked: ${error.code}.` : error.code === 'ENOENT' ? 'Proof setup is incomplete. Follow docs/subscription-setup.md.' : error.message);
  process.exitCode=1;
} finally { engine?.close(); unlock?.(); }
