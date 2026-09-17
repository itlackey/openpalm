# Guardian MCP API

Guardian is a curated MCP agent gateway. It turns the native OpenCode API into
a small, policy-filtered set of durable agent operations; it is not a generic
OpenCode proxy.

## HTTP boundary

| Method | Path | Authentication | Result |
|---|---|---|---|
| `GET` | `/health` | none | `{"ok":true}` when Guardian is available |
| MCP transport methods | `/mcp` | Bearer | MCP Streamable HTTP |
| any | any other path | n/a | 404 |

The same `/mcp` endpoint supports modern MCP negotiation and stateless 2025-era
clients. There is no admin HTTP API, OpenAI/Anthropic compatibility endpoint,
A2A endpoint, raw OpenCode proxy, UI pass-through, or voice API.

## Authentication and policy

```http
Authorization: Bearer <credential>
```

| Initial username | Key file | Default policy |
|---|---|---|
| `owner` | `state/credentials/owner/key` | `full` |
| `discord` | `state/credentials/discord/key` | `chat` |
| `slack` | `state/credentials/slack/key` | `chat` |

Operators may add up to 128 lowercase named credentials. Each record has a
username, stable internal identity, key, and policy. Keys contain 32–512
printable non-whitespace ASCII characters. Guardian compares every configured
key with fixed-length digest comparison and rejects duplicated credentials.
Missing, weak, malformed, duplicated, or unknown credentials return 401.

```bash
openpalm credential add automation read
openpalm credential set-policy automation full
openpalm credential rotate automation
openpalm credential remove automation
```

The bearer header carries only the key; the username is the operator-facing
identity resolved by Guardian. A credential can be used by any MCP client and
assigned to either portal. Rotating its key preserves session ownership.
Removing and recreating the same username creates a different internal identity
and cannot recover the removed credential's sessions.

The configured `chat`, `read`, or `full` policy selects both the MCP catalog
and the managed Assistant profile. A prompt or handle can never select a more
privileged policy.

| Capability | `chat` | `read` | `full` |
|---|:---:|:---:|:---:|
| Guarded agent run and job polling/cancel | yes | yes | yes |
| Owned session list/get | yes | yes | yes |
| Session messages/diff/todos resources | yes | yes | yes |
| Question response and permission rejection | yes | yes | yes |
| Bounded workspace search/read | no | yes | yes |
| Session fork/delete | no | no | yes |
| Permission approval (`once`/`always`) | no | no | yes |
| Managed Assistant profile | `remote` | `remote-read` | `remote-full` |

`full` does not bypass OpenCode permissions. It permits Guardian to relay an
explicit client's decision when OpenCode returns an `ask` interaction.

## Tools

All essential operations are tools so tools-only clients, including OpenCode,
can complete the full workflow.

### Agent and jobs

`openpalm.agent.run`

```json
{
  "message": "required; 1..32000 characters",
  "session": "optional opaque session handle",
  "title": "optional title; 1..160 characters",
  "waitMs": "optional; 0..30000"
}
```

The tool creates or resumes an owned session, screens the message, starts the
policy-selected agent asynchronously, and waits for at most `waitMs`. It
returns opaque `session` and `job` handles plus one of:

- `completed` — includes `text` and may include changed files, todos, and usage;
- `running` — poll with `openpalm.job.get`;
- `input_required` — includes opaque question or permission interactions; or
- `failed` — includes a bounded public error.

`openpalm.job.get` accepts `{ "job": handle, "waitMs"?: 0..30000 }` and
returns the same status shape. `openpalm.job.cancel` accepts `{ "job": handle }`
and aborts the associated active OpenCode run.

### Sessions

- `openpalm.session.list({ limit? })` lists only sessions cryptographically
  owned by the authenticated named credential.
- `openpalm.session.get({ session, include? })` returns status and summary
  metadata. `include` may contain `messages`, `diff`, and/or `todos`, making
  those views available to tools-only clients.
- `openpalm.session.fork({ session, message? })` is `full`-only and creates a
  newly owned session. The optional value is an opaque message handle from the
  session-messages resource.
- `openpalm.session.delete({ session })` is `full`-only and permanently removes
  the session and history.

OpenCode session IDs and Guardian ownership proofs are never returned.

### Workspace

`openpalm.workspace.search` and `openpalm.workspace.read` are advertised only
for `read` and `full` credentials.

```json
{ "mode": "files | text | symbols", "query": "required", "limit": 50 }
```

```json
{ "path": "relative/path.txt" }
```

Reads are text-only and capped at 256 KiB. Paths must be relative to `/work`.
Traversal, absolute paths, VCS/credential directories, `.env` files (except
`.env.example`), private keys, auth files, and secret-like path components are
denied. Guardian reads its own read-only workspace mount and verifies the
canonical path and opened file descriptor remain inside `/work`, so symlinks
cannot escape the boundary. Search results pass through the same filesystem
check before their content or metadata is returned.

This is a confidentiality grant as well as a no-write policy: every ordinary
workspace file is visible to a `read` or `full` credential. Keep credentials
outside `/work`.

### Interactions

`openpalm.interaction.respond` accepts an opaque interaction handle plus:

- `answers: string[][]` for an agent question;
- `decision: "reject"` to reject a question or permission; or
- `decision: "once" | "always"` for a permission under `full` policy.

Question answers and optional permission messages are screened before they
reach Assistant. Guardian verifies that the interaction is still pending and
belongs to the same owned session. Non-`full` credentials can never approve a
permission.

### Catalog

`openpalm.catalog.get({})` returns the policy-filtered tool, resource, and
prompt names. It does not return the Assistant's internal tools, configuration,
providers, or credentials.

## Resources

Resources are additive conveniences. Tools-only clients use
`openpalm.session.get` with `include` for the same session views and
`openpalm.job.get` for job state.

- `openpalm://workspace/{path}` (`read`/`full` only)
- `openpalm://sessions/{session}/messages`
- `openpalm://sessions/{session}/diff`
- `openpalm://sessions/{session}/todos`
- `openpalm://jobs/{job}`

The URI variables are opaque Guardian handles where applicable. Reads repeat
policy, ownership, expiry, and path validation; possession of an upstream ID is
not authorization.

## Prompts

Guardian publishes four static workflow prompts:

- `openpalm.implement`
- `openpalm.debug`
- `openpalm.review`
- `openpalm.explain`

They produce client-visible user messages and never bypass `agent.run`, policy,
moderation, or permission handling.

## Handle and ownership model

New session, message, job, and interaction handles use AES-256-GCM with a key derived
from the file-backed Guardian handle secret. They are expiring,
credential-identity scoped, and conceal every upstream identifier. Session
handles default to 30 days, jobs to 24 hours, and interactions to one hour.

Guardian also writes an HMAC-bound ownership record into each created OpenCode
session. Listing, polling, resource reads, and mutations require that proof.
This keeps Guardian stateless without trusting user-supplied session IDs or
adding a database. Legacy signed conversation handles can claim only the
session they originally authenticated; Guardian upgrades that session with an
ownership record on first use.

Each new job handle is also bound to the exact OpenCode user-message ID created
for that run. Polling an older completed job remains deterministic, while an
older handle cannot cancel a later run in the same session.

## Security behavior

- Request bodies, prompts, responses, file reads, concurrency, waits, upstream
  calls, pre-auth traffic, and per-principal traffic are bounded.
- Browser requests require an exact configured HTTP(S) Origin. Wildcards and
  path-bearing origin entries are invalid.
- Prompts and human-input answers pass the heuristic screen. Suspicious text
  is classified by the separate loopback moderator.
- `flag`, `block`, moderator failure/timeout, or malformed classifier output
  fails closed.
- Raw shell/file-write endpoints, provider/auth/config management, session
  sharing, TUI control, and OpenCode MCP administration are not exposed.
- Upstream error detail, reasoning parts, credentials, session IDs, and
  ownership proofs are not returned.
- Audit records contain request metadata and verdict signals, never bearer
  tokens or prompt bodies.

## CORS

Set `GUARDIAN_ALLOWED_ORIGINS` to a comma-separated list of exact origins only
when a browser MCP client is required:

```text
https://agent.example.com,http://127.0.0.1:3000
```

A request without an Origin header is a non-browser MCP client. An Origin that
is absent from the allowlist returns 403. Allowed browser responses expose the
MCP session/protocol headers and request ID required by a Streamable HTTP
client; credentials remain bearer headers rather than cookies.
