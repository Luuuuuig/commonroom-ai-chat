# Next steps

## Source publication complete

The generic MIT source is public at [commonroom-ai-chat](https://github.com/Luuuuuig/commonroom-ai-chat), verified at commit `62406e41a0d4f52a61ab4a85ce53b278c5fcf875`. Its 48 files match the reviewed release, with sanitized initial history. Credentials, runtime data and private project material remain private. Account access and live operation remain unverified.

## Then continue the phase gates

- Identify an available Linux/WSL proof runtime. The development workspace cannot run the live provider test. Prefer an existing runtime for the account proof; any new cloud host needs expenditure approval.
- The selected OpenAI sign-in/adapter has fixture coverage. Verify its real provider behavior after supported account sign-in.
- Verify the user's subscription entitlements and account-level spend controls, then ask for provider sign-in through official flows.
- Prove both provider orders and a follow-up before polishing or deploying live inference.
- Obtain a current host quote after route proof. The prepared low-cost option is a Hetzner CX33 if available, estimated €12.93/month including assumed Netherlands VAT, IPv4 and provider backups. Availability and final invoice remain unverified. Do not purchase or choose a more expensive fallback without approval.
- Build/test containers, trusted-proxy behavior, HTTPS, secrets, restore, worker restart and private access. Pin image digests after testing.
- Record an actual computer-off test, duration, and a redacted screenshot of both real provider orders.

## Remaining feature gaps

- Native website chat/history synchronization and native personal memories are not connected.
- OpenAI OAuth and streaming adapter source is fixture-tested. Neither provider is connected or live-tested.
- Rich image/PDF processing, voice, web tools, connectors, code execution and GitHub access are not enabled.
- Text/Markdown import is limited to explicitly selected inert content. No native export-format converter exists yet.
- Context summaries are not generated. All originals persist; oversized context stops with an actionable message.
- Browser visual QA and real mobile interaction remain untested.
- Automated encrypted off-host backups and retention are not configured.

Continue from the included source commits and evidence rather than treating this checkpoint as a completed integration.
