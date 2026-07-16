# Voice Settings Architecture — Client vs. Host

> Status: **current truth** (2026-07). Supersedes the voice-settings halves of
> [`openpalm-voice-addon.md`](./openpalm-voice-addon.md) and
> [`voice-container-build.md`](./voice-container-build.md) — the container
> build described there still applies; the settings/enable flow does not.

For a long time voice settings were muddy because two unrelated things shared
one form, one endpoint, and one storage location: **client UI settings**
(which TTS/STT provider a given browser uses) and **host capability settings**
(whether the voice container runs, and on which hardware profile). The old
admin Voice tab saved both through `PUT /api/host/voice` into
`knowledge/env/stack.env`, and the chat client consumed them through
admin-only relays (`/api/speak`, `/api/transcribe`) that only worked against
the local host.

The architecture is now split along that line.

## Host side — Capabilities own the voice container

- The voice addon is managed like every other addon, from **Admin →
  Capabilities (Add-ons)**: enable/disable, plus its **hardware profile**
  (CPU / CUDA / ROCm) in the addon's settings drawer.
- `POST /api/host/addons(/voice)` routes voice enables and profile changes
  through the bring-up engine (`packages/ui/src/lib/server/voice/bring-up.ts`):
  port pre-flight, background image-pull jobs (202 + polling via
  `GET /api/host/addons` → `voice.activeJob`), CDI/rootless overlay selection.
- Persistence is unchanged: `OP_ENABLED_ADDONS` and `OP_VOICE_PROFILE` in
  `state/stack.state.env`, resolved to compose `--profile addon.voice.<variant>`.
- Container-level knobs (`OP_VOICE_WHISPER_MODEL`, `OP_VOICE_KOKORO_VOICE`,
  `OP_VOICE_LOG_LEVEL`) stay in the addon env schema / credentials drawer.

## Client side — each browser owns its TTS/STT provider choice

- Settings live in the browser (`packages/ui/src/lib/voice/settings-store.ts`,
  localStorage), edited in the **Voice section of the /connections page**.
  Provider API keys live in the encrypted IndexedDB secret store — the same
  store as connection passwords (`connections/secrets.ts`).
- Providers: `browser` (Web Speech API), `openpalm-voice` (the host's voice
  container), `openai-compatible` (any OpenAI-shaped `/v1/audio` endpoint),
  or `disabled` — independently for STT and TTS.
- The chat client calls providers **directly from the browser**
  (`packages/ui/src/lib/voice/providers.ts`) — OpenAI-shaped
  `/v1/audio/transcriptions` and `/v1/audio/speech`. There is no host relay:
  the old `/api/speak` / `/api/transcribe` routes are gone (they required an
  admin session and pinned every client to the local host's config). The
  voice container serves permissive CORS for exactly this reason (it is
  unauthenticated and loopback/LAN-bound by design).

## Discovery — how a client finds "OpenPalm Voice"

The runtime handshake advertises the endpoint: `GET /api/runtime` (and the
layout server data) carries `voice: { url }` when the local stack has the
voice addon enabled. The URL's hostname is taken from the request (the host
the browser used to reach the UI server) and the port from
`OP_VOICE_PORT_HOST` (default 8880), so it is reachable by that same browser.
Like `publicBaseUrl`, the field is request-derived and excluded from the SSR
store seed (`initializeServerRuntimeContext`).

Client defaults when nothing has been saved: prefer `openpalm-voice` when
advertised, else `browser` when the Web Speech API is usable (iOS Safari's
broken SpeechRecognition is detected and avoided), else `disabled`. A saved
`openpalm-voice` selection degrades to the browser engine when the host stops
advertising the endpoint.

For a **remote** connection's voice container, the user configures it as an
`openai-compatible` provider with the remote host's URL — remote hosts do not
(yet) advertise their voice endpoint through the connection itself.

## Setup wizard

The wizard's voice step is capability-only: it enables the voice addon and
records the hardware profile (`addons.voice` + `voiceProfile` in the setup
payload). The legacy `tts`/`stt` engine blocks in `SetupSpec` are accepted and
ignored (older wizards still send them); `writeVoiceVars` and the
`OP_TTS_*`/`OP_STT_*` stack.env keys are gone. Fresh installs get working
voice with zero client configuration via the advertisement defaults above.

## Migration notes

- `OP_TTS_*` / `OP_STT_*` keys left in `knowledge/env/stack.env` by older
  releases are inert — nothing reads them anymore. Client settings are not
  migrated from them: defaults auto-select the host's voice container when
  advertised; users of remote third-party TTS/STT re-enter that endpoint once
  in the /connections Voice section (keys now stay in the browser, which is
  the point).
- The admin Voice tab is gone; the Capabilities drawer (host) and the
  /connections Voice section (client) replace it.
