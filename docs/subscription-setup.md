# Subscription setup and proof

The selected open-source, self-hosted route has verified public source. Native sign-in, account entitlement and actual billing remain separate checks. Nothing in this guide enables a paid API fallback.

## Choose the proof runtime

The current implementation is tested on Linux with Node.js 24. For a no-cost account proof, use an existing Linux machine or a suitable WSL 2 environment with the native Linux Claude Code client. Keep source and private data on its Linux filesystem, not a Windows-mounted folder. Native Windows execution is unverified: the settings checks depend on POSIX file permissions, and CLI isolation/cancellation use Linux-oriented behavior.

This development workspace has no Claude client and its permitted network destinations exclude the provider authentication and inference endpoints. A separate cloud browser cannot receive the helper's `127.0.0.1` callback on behalf of this runtime. Complete the supported sign-in where the helper runs, using a browser that can reach that loopback listener. Do not forward tokens or callback URLs through chat.

A local account proof is optional and does not satisfy cloud availability. The project can proceed directly to a cloud VM for the proof and later service, after hosting access and expenditure approval. OpenAI's documented VM procedure still requires supported local sign-in and secure credential transfer; this is a setup/reauthorization step, not a dependency on a personal computer during normal operation. The transfer remains a separately verified setup step.

## 1. Verify account spend controls

The generic MIT source is public at [commonroom-ai-chat](https://github.com/Luuuuuig/commonroom-ai-chat), verified at commit `62406e41a0d4f52a61ab4a85ce53b278c5fcf875`. Publication evidence is recorded in `docs/release.json`. The proof runner still requires supported sign-in and explicit account spend verification before model calls.

In each provider's own account settings, confirm that paid extra usage, automatic credit purchases and usage-billed fallbacks are off. The application cannot infer these account-level settings merely from successful OAuth. Existing plan usage is shared with your other activity.

Create a private `DATA_DIR/provider-settings.json` file, mode `0600`, with these non-secret settings after verification:

```json
{
  "subscriptionOnlyConfirmed": true,
  "openaiModel": null,
  "claudePath": "/absolute/path/to/claude",
  "claudeStateDir": "/absolute/private/provider-state/claude"
}
```

Do not add any API key or account token to this settings file. A null model selects the first visible model returned by the account-specific catalog. Discovery does not prove entitlement; a completed response does.

## 2. OpenAI sign-in on the computer running the browser

Run `npm run connect:openai` locally with the same source. Follow the printed official authorization URL. The callback listens only on `127.0.0.1` and is not an endpoint on the deployed web server. Complete the provider's account selection and plan-usage consent yourself. Do not send credentials or callback URLs through chat.

The helper uses PKCE, state, nonce, signature verification and required-scope checks. It stores credentials outside source under the selected data directory. It performs no inference. The initial implementation accepts RS256 ID tokens only and rejects other algorithms rather than silently skipping signature verification. Actual provider compatibility is not yet tested.

Credential refresh uses an exclusive lock. An interrupted process can leave `credentials.lock`; the helper then reports `AUTH_LOCK_BUSY` instead of risking reuse of a rotating refresh token. Wait for active work to finish. If the lock is abandoned, stop every app, proof runner and sign-in helper using that state directory before removing only that lock file. Never remove it while another process is running. This manual recovery limitation remains in the current release.

For a remote VM, follow the official [self-hosted VM procedure](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms): prepare a separate VM host ID, transfer the selected protected registration through SSH, preserve the VM host ID, and let that VM own later token refreshes. Do not run two independent copies of the same refresh token concurrently. The exact transfer/import command will be completed and verified with the chosen host; no remote transfer has occurred.

## 3. Claude native login

Install an unmodified, version-pinned Claude Code client after checking its official installation instructions. The prepared adapter requires at least 2.1.268 and checks the required flags. This is a minimum capability check, not a claim that this version has been installed or tested.

Use a dedicated OS account/state directory. Run the provider's native login with `HOME` and `CLAUDE_CONFIG_DIR` matching the adapter's dedicated `stateDir/home` and `stateDir/claude` locations. Complete the native account flow yourself. Do not copy the developer's existing credentials, browser cookies or ordinary workstation profile.

The adapter checks `claude auth status`, requiring native `claude.ai` authentication and its expected config directory. It rejects API-key, third-party and helper auth routes. It disables built-in and MCP tools for these text-only proofs and does not use `--bare`, which skips subscription OAuth.

## 4. Run the smallest real proof

Stop the mock web server first, because the proof runner takes the single-worker lock. Use an environment without API keys, billing-provider overrides or proxy credentials. Once both supported sign-ins are complete:

```bash
npm run prove:subscriptions -- --confirm-subscription-limits-only
```

The runner uses synthetic facts, tries both provider orders, corrects a fact, restarts its database connection and sends a follow-up. It saves output in the private data directory. Inspect exact answer/review text and native usage information before treating this as accepted. Failed or ambiguous attempts are retained and are never automatically resent.

The web server still defaults to mocks. Enable the live web workflow only after this proof, account funding verification and an explicit reviewed configuration change. Then complete the deployment, restart, backup and timed computer-off tests from the original acceptance plan.

## Sources

Official pages checked 9 October 2026: [OpenAI registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [Claude authentication](https://code.claude.com/docs/en/authentication), and [programmatic execution](https://code.claude.com/docs/en/headless).
