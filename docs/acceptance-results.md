# Acceptance results

Date: 9 October 2026. **Partial implementation. Real subscription and cloud acceptance have not passed.**

The final local run passed 77 automated tests with zero failures. Test evidence is in `test-evidence.txt` and `mock-proof.json`. All model responses in automated tests are mocks or injected HTTP/CLI fixtures. OAuth tests use generated signing keys and injected provider responses. Local HTTP requests, loopback callbacks, SQLite writes, process setup, backup, restore and restart checks are actual application operations.

| Plan scenario | Application result | Real-provider/cloud result | Evidence |
| --- | --- | --- | --- |
| 1. OpenAI answers, Claude reviews | Passed with mocks | Blocked | Engine both-orders test, mock transcript |
| 2. Claude answers, OpenAI reviews | Passed with mocks | Blocked | Engine both-orders test, HTTP test |
| 3. Follow-up uses shared discussion | Prior discussion delivered in mock prompts | Untested model understanding | Engine prompt assertions, transcript |
| 4. Corrected fact supersedes earlier fact | New context version persists and reaches both mock adapters | Untested model understanding | Corrected-context restart test |
| 5. Review disabled produces one answer | Passed with mocks | Blocked | Bounded-turn test |
| 6. One revision stops after final turn | Passed with mocks | Blocked | Bounded-turn test |
| 7. Stop, retry, duplicate submission | Engine and HTTP behavior passed with mocks; UI changes syntax-checked | Real process behavior untested | Cancellation, idempotency, reviewer-only retry tests |
| 8. Expired login and exhausted quota | Fixture failures show safe states; no fallback | Account failures untested | Provider and engine tests |
| 9. Restart preserves history without automatic replay | Passed locally with mocked in-flight states | Host/container restart untested | Restart and operations tests |
| 10. Export and restore preserve data | Passed locally, including backup completed after snapshot | Container and off-host restore untested | Import/export and operations tests |
| 11. Native memory and advanced claims match support | Unavailable/unverified capabilities labeled explicitly | No provider feature tests | Feature matrix and integration proof |
| 12. No API key or paid fallback activates | API-auth rejection and release gate passed in source/fixtures | Actual subscription funding unverified | Provider tests, mock-only server guard |

## Additional checks

- Password hashing and cookie integrity/expiry tested.
- Unauthenticated data requests and cross-origin mutations rejected.
- Provider environment excludes inherited billing keys, proxies, user configuration and unsupported auth routes.
- Provider error output is classified without writing raw diagnostics into ordinary logs or messages.
- OpenAI sign-in fixtures cover PKCE, state, nonce, ID-token signatures, protected storage, rotating refresh and serialization across separate processes.
- Malformed callback requests and wrong-state callbacks do not crash or consume a valid pending sign-in.
- OpenAI stream fixtures require complete final output and reject incomplete, failed, over-quota and interrupted responses without automatic retries.
- The live-proof factory rejects unverified source publication and non-boolean spend acknowledgements before model requests.
- Oversized context fails explicitly instead of silently dropping a correction.
- A consistent SQLite backup and restore preserve messages/context and retain the previous database.
- Restored queued work becomes ambiguous, preventing automatic replay after an older snapshot.
- The worker uses an exclusive SQLite lock rather than a reusable PID file.
- Proxy health works with a loopback Host, while private data routes retain Host checks.
- Caddy configuration overwrites the trusted client-IP header; local mode ignores forwarded IPs.
- JavaScript syntax checks passed. Browser rendering, mobile interaction and accessibility have not been visually tested.

An independent code review identified backup replay, browser retry idempotency, PID-lock reliability, proxy rate-limit attribution, and missing sign-out issues. These were addressed in source. Automated test coverage applies only where named above; no claim of a penetration test or complete security audit is made.

A second independent review found callback parsing/state-consumption defects and a truthy publication flag in the subscription bootstrap. These were corrected and regression-tested. The reviewer verified the callback repair and scanned the generic release for private data. The public release starts with a sanitized initial history; earlier private development commits are not included.

## Phase decisions

Phase 0's documentation and route-selection criteria are met: a named subscription route has official evidence and a plausible private VM path, and native feature gaps are documented. Publication and account eligibility remain prerequisites for live proof. No real two-provider exchange exists, so Phase 1 remains blocked. Independent portions of Phases 2 and 3 are implemented with mocks. Phase 4 is prepared but untested and undeployed. Phase 5 cannot pass until the essential real collaboration and computer-off scenarios pass.

Cloud availability test duration: **not run**. Real-exchange screenshot/recording: **not available**. Hosting spend: **none**. Separate model API spend from this application: **none**.
