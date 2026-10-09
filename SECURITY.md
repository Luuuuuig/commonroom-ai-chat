# Security and private data

The code is intended for a private, single-owner application. Public source does not authorize public access to the running application or sharing provider credentials.

Do not put credentials, conversation exports, databases, provider state, account emails, private project files or unredacted logs in issues, pull requests or releases. Share a minimal reproduction using synthetic data. Report suspected credential exposure privately to the repository owner using an available private reporting channel. If none is configured, ask for one without including sensitive content.

The default server uses mock providers. Subscription code is experimental and requires its documented release, account and billing checks. It is not a hosted multi-user subscription proxy. No API-key fallback is implemented.

Before deploying a new version, review authentication and configuration changes, run the tests, make a consistent backup, and verify restore in an isolated environment. For provider tokens, use protected local files or a secrets store. Never paste tokens into chat, source, browser storage, ordinary logs or a public issue.
