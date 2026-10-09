# Commonroom AI Group Chat

Implementation checkpoint, 9 October 2026. **This is a working local application foundation with MOCK responses. It is not a completed ChatGPT and Claude integration.**

The app implements a private chat, automatic answer-to-review routing, durable SQLite history and jobs, selected shared context, and recovery controls. Mock responses explicitly identify themselves as deterministic fixtures. They do not perform useful model generation or factual peer review.

Separately billed model APIs are disabled. The selected route uses published MIT source with private self-hosting, Sign in with ChatGPT (SIWC), and native Claude Code subscription login. Source publication is verified; both account proofs remain pending. The web server refuses live mode. No infrastructure has been purchased or deployed.

## Phase status

| Phase | Current result |
| --- | --- |
| 0, feasibility | Documentation, route selection and source publication passed. Account eligibility remains unverified. |
| 1, real provider proof | Blocked. No accounts connected and no real model requests sent. |
| 2, chat and orchestration | Implemented and tested with mocks. Real-provider acceptance remains blocked. |
| 3, shared context | Persistence, versions, selected text import and export tested locally. Model understanding remains untested. |
| 4, cloud operation | Docker/Caddy configuration prepared. Build, HTTPS, hosting and computer-off test untested. |
| 5, handover | Source and test evidence available. End-to-end product acceptance remains blocked. |

## Run the local mock application

Use Node.js 24 on Linux, macOS, or a suitable WSL environment. The app has no third-party npm dependencies. Keep its data on a local filesystem with working SQLite file locks.

```bash
npm run setup
npm start
```

Setup asks for a private app password of at least 16 characters. Open **http://127.0.0.1:3000**, sign in, create a conversation, and send a request beginning with `@ChatGPT` or `@Claude`. The default is an OpenAI mock answer followed by a Claude mock review. You can change the selected participant, turn off automatic review, or enable one final revision.

Use the exact `127.0.0.1` address. The app checks its configured origin and host. Optional environment variables are documented in `.env.example`. Node does not load that example automatically. Never add provider secrets or API keys.

The shared-context panel stores selected facts and preferences. File import accepts text or Markdown as inert selected context with source references. It does not synchronize either provider's website. Export downloads a versioned conversation record. Import creates a new room and retains original records; unfinished imported work is paused.

```bash
npm test
npm run proof
npm run backup -- /absolute/private-backups/chat-2026-10-09.sqlite
# Stop the app before restore.
npm run restore -- /absolute/private-backups/chat-2026-10-09.sqlite
```

`npm run proof` overwrites `docs/mock-proof.json` with a new mock transcript. Tests use isolated temporary databases, local OAuth callback listeners, and injected HTTP/CLI fixtures. No test uses a real model account or contacts a provider.

## Provider implementation

| Component | What actually exists |
| --- | --- |
| `MockAdapter` | Deterministic local responses labeled MOCK, with no network or model usage. |
| `ClaudeCliAdapter` | CLI subprocess and parser implementation. Fixture-tested, never tested against an installed native CLI or real account. Requires isolated native subscription sign-in and explicit confirmation that paid extra usage is disabled. |
| `OpenAIBlockedAdapter` | A deliberate blocker, not a working OpenAI adapter. Reports `POLICY_UNVERIFIED`. |
| `SiwcAuthClient` and sign-in helper | Loopback OAuth, PKCE, state/nonce, RS256 ID-token verification, protected credential storage and serialized refresh. Fixture-tested; no real sign-in. Other signing algorithms fail closed. |
| `OpenAIPlanAdapter` | OAuth-only model discovery and Responses streaming. Fixture-tested; no real inference or verified funding. |
| Subscription proof runner | Prepared for both answer/review orders and a corrected-context follow-up. Requires verified source publication, account spend controls and supported sign-in. Has never made a live call. |

OpenAI's current docs distinguish hosted applications using Sign in with ChatGPT from built-in app-server authentication. We have not used a different command to evade that distinction. See [feasibility](docs/feasibility.md).

The guarded Claude adapter disables tools and MCP, uses a strict child-process environment, rejects API authentication, limits output and duration, and requires a successful terminal result. The OpenAI adapter uses fixed public endpoints and accepts only a completed response. Neither retries automatically or falls back to an API key. The whole web server remains mock-only. Changing an environment variable cannot silently activate live inference. See [subscription setup](docs/subscription-setup.md) for the separate, gated account-proof procedure.

## Reliability behavior

- One worker processes bounded tasks in order. One request normally yields one answer and one review.
- Mentions in assistant text and attachments do not start tasks.
- Idempotency keys suppress duplicate submissions. Explicit retries reuse the failed stage and retain successful messages.
- A process restart marks an in-flight call ambiguous. Restoring an older backup marks every unfinished job ambiguous.
- Ambiguous work requires a deliberate retry. No background retry or paid fallback activates.
- Context and prompts retain versions. The app rejects oversized context rather than silently dropping corrections.
- Model review sees the exact final answer and explicit evidence, not hidden reasoning or unreported tool activity.

The generic MIT source is public at [commonroom-ai-chat](https://github.com/Luuuuuig/commonroom-ai-chat). Verified source commit `62406e41a0d4f52a61ab4a85ce53b278c5fcf875` matches all 48 reviewed files. Runtime data, credentials and private project material remain private. The public repository uses sanitized initial history.

## Documentation

- [Feasibility and primary sources](docs/feasibility.md)
- [Feature parity](docs/feature-parity.md)
- [Costs](docs/costs.md)
- [Decisions](docs/decisions.md)
- [Integration proof and limitations](docs/integration-proof.md)
- [Subscription setup and proof](docs/subscription-setup.md)
- [Acceptance results](docs/acceptance-results.md)
- [Operations](docs/operations.md)
- [Next steps](docs/next-steps.md)

No screenshot or recording of a real exchange exists because neither real provider has run. HTTP integration and syntax checks do not establish browser visual quality. No browser visual test was performed in this environment.
