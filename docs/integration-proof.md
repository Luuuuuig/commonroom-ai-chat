# Integration proof

Recorded 9 October 2026. This document distinguishes implemented source, fixture tests, official documentation, and real-account evidence.

## Actual execution environment

- Development runtime observed: Node.js v24.19.0 on Linux.
- Persistence: built-in `node:sqlite`, local SQLite database and exclusive worker lock.
- Application package: 0.2.0, no third-party runtime dependencies.
- Codex CLI: no executable found in this development shell.
- Claude Code CLI: no executable found in this development shell.
- Docker: unavailable. No image build or cloud deployment was attempted.
- Provider accounts authenticated: none.
- Real provider requests: zero.
- Separately billed model API requests: zero.

The credentials belonging to this ChatGPT development session were not reused, copied, or inspected for the application. No native website cookies were extracted.

## What the tests demonstrate

`test/engine.test.mjs` uses mock adapters to check both participant orders, exact answer delivery to the reviewer, finite turns, context correction delivery after restart, failures, cancellation, retries, imports, and idempotency. `docs/mock-proof.json` records a real execution of this mock application with synthetic facts. Its responses are deterministic fixture text.

`test/providers.test.mjs` injects fake child processes and JSON events into the Claude adapter. It verifies arguments, isolation checks, subscription-auth gating, output parsing, cancellation, timeout classification, environment rejection, and no fallback. It does **not** establish that a current installed Claude client accepts every flag or returns these exact fields for this account.

`test/siwc-auth.test.mjs` uses generated fixture signing keys, a local loopback callback listener and injected token responses. It checks OAuth state/nonce/PKCE, signature and identity validation, protected writes, rotating refresh and process concurrency. `test/siwc-provider.test.mjs` uses injected model catalogs and event streams to check publication/spend gates, OAuth-only credentials, strict endpoints, complete output, errors, quota, timeout and cancellation. `test/subscription-gates.test.mjs` verifies that the separate proof runner cannot start without its explicit prerequisites. None of these tests contacts OpenAI or verifies an actual account.

`test/server.test.mjs` exercises a local HTTP server, authentication, origin restrictions, mock submission and review, context, export/import, proxy health, and client-specific rate limits. `test/operations.test.mjs` executes setup, consistent SQLite backup and offline restore against temporary local data.

## Provider evidence ledger

| Item | OpenAI | Claude |
| --- | --- | --- |
| Intended backend | SIWC OAuth, public Responses endpoint | Unmodified Claude Code CLI |
| Implemented live adapter | OAuth helper and streaming adapter written; fixture-tested, gated proof only | Subprocess adapter written; fixture-tested, gated proof only |
| Installed CLI version | Not installed | Not installed |
| Compatibility assumption | Documented SIWC preview; RS256 ID tokens only, no real token observed | 2.1.268 plus required-flag checks; not a tested installed version |
| Actual authentication mode | None | None |
| User tier and entitlement | Unknown | Unknown |
| Billing route proved with user account | No | No |
| Paid extra usage account setting checked | No | No |
| Answer and reverse-order review | Blocked | Blocked |
| Real follow-up context use | Blocked | Blocked |
| Native history or memory connected | No | No |
| Cloud disconnect test | Not run | Not run |

No quota amount is shown because neither provider has supplied real quota data. No API-key fallback, subscription-credit purchase, or account-level spending change exists in the application.

## Publication evidence

The public MIT repository is [commonroom-ai-chat](https://github.com/Luuuuuig/commonroom-ai-chat). Verified source commit `62406e41a0d4f52a61ab4a85ce53b278c5fcf875`, tree `eff2d94af65ee5ae1d7615ac228f6310a985e0b1`, matches all 48 reviewed files. Publication establishes source availability only; account access and live inference remain unverified.

## Required live proof for the selected open-source route

1. Verify the account's eligibility for OSS SIWC using the published source route.
2. Use supported provider login on the approved host. The owner completes sign-in. Store no secrets in transcripts or ordinary logs.
3. Record installed versions, non-sensitive authentication type and eligible plan details, granted scopes where applicable, and verified spending controls. Redact account identifiers.
4. Run a harmless question through OpenAI, then Claude review. Repeat in reverse. Record completed response IDs and observable billing route without copying tokens.
5. Correct a synthetic shared fact, restart the app, and verify both real providers use the correction.
6. Verify quota/login failures pause with no paid fallback. Do not intentionally buy credits to test this.
7. Only then test the private cloud deployment while the personal computer is off and record its actual duration.

Until these are completed, Phase 1 has not passed. Phase 0's documented route selection does not establish account access, and later mock tests cannot override the live-proof gate.
