import { readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SiwcAuthClient } from './siwc-auth.mjs';
import { OpenAIPlanAdapter } from './siwc-provider.mjs';
import { ClaudeCliAdapter, ProviderError } from './providers.mjs';

/** Only the explicit account-proof runner uses this factory until Phase 1 passes. */
export function createSubscriptionAdapters({ directory, release, settings, env = process.env }) {
  if (release?.sourcePublished !== true || typeof release.repositoryUrl !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(release.repositoryUrl))
    throw new ProviderError('policy_unverified');
  if (settings?.subscriptionOnlyConfirmed !== true) throw new ProviderError('spend_controls_unverified');
  const authClient = new SiwcAuthClient({ stateDir: join(resolve(directory), 'providers', 'openai') });
  return {
    codex: new OpenAIPlanAdapter({ authClient, model: settings.openaiModel || undefined,
      releasePublished: true, subscriptionOnlyConfirmed: true, env }),
    claude: new ClaudeCliAdapter({ claudePath: settings.claudePath, stateDir: settings.claudeStateDir,
      subscriptionOnlyConfirmed: true, env }),
  };
}

export function readProviderSettings(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new ProviderError('private_settings_required');
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new ProviderError('invalid_provider_settings'); }
}
