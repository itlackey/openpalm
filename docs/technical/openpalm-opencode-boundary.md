# OpenPalm ↔ OpenCode Boundary

OpenPalm and OpenCode are two independent products with overlapping concerns
(both deal with AI providers, models, and credentials). The admin UI's two
relevant tabs **must not bleed into each other**:

| Tab | Owns | Files written | Endpoints |
|---|---|---|---|
| **AKM** | AKM's internal LLM/embedding config | `OP_HOME/config/akm/config.json` (`llm`, `embedding` top-level fields) | `PATCH /admin/akm` |
| **Connections** | OpenCode's provider config + credentials | `OP_HOME/config/assistant/opencode.json` (`.provider`, `.model`, `.small_model`, `.disabled_providers`), `OP_HOME/knowledge/secrets/auth.json` | `PATCH /admin/providers/[id]`, `POST /admin/opencode/model`, `POST/DELETE /admin/opencode/providers/[id]/auth`, `POST /admin/providers/import-host` |
| **Voice** | TTS/STT channel configuration | `OP_HOME/knowledge/env/stack.env` (`TTS_*`, `STT_*` vars) | `PUT /admin/voice` |

> `knowledge/secrets/auth.json` is the single OpenCode credential store. It is mounted
> into the assistant (read-write) and the guardian (read-only), so credentials
> set via the Connections tab are also what the guardian's content-validation
> moderator uses — there is no separate guardian credential store.

## What the AKM tab is for

`config/akm/config.json` is AKM's native configuration file, read directly by the
`akm` CLI inside the assistant container at `/etc/akm/config.json`. It controls:

- `llm` — the endpoint, model, and provider AKM uses for internal LLM operations
  (memory inference, feedback distillation, index operations)
- `embedding` — the endpoint, model, provider, and dimension for AKM's vector search

This is **not** OpenCode's chat model. AKM reads `config.json` directly; the assistant
entrypoint does not call `akm setup --config` at startup (removed in v0.11.0).

## What Connections is for

The Connections tab mirrors OpenCode's own Settings → Providers / Models
UI. It writes the files OpenCode itself reads:

- **Sign in** → `PUT /auth/{providerID}` on OpenCode → writes `auth.json`.
- **Disconnect** → `DELETE /auth/{providerID}` on OpenCode → removes from
  `auth.json`.
- **Default model / Small model** → writes `model` / `small_model` in
  `opencode.json` (via `setMainModel` / `unsetMainModel`).
- **Custom provider** → adds a `provider.{id}` entry to `opencode.json`
  with the OpenAI-compatible adapter (`@ai-sdk/openai-compatible`).
- **Import from host** → copies `~/.config/opencode/opencode.json` and
  `~/.local/share/opencode/auth.json` into `OP_HOME`, then pushes
  credentials live via `PUT /auth/{id}` for each entry.

## What the boundary forbids

- The AKM save handler **must not** call `setMainModel`, `patchConfig`, or any
  function from `$lib/server/opencode/config.ts`. Writing AKM's LLM config
  does not change OpenCode's chat model.
- The Connections endpoints **must not** write `config/akm/config.json`.
  Changing OpenCode's default model does not change AKM's LLM config.
- If a user wants AKM's internal LLM and OpenCode's chat model to be the same
  provider/model, they configure both — once in each tab. They are deliberately
  separate concerns.

## Operational gotchas

- **Restart required after model change.** OpenCode reads `model` /
  `small_model` from `opencode.json` once at process startup and caches
  them. `PATCH /config` returns `200` with the patched fields but the
  running process keeps using the cached value. The Connections tab's
  model picker writes the file; a `docker restart openpalm-assistant-1`
  (or equivalent) is required for chat to pick up the change.
- **`connected` is env-detection only.** OpenCode's `GET /provider`
  `connected` array reports providers whose env vars are set (e.g.
  `OPENAI_API_KEY`). Providers whose credentials live only in `auth.json`
  are NOT listed there. `packages/ui/src/lib/server/opencode/catalog.ts`
  unions `auth.json` keys into the connected set so the Connections tab
  shows them correctly, with a `credentialType: 'env' | 'api' | 'oauth' |
  'config' | 'custom'` field driving the badge.
- **OAuth callback is a long-poll.** `POST /provider/{id}/oauth/callback`
  blocks server-side until the user completes the flow (e.g. enters the
  GitHub device code) or the provider times out. Make ONE call and wait;
  don't poll on an interval. Verified with `curl --max-time 7` hanging
  for the full 7s.
- **The auth subprocess is broken.** `opencode-auth-subprocess.ts` spawns
  a fresh OpenCode process for OAuth isolation, but in OpenCode 1.14.x /
  1.15.x the fresh subprocess's OAuth methods map fails to initialize
  (`TypeError: undefined is not an object (evaluating 'u[d.providerID].methods')`).
  All three OAuth routes (start / finish / callback) now bypass it and
  go to the assistant OpenCode at `OP_OPENCODE_URL` directly.
- **`OPENAI_BASE_URL=""` is fatal.** `@ai-sdk/openai` treats an empty
  string as a literal baseURL, not "unset", and the URL constructor
  throws `fetch() URL is invalid`. The line
  `OPENAI_BASE_URL: ${OPENAI_BASE_URL:-}` was removed from
  `.openpalm/config/stack/core.compose.yml` because of this. Per-provider
  URL overrides go through the Connections tab now, not env.

## Why the separation matters

OpenCode is a separate runtime with its own settings model. If the AKM save
handler also wrote OpenCode's model, then:

- Changing the AKM LLM would silently overwrite the user's chat model preference.
- Disconnecting a provider in Connections would clobber AKM's config.
- The "Import from host" feature would inappropriately overwrite AKM's config
  just because the host's OpenCode had a different default.

Keeping the writes scoped lets each tab be reasoned about independently
and prevents one user action from triggering surprising changes in the
other system.
