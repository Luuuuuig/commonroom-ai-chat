# Operations draft

Prepared: 9 October 2026. The configuration below is an undeployed draft. Docker is unavailable in the implementation environment, so image build, Compose startup, TLS, and host reboot have not been tested. There is no live deployment URL or measured cloud availability. Local application acceptance results are recorded separately.

## Deployment boundary

`deploy/compose.yaml` runs the application with **APP_MODE=mock**. It does not install or connect provider CLIs, copy workstation credentials, or configure a model API. Its answers are development mock output. Do not advertise this deployment as a working ChatGPT/Claude subscription integration.

Only Caddy publishes ports 80 and 443. The Node service, database, and any future provider control endpoints remain private. Node runs as the image's non-root `node` user. Its root filesystem is read-only; `/data` is a persistent named volume and `/tmp` is temporary. The Dockerfile creates `/data` with ownership for that user before the volume's first initialization.

The application binds to `0.0.0.0:3000` inside its container. `PUBLIC_ORIGIN` is `https://${DOMAIN}` and must match the actual address used by the browser, including the scheme. This permits the application's production cookie and origin checks. `/healthz` is a process health probe, not evidence of provider login, quota, or integration success; it must contain no private information.

Compose enables `TRUST_PROXY=1` only for its unexposed app service. Caddy overwrites `X-Private-Client-IP` with the actual remote address, so login rate limits distinguish clients. Never publish the app port or reuse trusted-proxy mode behind a proxy that does not overwrite this header. Direct local mode ignores forwarded headers.

## Host preparation and first use

Proceed only on already authorized infrastructure, or after approving the concrete quote in [costs.md](costs.md). Use a supported Linux host with Docker Engine and the Compose plugin. Restrict SSH at the host firewall to the operator. Allow public TCP 80/443 for HTTPS and certificate validation. Do not expose port 3000 or provider control ports.

Point an approved DNS hostname at the host. Create `/absolute/path/host.env`, outside the repository, containing only:

```dotenv
DOMAIN=chat.your-domain.example
```

Replace the example with the actual hostname. No provider keys or account tokens belong in this file. Commands below run from the repository root:

```bash
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml config
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml build app
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml run --rm --no-deps app node scripts/setup.mjs
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml up -d
```

Setup prompts for a password twice without echo and requires at least 16 characters. It writes `/data/config.json` with mode `0600`, containing the password hash and session secret. Treat both as sensitive. For non-interactive setup the script accepts `GROUP_CHAT_PASSWORD`, but prefer the terminal prompt so passwords do not enter shell history or process command arguments. The web service must never receive a plaintext password environment variable.

Check the mock-mode banner, private login, a mock answer/review exchange, and logout. Verify HTTPS, cookie flags, origin rejection, and absence of a public port 3000 before making the app accessible. `docker compose ... ps` should report the app healthy. The status screen must continue to identify real providers as blocked or unverified.

Existing volumes are retained by Compose. Never use `docker compose down -v` for a restart or upgrade. That removes persistent volumes. If volume permissions are wrong, investigate their ownership before starting the app; do not run the long-lived app as root to hide the issue.

## Restart and uncertain jobs

`restart: unless-stopped` requests restart after an unexpected process exit or host reboot. It is not an uptime guarantee. Chat history, jobs, and context live in `/data/chat.sqlite`. Runtime sessions use the persistent authentication configuration.

On restart, any job that may already have submitted work must become ambiguous or interrupted. Do not resubmit it automatically. Inspect saved messages and provider evidence, then use the application's deliberate retry control if appropriate. A reviewer failure must preserve a successful primary answer. Completed responses must not be duplicated.

The single-worker lock uses a separate SQLite file and a process-lifetime exclusive transaction. The operating system releases it after a crash. Keep the volume on local persistent storage with working file locks, not NFS. After restoring a backup, all unfinished jobs, including queued jobs, become ambiguous because they may have completed after that snapshot was taken.

Before claiming recovery works, record a restart test with a job in progress and inspect message/job counts afterward. Before claiming computer-off operation, run both real provider orders on the approved host while the personal computer is off, record the duration, and retain redacted evidence. Mock-mode success cannot satisfy that gate.

## Backup

Use the application backup command rather than copying an active SQLite database file. The database may use a write-ahead log. Create a protected backup directory and use a distinct filename for each backup:

```bash
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml exec app node -e "require('node:fs').mkdirSync('/data/backups',{recursive:true,mode:0o700})"
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml exec app npm run backup -- /data/backups/chat-YYYY-MM-DD.sqlite
```

Replace `YYYY-MM-DD` with the actual date and add a time suffix for multiple backups per day. Check the command's success and integrity result. Copy the completed backup to approved protected storage outside the VM; a second file on the same disk does not protect against host loss. Keep source copies and record a checksum. Encrypt external backups and restrict access because conversations and selected files can contain private material. Separate storage charges require approval.

Also protect `/data/config.json` for disaster recovery. A SQLite backup does not automatically include that file. Losing the session secret invalidates sessions; losing the authentication configuration requires setup again. Do not include this file in a repository, ordinary log, issue, or chat attachment. Provider credentials, if later authorized, require a separate provider-supported recovery process.

## Offline restore

Keep the source backup unchanged. Retain a separate pre-restore backup of the current database and authentication configuration before replacing anything. Stop the app so its application lock is released:

```bash
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml stop app caddy
```

Place a copy of the chosen backup at `/data/restore-input.sqlite`, readable by the `node` user and with mode `0600`. One bounded helper can copy a read-only mounted source into the named volume:

```bash
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml run --rm --no-deps --user 0:0 --entrypoint node -v /absolute/path/source-backup.sqlite:/restore/source.sqlite:ro app -e "const f=require('node:fs');f.copyFileSync('/restore/source.sqlite','/data/restore-input.sqlite',f.constants.COPYFILE_EXCL);f.chownSync('/data/restore-input.sqlite',1000,1000);f.chmodSync('/data/restore-input.sqlite',0o600)"
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml run --rm --no-deps app npm run restore -- /data/restore-input.sqlite
docker compose --env-file /absolute/path/host.env -f deploy/compose.yaml up -d
```

The root helper only copies the selected file; it does not run the server. Use a new staging filename if `restore-input.sqlite` already exists. The restore command must validate the backup and refuse an active application lock. If validation or the lock check fails, stop and investigate. Do not bypass the lock or modify the source backup.

After restore, inspect conversation and message counts, context versions, attachment references, login, and ambiguous jobs. Test restore first on an isolated volume or host before trusting it for disaster recovery. No container restore test has been performed in this environment.

## Provider authentication, quota, and tool limits

Real provider integration is blocked pending its feasibility and account gates. Do not mount `.codex`, `.claude`, browser profiles, or other workstation credential directories into this deployment. Do not add `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, unofficial token proxies, or paid fallback endpoints.

When a supported subscription route is verified, sign in through each provider's own supported flow on the approved host, keep credentials in provider-managed private storage, and establish the billing route. The current mock-only image needs an explicit reviewed change before that can happen.

When a login expires, pause affected jobs and request provider sign-in. When a quota is reached, retain the task, show the provider's exposed state, and wait or ask for a deliberate retry. If quota remaining is unavailable, display that fact. Never claim unlimited operation or renew a session by extracting browser cookies.

Any future provider tools must remain bounded to the selected workspace. Peer review must treat the primary answer and attachments as data; instructions embedded inside them must not authorize commands or external writes. External write tools require the user's actual authorization.

## Logs, upgrades, and verification

Application logs must omit prompts, response bodies, passwords, cookies, tokens, provider credentials, and sensitive config. Caddy access logs are disabled in this draft. Container logs rotate at three files of 5 MB each. Review a short redacted sample after deployment and after failures; do not upload raw logs without inspection.

The draft uses `node:24-bookworm-slim` and `caddy:2-alpine` tags. No image has been pulled or built here. Before production, test the exact images and record their digests, Node version, source commit, and acceptance results. Pin tested digests for reproducible releases. Upgrade deliberately, take a backup first, run the acceptance checks, and retain the prior image for rollback. Do not automatically install the newest provider client.

Outstanding cloud checks: image build; named-volume permissions; HTTPS and cookie behavior; health response privacy; host reboot; interrupted-job recovery; backup and offline restore; both real provider orders; actual subscription billing; and a timed computer-off availability test. Record passed, failed, blocked, or untested results in `acceptance-results.md`.
