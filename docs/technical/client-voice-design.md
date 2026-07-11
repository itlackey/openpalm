# Client Voice Port — Design (B10)

**Status:** DESIGN ONLY — implementation is deliberately deferred.
**Date:** 2026-07-11
**Origin:** review 2026-07-10 finding B10 (`docs/reviews/ui-admin-migration-review-2026-07-10.md`),
required by the §12.2 chat-parity contract's ratified decision (option (b) —
see `docs/technical/ui-runtime-modes-plan.md` §12.2).

## Why this doc exists, and why it doesn't ship code

The §12.2 chat-parity contract's six text-chat items (streaming render, stop,
copy, composer resilience, history, markdown) are met and pinned
(`packages/client/e2e/parity-contract.pw.ts`). Voice was carved out of that
contract as a separate, harder question: "just copying the components" is
architecturally impossible today, because

1. the browser-side voice modules live in `packages/ui` (the host app), not
   `ui-kit` or a client-consumable package, and
2. the client's own purity gate (`packages/client/tests/purity.test.ts`)
   forbids `/api/host` markers anywhere in the built bundle — but the voice
   API surface (`/api/host/voice`, `/api/transcribe`, `/api/speak`) is
   entirely host-app routes today, with no equivalent on the per-connection
   guardian/OpenCode edge the client actually talks to.

The ratified §12.2 decision (b) explicitly defers the voice port and keeps
voice **host-chat-only for now**. This document is the design-first path a
future implementer follows *if and when* that decision is revisited — it is
not a work order for this session, and no code changes accompany it.

## 1. Inventory: browser-pure voice modules (candidates for ui-kit / `@openpalm/voice`)

All of the following live under `packages/ui/src/lib/voice/` at HEAD. Each was
audited for whether it depends on anything host-app-specific (SvelteKit
server routes, `@openpalm/lib`, chat-state) versus being pure browser code:

| Module | LOC | Browser-pure? | Notes |
|---|---|---|---|
| `media-recorder.ts` | 138 | **Yes** | Thin `MediaRecorder` wrapper; all browser API access is lazy (SSR-safe). Depends on nothing else in this list. |
| `vad.ts` | 228 | **Yes** | Zero-dependency voice-activity detection (RMS-energy hysteresis over an `AnalyserNode`). Pure state machine (`advanceVad`/`computeRms`) separated from WebAudio wiring — already unit-tested standalone. |
| `earcon.ts` | 58 | **Yes** | Two-tone WebAudio blip, no assets, no TTS engine. Zero dependencies. |
| `audio-playback.ts` | 403 | **Yes** | The imperative TTS engine: speak queue, `HTMLAudioElement`/blob-URL lifecycle, autoplay-policy fallback. Deliberately holds no reactive `$state` itself — mutates fields on an `AudioPlaybackHost` interface the caller supplies, which is exactly the seam a client-side host object would plug into. |
| `sentence-stream.ts` | 108 | **Yes** | Incremental sentence chunker for streamed TTS (`extractSpeakableChunks`). Pure and dependency-free. |
| `speakable-text.ts` | 120 | **Yes** | Deterministic markdown-to-speech stripping (`toSpeakableText`). Pure and dependency-free — already shared conceptually with the server TTS route's own rules (see §4). |
| `voice-state.svelte.ts` | 860 | **Mostly, with two exceptions** | The Svelte reactive orchestrator (state machine: idle/recording/transcribing/speaking, conversation mode, barge-in). Composes all of the above. The two non-portable dependencies are the network calls: `transcribeAudio`/`fetchVoiceConfig` from `$lib/api.js` (→ `/api/transcribe`, `/api/host/voice`) and the TTS route the audio-playback controller ultimately fetches from (`/api/speak`). Those calls are exactly what §2 below has to replace. |

**Verdict:** every module except the two network call-sites in
`voice-state.svelte.ts` is browser-pure today. The port is **not** blocked by
tangled host-app dependencies inside the voice modules themselves — it is
blocked by the *endpoints* those two call-sites hit, which is §2.

**Target location:** a new `@openpalm/voice` package (not folded into
`ui-kit`), because:
- `ui-kit` is deliberately a raw-source, zero-network, presentation-only
  workspace package today (`packages/ui-kit/tests/no-app-coupling.test.ts`
  enforces this) — the voice modules need to make authenticated,
  per-connection network calls, which is a different contract than anything
  currently in `ui-kit`.
- A separate package lets the client depend on it explicitly and lets the
  purity gate assert its dist output the same way it already asserts
  `packages/client/build/`.

The state machine itself (`voice-state.svelte.ts`) would need a
connection-aware constructor (today it is a bare module-level singleton
tied to the single host-app assistant endpoint) — turning it from "the one
`voiceState` global" into "one instance per active client connection,"
mirroring how `ChatControllerState` would need the same shape for the B15
in-chat connection switcher (`ui-runtime-modes-plan.md` §12.7 "true
remainder"). These two client-side statefulness fixes are related but
distinct migrations; B15 does not require B10 and vice versa, but a future
implementer doing both should design the connection-scoping once and reuse
it.

## 2. The per-connection speak/transcribe edge (the actual blocker)

Today, voice's two network dependencies are host-app routes with no
per-connection equivalent:

- `packages/ui/src/routes/api/transcribe/+server.ts` — STT proxy (browser
  audio blob → configured STT engine).
- `packages/ui/src/routes/api/speak/+server.ts` — TTS proxy (text → audio).
- `packages/ui/src/routes/api/host/voice/+server.ts` — engine
  configuration/bring-up (which STT/TTS engine, addon lifecycle). This one
  legitimately stays host-only forever (§4) — it is host *configuration*,
  not a per-turn data-plane call.

The client's only server-side collaborator per connection is the **guardian**
(or a bare OpenCode instance for the loopback default). Neither exposes
speak/transcribe today. For a real port, the guardian would need to grow:

- `POST /voice/transcribe` (or similarly namespaced) — accepts an audio
  blob, proxies to whatever STT engine that connection's backing assistant
  is configured with, returns a transcript. Needs the same auth/CORS
  posture as the guardian's existing chat proxy endpoints (deny-all origin
  default, `GUARDIAN_CORS_ALLOWED_ORIGINS` opt-in — see review finding E3/I4
  and `docs/technical/ui-runtime-modes.md` Security Boundaries).
- `POST /voice/speak` (or a streaming equivalent) — accepts text, returns
  synthesized audio, ideally chunked/streamed so the existing
  `sentence-stream.ts` incremental-chunk model still applies over the wire.
- Engine discovery: the client needs to know whether a given connection
  even *has* a usable TTS/STT engine configured, so the mic/speaker
  affordances can hide themselves cleanly (mirroring `voiceState.sttSupported`/
  `ttsSupported` today, but per-connection instead of process-global).

None of this exists on the guardian today. This is real, non-trivial
guardian surface area — it is the actual reason "just copy the components"
does not work, independent of whether the browser-side modules in §1 move.

## 3. A `voice` block in `writeClientRuntimeConfig`

`packages/lib/src/control-plane/client-runtime-config.ts`'s
`writeClientRuntimeConfig` (and the `ClientRuntimeConfig` type it writes)
would need a new optional field describing voice capability for the locked
default connection, e.g.:

```ts
export type ClientRuntimeConfig = {
  connections: ClientRuntimeConnection[];
  hostUrl?: string;
  // B10 (future): per-connection voice capability, written by the same
  // process that writes runtime-config.json today (Electron main.ts,
  // the CLI's client-server, the assistant-container entrypoint).
  voice?: {
    sttAvailable: boolean;
    ttsAvailable: boolean;
  };
};
```

Every current writer of `runtime-config.json` (Electron's
`buildClientRuntimeConfigOptions`, the assistant-container entrypoint's
inline JS writer, and `packages/lib`'s `writeClientRuntimeConfig` helper —
review finding I5 already flags these as two divergent writers needing a
shared id/label; a `voice` block is a third field they'd all need to agree
on) would need to populate it from the same engine config
`/api/host/voice` already resolves today. Connections added by the user at
runtime (not the locked default) would need their own way to learn this —
most naturally a `GET /voice/capability` on the guardian edge itself (§2),
queried lazily rather than baked into a static file.

## 4. Engine `CONFIG` stays host-only

`/api/host/voice` (PUT to change the configured STT/TTS engine, GET to poll
bring-up status) is host **configuration** — which engine is selected,
addon-container lifecycle (pull/start/healthcheck for the bundled
`openpalm-voice` addon) — not per-turn data. This legitimately stays
host-only forever, exactly like `/api/assistant/model` stays host-only for
text-model selection. The client never needs to configure engines; it only
ever needs to (a) know whether the currently active connection has a usable
engine (§3) and (b) call the per-turn data-plane endpoints in §2.

## Summary: what's deferred and why

| Piece | Portable today? | Blocker |
|---|---|---|
| media-recorder, vad, earcon, audio-playback, sentence-stream, speakable-text | Yes — browser-pure | None; straightforward move to `@openpalm/voice` |
| voice-state.svelte.ts orchestration | Mostly — needs connection-scoping | Two network call-sites (below) + singleton → per-connection instance |
| Transcribe/speak data-plane calls | **No** | Guardian has no speak/transcribe edge (§2) — real new surface area, not a copy job |
| Engine configuration (`/api/host/voice`) | N/A | Correctly stays host-only (§4) |

Implementation is **deferred by the ratified §12.2(b) decision** —
voice remains host-chat-only until this design is executed (or superseded)
and a new decision is made to revisit option (a). See
`docs/technical/ui-runtime-modes-plan.md` §12.2 and §12.7 ("true remainder")
for the decision record, and the decision-issue draft this review round
files separately for tracking.
