# Feature parity and verification matrix

Assessment date: 2026-10-09. Applies to the conditional SIWC plus Claude Code route in [feasibility.md](feasibility.md).

This matrix separates documented provider capabilities from the application's own behavior. No live provider capability is accepted merely because documentation describes it. The real test ledger is [acceptance-results.md](acceptance-results.md); provider proof belongs in [integration-proof.md](integration-proof.md).

Status vocabulary:

- **Supported**: the selected interface documents the capability; account and integration testing still applies.
- **Imported manually**: the user explicitly supplies selected content. No account synchronization is implied.
- **Reimplemented**: supplied by this application, independently of native provider features; implementation and test results are tracked separately.
- **Unavailable**: the selected interface does not expose the feature, or it is outside this release.
- **Unverified**: evidence or a real integration test is missing.

## Context and native features

| Feature | OpenAI candidate | Claude candidate | Shared-application handling | Evidence and planned test |
| --- | --- | --- | --- | --- |
| Personal memory from native website | Unavailable through SIWC | Unverified; Claude Code context is not proof of Claude.ai memory access | Imported manually as selected, editable preferences | O2; provide a selected preference, restart, ask each participant to recall it, correct it, and confirm the correction wins. |
| Native website chat history | Unavailable through SIWC | Unverified for Claude.ai; CLI sessions are a different store | Imported manually from selected exports/paste; no automatic website capture | O2, A3; import only selected text and verify excluded private conversations never enter assembled context. |
| Shared room history | Reimplemented | Reimplemented | Persist messages and send relevant shared history to both adapters | Application design; inspect exact assembled context, restart, and verify a follow-up fact with both real providers. |
| Project instructions | Imported manually | Supported for Claude Code local instructions, but isolated integration behavior unverified | Reimplemented shared-context editor with explicit selection | A3; conflicting older/newer instructions must resolve to the user's latest correction. |
| Project files and attachments | Supported for model-compatible text/images/files; no Files upload API on SIWC | Unverified for each file type and current adapter | Imported manually; attachment references must not imply binary parsing | O10; test plain text first, then PDF/image independently. Reject unsupported types clearly. |
| Native connectors | Unavailable as hosted SIWC MCP/connectors | Unverified; Claude Code MCP is not automatic reuse of Claude.ai connections | Unavailable in initial text-only proof; later explicit connections | O10, A3; confirm no ambient connector is inherited. Test any future connector separately with read-only access. |
| GitHub | Reimplemented integration required | Reimplemented integration required for controlled shared context | Optional later read-only fetch; not connected by this build | Plan requirement; record repository, branch, commit, selected files, and access scope. Do not modify a private project repository. |
| Web research | Supported only where model/account policy permits; integration unverified | Unverified for account and configured tools | Citation text can be shared; no claim of native research-mode equivalence | O10, A3; verify retrieval, accessible source URLs, and exact evidence passed to reviewer. |
| Code execution | Unavailable as hosted SIWC Code Interpreter; local harness tools are a separate capability | Supported by native client tools, disabled unless deliberately granted | Unavailable in initial peer-review proof | O10, A3; future isolated sandbox must reject out-of-workspace writes and instruction injection in reviews. |
| Image understanding | Supported when selected SIWC model accepts images; unverified in adapter | Unverified in this integration | Unavailable until genuine binary input handling is tested | O10; send a benign image with a known fact and inspect actual model input. A filename alone is not image input. |
| Image generation | Unavailable as SIWC hosted image-generation tool | Unverified; not implemented | Unavailable in this release | O10; no generated-image claim or visual placeholder presented as a provider result. |
| Voice, audio, video | Unavailable through selected SIWC audio/video and transcription interfaces | Unverified; not implemented | Unavailable in this release | O10; voice controls remain absent until a separately authorized route is documented and tested. |
| Model selection | Supported account model discovery; catalog is not proof of inference | Unverified account availability | Only expose models that the chosen route can validate | O5, A4; record actual model/version from each completed response without assuming a subscription tier. |

## Collaboration behavior

| Feature | Classification | Current evidence boundary | Required proof |
| --- | --- | --- | --- |
| Primary answer then peer review | Reimplemented | Deterministic mocks can exercise sequencing; no real two-provider result is established | Real requests in both directions; reviewer receives exact completed answer. |
| One optional revision | Reimplemented | Application turn limits can be tested without inference | Real or mock turn-count evidence; default remains off. |
| Cancellation, retry, duplicate suppression | Reimplemented | Mock tests can cover controlled failures | Test stop and duplicate keys; do not blindly retry uncertain provider submission. |
| Durable messages and shared context | Reimplemented | Application storage is separate from provider memory | Restart, export/restore, and inspect IDs, timestamps, context revisions, and messages. |
| Review of underlying research or tool results | Unverified | A final answer alone does not expose all source/tool evidence | Record whether evidence is actually included; show the limitation when only answer text is available. |
| Computer-off operation | Unverified | A prepared deployment or relay is not an availability test | Timed real exchange on approved remote infrastructure while the personal computer is off. |
| Native ChatGPT/Claude website synchronization | Unavailable | Not implemented by creating another chat UI | Treat as a distinct future integration, subject to provider approval and explicit source selection. |
| Subscription billing and no paid fallback | Unverified for real accounts | Mock operation does not consume model usage; static guards do not prove live billing | Provider-native auth status, completed inference, actual funding evidence, and failure when unexpected credentials exist. |

## Import and disclosure rules

Application exports contain application data only. They do not claim to export or back up the user's complete ChatGPT or Claude account. Import requires selected user-provided content; preserve its source label and original record. Summaries, if introduced, need source ranges and versions. A correction supersedes stale context without deleting the historical message.

Connection details must disclose the actual backend. An OpenAI participant using SIWC is identified as such; if an approved future configuration uses Codex, identify “OpenAI via Codex.” Claude's native adapter is “Claude via Claude Code.” Mock participants and synthetic output must remain visibly labeled.

Source IDs O2, O5, O10, A3, and A4 refer to the primary URLs and retrieval date in [feasibility.md](feasibility.md). “Reimplemented” describes ownership of behavior, not a blanket passing test result.

