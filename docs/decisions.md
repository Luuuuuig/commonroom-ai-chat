# Decision log

Date: 2026-10-09, Europe/Berlin.

## D01. Continue independent development while live integration is blocked

Status: adopted, within the supplied plan's explicit authorization.

Build inspectable application components, persistence, context assembly, deployment preparation, and deterministic mock tests. Keep mocks visibly labeled. Do not treat passing application tests as passing Phase 1 or the complete product. Phase 0's documented route selection is complete; Phases 1 through 5 remain unaccepted until their stated real-provider and deployment requirements pass.

## D02. Subscription funding only

Status: adopted from the user's instruction.

Separately billed model APIs remain disabled. Do not add an API-key fallback, silently switch authentication, buy credits, or enable account-level additional spending. Subscription-included API credits are a distinct route and are not selected implicitly. API protocols used by a documented subscription entitlement are permissible only after that entitlement and actual funding route are verified.

## D03. Preferred provider architecture

Status: conditional, eligibility and accounts unverified.

Target SIWC for the OpenAI participant and the unmodified Claude Code client with the user's own native subscription login for Claude. Prefer a private persistent VM after approved hosting. Keep the application single-user and its provider-control interfaces private. Both providers should receive the same deliberately selected context and the reviewer should receive the exact completed primary answer.

Do not use app-server's built-in ChatGPT authentication for a hosted service. Do not relabel the same hosted use as `codex exec` or CI to avoid an eligibility restriction. See [feasibility.md](feasibility.md) for evidence and precise unresolved boundaries.

## D04. Open-source self-hosted route selected

Status: source publication authorized and verified on 9 October 2026; accounts unverified.

The generic MIT source is public at [commonroom-ai-chat](https://github.com/Luuuuuig/commonroom-ai-chat), verified at commit `62406e41a0d4f52a61ab4a85ce53b278c5fcf875`. Follow the documented self-hosted OSS SIWC route. Chats, account information, imported documents and credentials remain private. Publication does not establish provider account eligibility.

The local OAuth helper and subscription adapter have fixture coverage. Obtain supported account sign-in and verify spending controls before live proof. Sign-in and completed inference have their own acceptance gate.

## D05. Small single-instance implementation

Status: adopted as a routine technical decision.

Use Node.js 24, standard-library HTTP and SQLite, and browser ES modules without third-party runtime dependencies for the application core. This keeps the initial single-user system inspectable and reduces installation complexity. Store durable jobs and messages in SQLite on a persistent volume. Use one long-running worker and serialize each conversation.

This changes the plan's suggested React/TypeScript starting stack, which was explicitly optional. It does not change product requirements. Reconsider the stack only when a verified integration or operational need justifies it. Any provider SDK/client remains a separate, versioned external dependency with its own installation and proof requirements.

## D06. Explicit orchestration, bounded work

Status: adopted.

Only user actions and stored orchestrator state trigger work. An answer, attachment, or pasted mention never starts a new task. The default is one answer and one review, then stop. Optional revision remains off by default and adds at most one turn. Preserve successful answers if review fails. Unknown provider submission state requires deliberate recovery, not an automatic resend.

## D07. Shared context belongs to this application

Status: adopted.

Persist room history and selected editable project context. Do not claim access to native provider memory or complete website histories. Support selected imports with provenance and preserve source records. Keep any future project GitHub connection read-only and record the selected commit. No private project repository access or mutation follows merely from this plan.

## D08. Official clients before bridges or browsers

Status: adopted.

Happy is a documented comparison candidate, not an installed dependency or proven integration. Its software license and maintainer claims do not settle provider permission or this application's review behavior. Native website browser automation remains unselected because no permitted extraction/automation route was established. A local extension also fails the computer-off requirement.

## D09. Separate app testing, integration proof, and deployment acceptance

Status: adopted.

Keep deterministic mock tests, real account tests, and computer-off availability tests distinguishable in the evidence. Record failed, blocked, and untested checks. Do not advertise a mock response as an AI response or a prepared deployment as a running service. Pin actual provider versions and record redacted authentication/billing information when live testing becomes authorized and possible.

## D10. Approvals occur at concrete boundaries

Status: adopted from the user's instruction.

Routine reversible development proceeds without repeated confirmation. Ask when provider sign-in is needed, for a new substantive choice, or before hosting expenditure. Prepare deployment configuration and a current cost scenario before asking to purchase infrastructure. Generic source publication is complete. Hosting expenditure is not approved.

