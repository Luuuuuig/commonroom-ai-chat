# Feasibility assessment

Assessment date: 2026-10-09, Europe/Berlin. Source retrieval date: 2026-10-09.

## Phase 0 result: route selected, publication and account proof pending

The selected route is **Sign in with ChatGPT (SIWC) for an eligible self-hosted application, plus unmodified Claude Code using the user's own subscription login, on a private persistent VM**. This meets Phase 0's documentation and route-selection criteria with official subscription evidence and a plausible cloud path. It does not establish this private application's OpenAI eligibility, either account's entitlement, or a working exchange.

The source-publication option was approved on 9 October 2026. The selected route is generic MIT-licensed source with a private self-hosted deployment. Conversations, credentials, account details and imported project files remain private. Actual public source availability, account entitlement and live operation are still unverified. Adding a license to a private directory is not evidence of publication.

No hosting purchase, public source publication, account sign-in, or live inference is established by this assessment. Phases 1 through 5 remain unaccepted until their real-provider gates pass. The supplied plan expressly permits independent components and clearly labeled mocks to continue during this block.

## Route comparison

| Route | Evidence and cloud path | Account, billing, and interruption boundaries | Decision |
| --- | --- | --- | --- |
| A1. SIWC and native Claude Code on a private VM | OpenAI explicitly documents OSS applications on remote self-hosted VMs. Claude documents subscription login, programmatic `-p`, and conditions for hosted unmodified clients. [O2, O3, A1-A4] | Eligibility and user entitlements require verification. Sign-in and renewal can interrupt work. Usage limits are shared with existing provider use. No API-key fallback. | Selected; live eligibility and behavior unverified. |
| A2. Codex app-server with its built-in ChatGPT authentication | The integration interface exists, but its authentication documentation excludes commercial or hosted services. [O1] | A successful login alone would not clear the deployment restriction. | Not selected for the hosted chat. |
| A3. `codex exec` or Codex SDK with managed ChatGPT credentials | Private CI automation is documented, including a persistent trusted runner and serialized auth use. [O6, O7] | This does not explicitly establish permission for the proposed hosted chat product. | Do not treat changing the executable as a workaround for A2. |
| B. Happy | Maintainer repository offers a CLI wrapper, encrypted relay, mobile/web clients, and newer multi-model runtime claims. MIT license verified. [H1, H2] | An execution machine is still required. Vendor eligibility is separate from the bridge's license. No installation, credential audit, or automatic two-provider review test was performed. | Evaluate further only after provider eligibility is resolved. |
| C1. Dedicated cloud-browser automation | A continuously running browser could technically execute while a laptop is off, but no approved extraction/automation route was established under the providers' consumer terms. [T1, T2] | Session expiry, MFA, login challenges, changing page structure, attachment handling, and completion detection require human recovery and maintenance. | No browser adapter implemented or recommended. |
| C2. Browser extension on the user's computer | Would depend on an active browser and computer. The same provider restrictions remain relevant. [T1, T2] | Does not satisfy operation while the computer is off. Adding a cloud browser changes it into C1. | Reject for the stated availability requirement. |
| D. Separately billed model APIs | Conventional integration alternative, outside the authorized billing scope. | Requires a distinct billing decision. No automatic enablement, credit purchase, or provider switch. | Disabled. Subscription-included API credits are also not silently substituted. |

Hosting, storage, backups, taxes, currency assumptions, and bridge cost scenarios are recorded in [costs.md](costs.md). No additional expenditure is authorized here.

## OpenAI integration boundary

SIWC and Codex app-server's built-in authentication are different routes. SIWC can supply its own OAuth token to an explicitly configured app-server provider. Its endpoint uses the Responses API protocol, but authorized usage draws from the ChatGPT plan or available credits instead of a separately supplied API key. [O4, O5]

The SIWC overview directs paid or remotely hosted applications to an interest form; its separate VM guide explicitly covers self-hosting open-source applications. These establish an OSS candidate, not automatic eligibility for every private hosted application. The quickstart describes selected private clients. [O2, O3, O8]

Qualifying OSS registration uses a per-host identifier, a loopback OAuth flow with PKCE, and a dynamically issued client ID. The implementation must verify the ID token and granted plan-usage scope. Account model discovery is not proof of completed inference. [O9, O5]

Keep API keys and custom inference endpoints disabled. Do not purchase credits or enable account-level extra spending. Show actual authentication and funding information without exposing tokens. Exact quota and account-plan availability remain unverified. No user tier is inferred from chat metadata.

## Claude integration boundary

Anthropic's current support article distinguishes subscription-limit use of `claude -p`/Agent SDK from included monthly API credits. This project selects the native subscription-login candidate, not the separate credits route. [A1]

The client must remain unmodified. The hosted-client guidance imposes agreement and direct-user-authentication conditions. Account sign-in alone does not establish compliance with every deployment condition. [A2]

`claude -p` supports structured output. Do not use `--bare` for this candidate: current documentation says it skips OAuth credentials. Normal print mode can load host/project configuration, so use an isolated controlled workspace and explicitly constrain tools. [A3]

API keys can take precedence over subscription login in noninteractive execution. Reject competing API keys, gateways, cloud-provider credentials, and helper configuration before starting a run. Authentication can expire, requiring provider-native login renewal. Keep credentials in provider-managed protected storage. [A4]

Live login, harmless requests, billing-route verification, and both review directions remain untested. Record those in [integration-proof.md](integration-proof.md), not as documentation-derived successes.

## Existing bridge assessment

Happy's original CLI wraps Codex and Claude Code; its server relays encrypted synchronization. A relay does not provide the machine that executes inference and tools. Its newer desktop/runtime advertises model switching and delegation within a session. Those maintainer claims are not proof of this project's exact automatic answer-and-peer-review behavior. [H1]

The repository's MIT license permits adaptation subject to its notice obligations. It does not grant permission to use provider accounts or credentials beyond provider terms. No Happy code or dependency is incorporated in this release. [H2]

The legacy “How It Works” URL was checked, but the retrieval returned no readable body. Current assessment relies on the repository rather than asserting unobserved legacy implementation details. [H3]

## Browser route assessment

OpenAI's European consumer terms prohibit automated extraction of data/output. Anthropic's consumer terms restrict scraping and automated access except expressly permitted routes. These are reasons to use documented provider interfaces; this review found no exception authorizing a native-website scraping bridge. [T1, T2]

No cookies are extracted, no login challenges bypassed, and no sessions are relayed to unofficial inference endpoints. A cloud-browser implementation would also need measured tests for reauthentication, duplicate submission, upload completion, output truncation, and website changes. Those tests are unperformed, and this route remains unselected.

## Proof required before accepting subsequent phases

1. Verify the authorized generic source publication, then verify the selected account can use the OSS SIWC route.
2. Complete each provider's supported login on a suitable isolated runner. Obtain approval before any new hosting expenditure.
3. Record redacted account/authentication evidence and the actual billing route. Reject unexpected credentials.
4. Run a harmless answer and automatic review in both directions. Require explicit completion, not partial streamed text.
5. Verify shared follow-up context, corrected facts, cancellation, expiry, limits, and no paid fallback.
6. Perform a timed real exchange while the user's computer is off, then verify restart and restore behavior.

Application persistence and mock orchestration can be tested now. Such tests establish application behavior only. They cannot establish provider access, review quality, native feature parity, billing, or cloud availability.

## Primary sources

All retrieved 2026-10-09. Provider documentation may change; recheck the selected interface before enabling live access.

| ID | Source | Relevance |
| --- | --- | --- |
| O1 | [OpenAI: Codex app-server](https://learn.chatgpt.com/docs/app-server), “Auth endpoints” | Hosted-service restriction on built-in authentication. |
| O2 | [OpenAI: SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source) | Eligibility distinction; no native conversation/context access. |
| O3 | [OpenAI: SIWC self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) | Explicit OSS VM procedure. |
| O4 | [OpenAI: SIWC app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) | OAuth provider configuration, completion, renewal. |
| O5 | [OpenAI: SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | Authorized endpoint and account-specific model discovery. |
| O6 | [OpenAI: Managed auth in private CI](https://learn.chatgpt.com/docs/auth/ci-cd-auth) | Trusted private runner workflow and scope. |
| O7 | [OpenAI: Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) | `codex exec` scripting. |
| O8 | [OpenAI: SIWC quickstart](https://developers.openai.com/siwc/quickstart) | Availability and selected private clients. |
| O9 | [OpenAI: SIWC registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | Dynamic client registration and identity/scope validation. |
| O10 | [OpenAI: SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | Unsupported native tools and input limitations. |
| A1 | [Anthropic: Agent SDK with a Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | Subscription limits versus API credits. |
| A2 | [Anthropic: Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | Unmodified hosted-client conditions. |
| A3 | [Anthropic: Run Claude Code programmatically](https://code.claude.com/docs/en/headless) | Print mode, outputs, context loading, bare-mode boundary. |
| A4 | [Anthropic: Authentication](https://code.claude.com/docs/en/authentication) | Credential precedence, storage, renewal. |
| H1 | [Happy maintainer repository](https://github.com/slopus/happy) | Current architecture and maintainer feature claims. |
| H2 | [Happy LICENSE](https://github.com/slopus/happy/blob/main/LICENSE) | MIT license verified in source. |
| H3 | [Happy: How It Works](https://happy.engineering/docs/how-it-works/) | Checked; no readable body returned. |
| T1 | [OpenAI: Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Automated extraction and account-use restrictions. |
| T2 | [Anthropic: Consumer Terms](https://www.anthropic.com/legal/consumer-terms) | Automated access and scraping restrictions. |

