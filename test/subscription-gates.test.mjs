import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSubscriptionAdapters, readProviderSettings } from '../src/subscription-adapters.mjs';

test('subscription factory requires published source and explicit account spend verification', () => {
  assert.throws(() => createSubscriptionAdapters({directory:tmpdir(), release:{sourcePublished:false},settings:{}}), error => error.code === 'POLICY_UNVERIFIED');
  assert.throws(() => createSubscriptionAdapters({directory:tmpdir(), release:{sourcePublished:'false',repositoryUrl:'https://github.com/example/test'},settings:{subscriptionOnlyConfirmed:true}}), error => error.code === 'POLICY_UNVERIFIED');
  assert.throws(() => createSubscriptionAdapters({directory:tmpdir(), release:{sourcePublished:true,repositoryUrl:'https://github.com/example/test'},settings:{subscriptionOnlyConfirmed:'true'}}), error => error.code === 'CONFIGURATION_ERROR');
});

test('provider settings reject permissive file modes', () => {
  const dir=mkdtempSync(join(tmpdir(),'group-settings-test-'));
  try {
    const file=join(dir,'settings.json');writeFileSync(file,'{"subscriptionOnlyConfirmed":false}',{mode:0o600});
    assert.equal(readProviderSettings(file).subscriptionOnlyConfirmed,false);
    chmodSync(file,0o644);
    assert.throws(()=>readProviderSettings(file),error=>error.code==='CONFIGURATION_ERROR');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('real proof runner cannot accidentally start without its explicit command acknowledgement', () => {
  const result=spawnSync(process.execPath,[resolve('scripts/prove-subscriptions.mjs')],{encoding:'utf8'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/verify paid extra usage/);
  assert.equal(result.stdout,'');
});
