# containers/guardian — Message Guardian

Bun HTTP server that acts as the security checkpoint for all inbound portal traffic. Every first-party portal adapter and direct MCP/API ingress path passes through the guardian before reaching the assistant.

The image also ships the OpenCode binary (pinned to the same `OPENCODE_VERSION` as the assistant). Guardian-side OpenCode instances read their global config from `/etc/opencode` (bind-mounted from `OP_HOME/config/guardian`, set via `OPENCODE_CONFIG_DIR`) and share provider credentials with the assistant through the read-only `auth.json` mount (from `OP_HOME/knowledge/secrets/auth.json`).

## Security pipeline

For each authenticated `/oc/*` request:

1. Authenticate the principal with Basic auth (`PRINCIPAL_ID` + secret file contents)
2. Enforce the endpoint allowlist / direct-tier routing rules
3. Enforce session and permission/question ownership
4. Enforce rate limits and stream/turn resource bounds
5. **Content validation** (opt-in) on prompt-bearing write routes — semantic check for malicious content (see below)
6. Proxy native OpenCode traffic to the assistant

Any failure returns an error and the request never reaches the assistant.

## Content validation (opt-in)

Steps 1–2 are structural only — they confirm a message is *well-formed*, not
that it is *safe*. When `GUARDIAN_CONTENT_VALIDATION` is enabled, step 6 adds a
semantic layer that inspects what the message is actually trying to do, using a
local OpenCode moderator. It is layered cheap → expensive:

- **Heuristic pre-screen** (`containers/guardian/src/content-screen.ts`): pure,
  in-process pattern matching that scores prompt-injection / jailbreak /
  exfiltration / obfuscation signals. Most traffic scores 0 and is forwarded
  without ever touching a model.
- **LLM escalation**: only messages whose risk crosses
  `GUARDIAN_MODERATION_THRESHOLD` are sent to the guardian's local OpenCode
  moderator (loopback `:4097`, started by the entrypoint, using the small model
  pinned in `config/guardian/opencode.jsonc` and the shared provider creds). It
  returns a strict JSON verdict: `allow`, `flag` (forward + audit), or `block`.

**Fail-closed:** if an escalated message cannot be classified (moderator down,
timeout, unparseable output) it is **blocked** (`403 content_blocked`). Because
that trades availability for security, the feature is **off by default** — turn
it on only once a moderation model is configured. The taxonomy and output
contract live in `config/guardian/instructions/moderation.md`.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/stats` | Guardian and proxy runtime stats |
| `*` | `/oc/*` | Authenticated native OpenCode proxy |
| `*` | `/mcp` | Optional direct MCP gateway on the direct listener |
| `*` | `/admin/*` | Optional guardian admin CRUD API on the admin listener |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `OP_ASSISTANT_URL` | `http://assistant:4096` | Assistant endpoint |
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | OpenCode global config dir (bind-mounted from `config/guardian`) |
| `GUARDIAN_AUDIT_PATH` | `/opt/openpalm/logs/guardian-audit.log` | Audit log path |
| `GUARDIAN_CONTENT_VALIDATION` | `0` | Enable LLM-assisted content validation (fail-closed) |
| `GUARDIAN_MODERATION_URL` | `http://127.0.0.1:4097` | Local OpenCode moderator endpoint |
| `GUARDIAN_MODERATION_PORT` | `4097` | Loopback port the entrypoint starts the moderator on |
| `GUARDIAN_MODERATION_THRESHOLD` | `3` | Heuristic risk score at/above which a message is escalated to the model |
| `GUARDIAN_MODERATION_TIMEOUT_MS` | `4000` | Per-classification timeout; on expiry the message fails closed |
| `GUARDIAN_DIRECT_INGRESS` | `false` | Enable the direct `/oc/*` listener on `GUARDIAN_DIRECT_PORT` |
| `GUARDIAN_MCP` | `false` | Enable the `/mcp` gateway on the direct listener |
| `GUARDIAN_ADMIN_TOKEN_FILE` | — | Admin CRUD bearer token file |
| `GUARDIAN_MCP_TOKEN_FILE` | — | MCP bearer token file |

## Development

```bash
bun run src/server.ts
```

Or from the repo root:

```bash
bun run guardian:dev
bun run guardian:test
```

## Testing

```bash
cd containers/guardian && bun test
```
