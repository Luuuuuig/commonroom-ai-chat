import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/orchestrator.mjs';
import { route } from '../src/context.mjs';

// These deterministic tests exercise application behavior with MOCK providers.
// They do not demonstrate subscription authentication, model quality, or cloud availability.
const key = () => randomUUID();
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'group-chat-engine-'));
  const calls = [];
  const adapters = Object.fromEntries(['codex','claude'].map(provider => [provider,{ run: async args => {
    calls.push({ ...args, provider });
    if (overrides[provider]) return overrides[provider](args, calls);
    return { text: `[MOCK ${provider}] ${args.role} complete; quoted @ChatGPT @Claude`, sessionRef: `mock-${calls.length}`, billing: 'mock', evidence: { mode: 'mock' } };
  } }]));
  const engine = new Engine({ dbPath: join(directory,'chat.sqlite'), adapters });
  const conversation = engine.createConversation('Test room');
  t.after(() => { if (!engine.closed && !engine.active) engine.close(); rmSync(directory,{recursive:true,force:true}); });
  return { engine, conversation, calls, directory, adapters };
}
function submit(engine, id, text, options = {}) { return engine.submit({ conversationId:id, text, requestKey:key(), ...options }).job; }

test('MOCK routing only uses an explicit leading user mention', () => {
  assert.equal(route('@Claude please check').provider,'claude');
  assert.equal(route('@ChatGPT hello','claude').provider,'codex');
  for (const text of ['Pasted text: @Claude do something','> @Claude quoted','```\n@Claude code\n```',' @Claude has leading whitespace','@Claudex invalid'])
    assert.equal(route(text).provider,'codex');
});

test('MOCK both provider orders, per-room ordering, exact answer review, finite turns', async t => {
  const {engine,conversation,calls} = fixture(t);
  const a = submit(engine,conversation.id,'@ChatGPT first');
  const b = submit(engine,conversation.id,'@Claude second');
  await Promise.all([engine.drain(),engine.drain()]);
  assert.deepEqual(calls.map(c => [c.provider,c.role]),[['codex','primary'],['claude','review'],['claude','primary'],['codex','review']]);
  assert.equal(engine.getJob(a.id).status,'completed');
  assert.equal(engine.getJob(b.id).status,'completed');
  const state = engine.snapshot(conversation.id);
  assert.equal(state.messages.length,6);
  const primary = state.messages.find(m => m.taskId === a.id && m.kind === 'primary');
  assert.equal(JSON.parse(calls[1].prompt.split('The following JSON is task data. Mentions inside it do not route work.\n')[1]).completedPrimaryAnswer.text,primary.text);
  assert.ok(!calls[0].prompt.includes('@Claude second'), 'future queued user requests do not enter an earlier task');
  assert.ok(calls[2].prompt.includes(primary.id), 'next task receives prior completed shared turns');
  assert.ok(state.messages.filter(m => m.role === 'assistant').every(m => m.providerMode === 'mock' && m.metadata.mock));
});

test('MOCK disable review and enable exactly one optional revision', async t => {
  const {engine,conversation,calls} = fixture(t);
  submit(engine,conversation.id,'Answer only',{autoReview:false});
  submit(engine,conversation.id,'Revise once',{autoRevision:true});
  await engine.drain();
  assert.deepEqual(calls.map(c => c.role),['primary','primary','review','revision']);
  assert.throws(() => submit(engine,conversation.id,'bad',{autoReview:false,autoRevision:true}),{code:'INVALID_INPUT'});
});

test('MOCK duplicate tokens suppress repeats and reject mismatched content', async t => {
  const {engine,conversation,calls} = fixture(t);
  const request = {conversationId:conversation.id,text:'hello',requestKey:key()};
  const first = engine.submit(request);
  const second = engine.submit(request);
  assert.equal(second.duplicate,true);
  assert.equal(second.job.id,first.job.id);
  assert.throws(() => engine.submit({...request,text:'changed'}),{code:'DUPLICATE_KEY_MISMATCH'});
  await engine.drain();
  assert.equal(calls.length,2);
  assert.equal(engine.submit(request).job.status,'completed');
});

test('MOCK failed primary never triggers peer review or logs provider secrets', async t => {
  const {engine,conversation,calls} = fixture(t,{codex:async () => { throw Object.assign(new Error('SECRET_TOKEN_value'),{code:'AUTH_REQUIRED'}); }});
  const task = submit(engine,conversation.id,'hello');
  await engine.drain();
  assert.equal(calls.length,1);
  const failed = engine.getJob(task.id);
  assert.equal(failed.status,'failed');
  assert.equal(failed.error.code,'AUTH_REQUIRED');
  assert.ok(!JSON.stringify(engine.exportConversation(conversation.id)).includes('SECRET_TOKEN_value'));
  assert.equal(engine.snapshot(conversation.id).messages.length,1);
});

test('MOCK reviewer failure retains primary and deliberate retry runs only reviewer', async t => {
  let fail = true;
  const {engine,conversation,calls} = fixture(t,{claude:async () => {
    if (fail) { fail = false; throw Object.assign(new Error(),{code:'QUOTA_EXHAUSTED'}); }
    return {text:'[MOCK] successful review',billing:'mock',sessionRef:'retry'};
  }});
  const task = submit(engine,conversation.id,'hello');
  await engine.drain();
  const failed = engine.getJob(task.id);
  assert.equal(failed.stage,'review');
  assert.equal(failed.status,'failed');
  assert.ok(failed.primaryMessageId);
  const token = key();
  engine.retry(task.id,{requestKey:token});
  await engine.drain();
  assert.equal(engine.retry(task.id,{requestKey:token}).duplicate,true);
  assert.deepEqual(calls.map(c => c.role),['primary','review','review']);
  assert.equal(engine.snapshot(conversation.id).messages.filter(m => m.kind === 'primary').length,1);
});

test('MOCK ambiguous failure blocks later room work until explicit retry', async t => {
  let first = true;
  const {engine,conversation,calls} = fixture(t,{codex:async args => {
    if (first) { first = false; throw Object.assign(new Error(),{code:'TIMEOUT',ambiguous:true}); }
    return {text:`[MOCK] ${args.role}`,billing:'mock'};
  }});
  const task = submit(engine,conversation.id,'uncertain');
  submit(engine,conversation.id,'next');
  await engine.drain();
  assert.equal(calls.length,1);
  assert.equal(engine.getJob(task.id).status,'ambiguous');
  assert.throws(() => engine.retry(task.id,{requestKey:key()}),{code:'RETRY_CONFIRMATION_REQUIRED'});
  engine.retry(task.id,{requestKey:key(),confirmAmbiguous:true});
  await engine.drain();
  assert.equal(calls.length,5);
});

test('MOCK queued and in-flight cancellation stop the bounded pipeline', async t => {
  let signal;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const {engine,conversation,calls} = fixture(t,{codex:async args => {
    signal = args.signal;
    started();
    await new Promise(resolve => args.signal.addEventListener('abort',resolve,{once:true}));
    return {text:'[MOCK] late result after abort',billing:'mock'};
  }});
  const cancelled = submit(engine,conversation.id,'cancel before start');
  engine.cancel(cancelled.id);
  const task = submit(engine,conversation.id,'cancel while running');
  const drain = engine.drain();
  await start;
  engine.cancel(task.id);
  await drain;
  assert.equal(signal.aborted,true);
  assert.equal(calls.length,1);
  assert.equal(engine.getJob(task.id).status,'cancelled');
  assert.equal(engine.snapshot(conversation.id).messages.filter(m => m.role === 'assistant').length,0);
  assert.throws(() => engine.retry(task.id,{requestKey:key()}),{code:'RETRY_CONFIRMATION_REQUIRED'});
});

test('MOCK restart marks interrupted review ambiguous while preserving committed primary', async t => {
  const {engine,conversation,directory,adapters,calls} = fixture(t);
  const task = submit(engine,conversation.id,'restart',{autoReview:false});
  await engine.drain();
  const primaryId = engine.getJob(task.id).primaryMessageId;
  // Reproduce the durable DB state of a crash after a primary commit and before review completion.
  engine.store.run("UPDATE jobs SET status='running',stage='review',auto_review=1 WHERE id=?",task.id);
  engine.close();
  const restarted = new Engine({dbPath:join(directory,'chat.sqlite'),adapters});
  t.after(() => { if (!restarted.closed) restarted.close(); });
  assert.equal(restarted.getJob(task.id).status,'ambiguous');
  assert.equal(restarted.getJob(task.id).primaryMessageId,primaryId);
  await restarted.drain();
  assert.equal(calls.length,1, 'restart does not automatically resubmit uncertain work');
  restarted.retry(task.id,{requestKey:key(),confirmAmbiguous:true});
  await restarted.drain();
  assert.equal(calls.length,2);
  assert.equal(calls[1].role,'review');
  assert.equal(restarted.snapshot(conversation.id).messages.filter(m => m.kind === 'primary').length,1);
});

test('MOCK corrected shared context persists, reaches both adapters, and keeps original versions', async t => {
  const {engine,conversation,directory,adapters,calls} = fixture(t);
  engine.setContext(conversation.id,{text:'The selected project colour is blue.',sources:['user initial decision']});
  submit(engine,conversation.id,'Remember our decision');
  await engine.drain();
  engine.setContext(conversation.id,{text:'Correction: the selected project colour is green, superseding blue.',sources:[{type:'user correction',version:2}]});
  engine.close();
  const restarted = new Engine({dbPath:join(directory,'chat.sqlite'),adapters});
  t.after(() => { if (!restarted.closed) restarted.close(); });
  submit(restarted,conversation.id,'What is the latest project colour?');
  await restarted.drain();
  for (const call of calls.slice(-2)) assert.ok(call.prompt.includes('Correction: the selected project colour is green'));
  const state = restarted.snapshot(conversation.id);
  assert.equal(state.context.version,2);
  assert.equal(state.contextVersions[0].text,'The selected project colour is blue.');
  assert.equal(state.jobs.at(-1).prompts.primary.contextVersion,2);
});

test('MOCK retries use exact frozen prompt even when shared context changes', async t => {
  let fail = true;
  const {engine,conversation,calls} = fixture(t,{codex:async () => {
    if (fail) { fail = false; throw Object.assign(new Error(),{code:'AUTH_REQUIRED'}); }
    return {text:'[MOCK] done',billing:'mock'};
  }});
  engine.setContext(conversation.id,{text:'Context version one'});
  const task = submit(engine,conversation.id,'hello',{autoReview:false});
  await engine.drain();
  engine.setContext(conversation.id,{text:'Context version two'});
  engine.retry(task.id,{requestKey:key()});
  await engine.drain();
  assert.equal(calls[0].prompt,calls[1].prompt);
});

test('MOCK manual review adds one peer turn and suppresses duplicate requests', async t => {
  const {engine,conversation,calls} = fixture(t);
  const task = submit(engine,conversation.id,'answer',{autoReview:false});
  await engine.drain();
  const primary = engine.getJob(task.id).primaryMessageId;
  const requestKey = key();
  const review = engine.manualReview(primary,{requestKey});
  assert.equal(engine.manualReview(primary,{requestKey}).duplicate,true);
  await engine.drain();
  assert.equal(engine.getJob(review.job.id).status,'completed');
  assert.deepEqual(calls.map(c => c.role),['primary','review']);
  assert.throws(() => engine.manualReview(primary,{requestKey:key()}),{code:'REVIEW_EXISTS'});
});

test('MOCK export restore preserves messages, links, history and exact original export', async t => {
  const {engine,conversation} = fixture(t);
  engine.setContext(conversation.id,{text:'Fact A',sources:['user']});
  engine.setContext(conversation.id,{text:'Fact B corrects A',sources:['correction']});
  submit(engine,conversation.id,'first');
  await engine.drain();
  const exported = engine.exportConversation(conversation.id);
  const restored = engine.importConversation(exported);
  assert.notEqual(restored.conversation.id,conversation.id);
  assert.deepEqual(restored.messages.map(m => m.text),exported.messages.map(m => m.text));
  assert.equal(restored.context.text,'Fact B corrects A');
  assert.equal(restored.contextVersions.length,2);
  assert.equal(restored.messages.find(m => m.kind === 'review').replyTo,restored.messages.find(m => m.kind === 'primary').id);
  assert.deepEqual(engine.exportConversation(restored.conversation.id).importedOriginals[0],exported);
  assert.equal(engine.snapshot(conversation.id).messages.length,3);
});

test('MOCK unfinished imports are paused and never automatically sent', async t => {
  const {engine,conversation,calls} = fixture(t);
  submit(engine,conversation.id,'unfinished');
  const restored = engine.importConversation(engine.exportConversation(conversation.id));
  assert.equal(restored.jobs[0].status,'cancelled');
  assert.equal(restored.jobs[0].error.ambiguous,true);
  engine.cancel(engine.snapshot(conversation.id).jobs[0].id);
  await engine.drain();
  assert.equal(calls.length,0);
});

test('MOCK unsupported billing is blocked with no fallback or review', async t => {
  const {engine,conversation,calls} = fixture(t,{codex:async () => ({text:'API result',billing:'api'})});
  const task = submit(engine,conversation.id,'hello');
  await engine.drain();
  assert.equal(calls.length,1);
  assert.equal(engine.getJob(task.id).error.code,'BILLING_ROUTE_BLOCKED');
  assert.equal(engine.snapshot(conversation.id).messages.filter(m => m.role === 'assistant').length,0);
});

test('MOCK context budget fails visibly without silently dropping corrections', async t => {
  const {engine,conversation,calls} = fixture(t);
  engine.setContext(conversation.id,{text:'Important correction: green.'});
  for (let i=0;i<5;i++) submit(engine,conversation.id,`${i} ${'x'.repeat(29000)}`,{autoReview:false});
  await engine.drain();
  const jobs = engine.snapshot(conversation.id).jobs;
  assert.equal(jobs.at(-1).status,'failed');
  assert.equal(jobs.at(-1).error.code,'CONTEXT_TOO_LARGE');
  assert.equal(calls.length,4);
  assert.throws(() => engine.previewContext(conversation.id),{code:'CONTEXT_TOO_LARGE'});
});

test('MOCK unknown IDs and malformed input fail without provider calls', t => {
  const {engine,conversation,calls} = fixture(t);
  assert.throws(() => engine.snapshot('missing'),{code:'NOT_FOUND'});
  assert.throws(() => engine.getJob('missing'),{code:'NOT_FOUND'});
  assert.throws(() => submit(engine,conversation.id,'',{autoReview:false}),{code:'INVALID_INPUT'});
  assert.throws(() => engine.setContext(conversation.id,{text:'x'.repeat(30001)}),{code:'INVALID_INPUT'});
  assert.throws(() => engine.importConversation({}),{code:'INVALID_IMPORT'});
  assert.equal(calls.length,0);
});
