# Voice Settings Architecture — Client vs. Host

> Status: **current truth** (2026-07). Supersedes the voice-settings half of
> an earlier addon proposal and the settings material in
> [`voice-container-build.md`](./voice-container-build.md) — the container
> build described there still applies; the settings/enable flow does not.

For a long time voice settings were muddy because two unrelated things shared
one form, one endpoint, and one storage location: **client UI settings**
(which TTS/STT provider a given browser uses) and **host capability settings**
(whether the voice container runs, and on which hardware profile). The old
admin Voice tab saved both through `PUT /api/host/voice` into
`state/stack.env`, and the chat client consumed them through
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
  `state/stack.env`, resolved to compose `--profile addon.voice.<variant>`.
- Container-level knobs (`OP_VOICE_WHISPER_MODEL`, `OP_VOICE_KOKORO_VOICE`,
  `OP_VOICE_LOG_LEVEL`) stay in the addon env schema / credentials drawer.

## Client side — each browser owns its TTS/STT provider choice

- Settings live in the browser (`packages/ui/src/lib/voice/settings-store.ts`,
  localStorage), edited on the **General** tab of the device settings surface
  at `/connections` (the page reached from chat's "Open settings"; its
  `DeviceSettingsNav` splits it into a **General** tab — theme + voice — and a
  **Connections** tab). These settings apply across every assistant connection
  in that browser.
  Provider API keys use the IndexedDB secret store shared with connection
  passwords (`connections/secrets.ts`). They are AES-GCM encrypted at rest
  when WebCrypto is available; on an insecure plain-HTTP origin, WebCrypto is
  unavailable and the store explicitly degrades to plaintext at rest.
- Providers: `browser` (Web Speech API), `openpalm-voice` (the host's voice
  container), `openai-compatible` (any OpenAI-shaped `/v1/audio` endpoint),
  or `disabled` — independently for STT and TTS.
- Transport (`packages/ui/src/lib/voice/providers.ts`) — OpenAI-shaped
  `/v1/audio/transcriptions` and `/v1/audio/speech`, one of two ways:
  - **`openpalm-voice` → the same-origin `/voice/*` pass-through**
    (`packages/ui/src/routes/voice/[...path]/+server.ts`): a transparent,
    config-free pipe from the UI origin to `127.0.0.1:OP_VOICE_PORT_HOST`
    (the guardian's `/oc` pattern). Session-authed, allowlisted to the
    container's OpenAI surface. Same-origin is the point: no CORS anywhere,
    the container image is untouched, and it works with the container's
    default loopback-only binding — a LAN browser reaches the UI origin and
    the host process makes the local hop, so no port is ever opened for
    voice.
  - **`openai-compatible` → called directly from the browser** with the
    client-held API key (the provider's own CORS policy governs, exactly as
    it does for any browser caller of that provider).
- There is no config-holding relay: the old `/api/speak` / `/api/transcribe`
  routes (which read host-global stack.env provider config) are gone.
- Conversation mode requires both a usable STT provider and a usable TTS
  provider. Starting it enables spoken replies for the conversation; stopping
  tears down microphone/VAD ownership and cancels current and queued playback.
- The settings panel can run a bounded ten-second microphone/transcription
  test whose transcript stays in the panel, plus a speaker test that uses only
  the selected provider. Neither test sends a message to the assistant.
- The page always links back to Chat and Connections. In a host-capable runtime,
  it also links to `/host?tab=addons`, where the operator manages the Voice
  add-on. Non-host clients do not render that host-management link.

## Discovery — how a client finds "OpenPalm Voice"

The runtime handshake advertises the pass-through: `GET /api/runtime` (and
the layout server data) carries `voice: { url: '/voice' }` when the process
can actually serve it — the voice addon is enabled in readable stack state
AND the process has a loopback path to the voice container. Voice is **not**
gated on admin capability: using voice is not a privileged host operation, so
a served non-admin `openpalm ui serve` / Electron host advertises and proxies
it too. The one process that must fail closed is the assistant container's
in-container UI co-process — it reaches only its own `127.0.0.1`, never the
sibling voice container, and its resolved home can sit in an
assistant-writable mount — so it sets `OP_UI_NO_LOCAL_VOICE=1` and neither
advertises nor proxies `/voice` regardless of stack state (see
`canServeLocalVoice` in `packages/ui/src/lib/server/features.ts`). The path is
same-origin and env-derived — nothing request-dependent.

Client defaults when nothing has been saved: prefer `openpalm-voice` when
advertised, else `browser` when the Web Speech API is usable (iOS Safari's
broken SpeechRecognition is detected and avoided), else `disabled`. Saved
provider choices are strict: an unavailable provider is reported as
unavailable and is never silently replaced with another provider.

For a **remote** connection's voice container, the user configures it as an
`openai-compatible` provider with an endpoint that host exposes — remote
hosts do not (yet) advertise their voice endpoint through the connection
itself.

## Setup wizard

The wizard's voice step is capability-only: a plain toggle that enables the
voice addon and records the hardware profile (`addons.voice` + `voiceProfile`
in the setup payload). The entire tts/stt engine plumbing — `SetupSpec`
blocks, payload serialization, engine tables, `writeVoiceVars`, the
`OP_TTS_*`/`OP_STT_*` stack.env keys — is deleted, not deprecated. Fresh
installs get working voice with zero client configuration via the
advertisement defaults above.

## Migration notes

- `OP_TTS_*` / `OP_STT_*` keys left in `state/stack.env` by older
  releases are **removed automatically** on the next reconcile (the same
  retired-key prune that strips removed-addon state — see `RETIRED_ENV_KEYS`
  in `packages/lib/src/control-plane/addons.ts`). Client settings are not
  migrated from them: defaults auto-select the host's voice container when
  advertised; users of remote third-party TTS/STT re-enter that endpoint once
  on the `/connections` **General** tab (keys now stay in the browser, which is
  the point).
- The admin Voice tab is gone; the Capabilities drawer (host) and the client
  voice settings on the `/connections` **General** tab replace it.
