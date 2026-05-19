# OpenPalm ↔ OpenCode Boundary

OpenPalm and OpenCode are two independent products with overlapping concerns
(both deal with AI providers, models, and credentials). The admin UI's two
relevant tabs **must not bleed into each other**:

| Tab | Owns | Files written | Endpoints |
|---|---|---|---|
| **Capabilities** | OpenPalm-internal capability assignment | `OP_HOME/config/stack/stack.yml` (`.capabilities`), `OP_HOME/config/stack/stack.env` (`OP_CAP_*` vars), `OP_HOME/config/akm/config.json` | `POST /admin/capabilities/assignments` |
| **Connections** | OpenCode's provider config + credentials | `OP_HOME/config/assistant/opencode.json` (`.provider`, `.model`, `.small_model`, `.disabled_providers`), `OP_HOME/config/auth.json` | `PATCH /admin/providers/[id]`, `POST /admin/opencode/model`, `POST/DELETE /admin/opencode/providers/[id]/auth`, `POST /admin/providers/import-host` |

## What Capabilities is for

`stack.yml.capabilities.{llm, slm, embeddings, tts, stt, reranking, akm}` is
OpenPalm's view of what models/engines the assistant should use for
internal pipelines:

- `OP_CAP_LLM_*` env vars surface to the assistant container's entrypoint and
  to akm's internal LLM client.
- `embeddings` drives the akm memory pipeline.
- `tts` / `stt` engine selection is read by the voice channel addon.

It is **not** OpenCode's chat model. The chat tab sends `{ parts: [...] }`
with no `providerID`/`modelID` and lets OpenCode resolve its own default.

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

- The Capabilities save handler **must not** call `setMainModel`,
  `patchConfig`, or any function from `$lib/server/opencode/config.ts`.
  Writing the LLM capability does not change OpenCode's chat model.
- The Connections endpoints **must not** call `writeStackSpec`,
  `writeCapabilityVars`, or `buildAkmSetupJson`. Changing OpenCode's
  default model does not change OpenPalm's capability assignment.
- If a user wants OpenPalm's capability LLM and OpenCode's chat model to be
  the same value, they set both — once in each tab. They are deliberately
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

OpenCode is a separate runtime with its own settings model. If the
Capabilities save handler also wrote OpenCode's model, then:

- Changing the LLM capability would silently overwrite the user's chat
  model preference.
- Disconnecting a provider in Connections would clobber a capability
  assignment.
- The "Import from host" feature would inappropriately overwrite
  OpenPalm's stack.yml just because the host's OpenCode had a different
  default.

Keeping the writes scoped lets each tab be reasoned about independently
and prevents one user action from triggering surprising changes in the
other system.
