# UI/Admin Migration Review — PR #559 client split (2026-07-10)

**Scope.** Critical post-merge review of the UI/admin refactor merged to main as PR #559
(`c1eadbd3`, "Phase 5 client split: extract @openpalm/client SPA + ui-kit", 489 files,
+18,934/−2,935), evaluated at HEAD `d8b3fe04` (0.13.0-beta.1) against the pre-merge
reference `455d8728` (which included the PR #554 chat-voice UX).

**Method.** Multi-agent review: 8 parallel dimension reviewers (chat parity, voice,
Electron, admin routes, transport/connections, CLI/serving, build/release, docs-vs-reality)
produced 72 raw findings → deduplicated to 48 → each independently, adversarially verified
against HEAD by a separate agent. A completeness critic then dispatched 5 follow-up
finders (container/compose runtime, PWA/service-worker, onboarding/landing matrix,
host-UI self-parity, accessibility/testing), whose findings were verified the same way.
**Net result: 64 distinct confirmed findings** — 44 from the first wave (sections A–F)
plus 20 new from the gap round (sections G–K; 5 further gap findings independently
re-confirmed first-wave items and are merged into them). 4 claims were refuted (listed at
the end so they aren't re-reported). All file:line citations were re-checked at HEAD by
the verifiers.

---

## Executive summary — what actually went wrong

The migration did not delete features; it **built a "thin slice" client SPA and then made
it the default surface before parity existed**. Nearly every user-visible regression traces
to one routing decision plus a handful of genuine wiring bugs:

1. **The delivery vector (root cause):** `resolveInitialUrl` in
   `packages/electron/src/main.ts:736-739` now prefers the client SPA chat
   (`127.0.0.1:3890/chat`) whenever the Electron-spawned client server answers a health
   probe. Pre-migration, Electron always loaded the full host UI chat. The plan's own §12.2
   chat-parity contract (docs/technical/ui-runtime-modes-plan.md:877-899) gates replacing
   the host chat on six parity items — **the client chat is 0-for-6**, yet it is what users
   now see. Every gap in the client chat (voice, streaming, stop, history, markdown, copy,
   permission cards, tool log, notifications) thereby became a live regression. The full
   host chat still exists, works, and sits one port away (3880) — reachable only in failure
   modes.
2. **Admin unreachable from Electron (user report #2):** no tray item, no menu, no link in
   the client SPA, and no window path reaches `/host` on a healthy install. Admin
   reappears only when the client server *fails* (fallback lands on the host UI whose
   chrome has `/host` links). On the CLI side, `openpalm admin` opens the root URL which
   lands on `/chat`, and the old `/admin` URL is a deliberate 404 with no alias — so
   operators reasonably conclude admin is gone.
3. **Voice (user report #1):** the entire PR #554 voice stack survives intact in
   `packages/ui` but was never ported to `packages/client`, is not in `ui-kit`, and the
   client's own purity contract (`packages/client/tests/purity.test.ts`) currently makes a
   port architecturally impossible without new plumbing (a per-connection speak/transcribe
   edge). Meanwhile Electron still registers the global mic hotkey system-wide — it
   silently no-ops against the default window.
4. **Real release breakage:** `@openpalm/portal-sdk` was never added to the publish DAG and
   was never published — the 0.13.0-beta.1 portal adapters on npm are **uninstallable**
   (verified against the live registry). The packaged Electron app also ships no client
   artifact (electron-builder.yml lacks the extraResources entries the code expects), so
   the desktop app's primary surface depends on a runtime npm download.
5. **Three divergent env/port resolution chains** (Electron process-env vs CLI
   persisted-stack.env vs container entrypoint) produce "works in one surface, broken in
   another" bugs, including a browser-breaking `http://0.0.0.0:3800` seeded connection and
   `openpalm app` hard-failing (and orphaning two child processes) on exactly the installs
   the same release's headless-install flow creates.
6. **A LAN-exposure security regression (gap round):** with the single documented knob
   `OP_BIND_ADDRESS=0.0.0.0`, the stack now publishes an unauthenticated chat client on
   :3810 wired to an OpenCode API on :3800 with auth hard-disabled **and wildcard CORS**
   (`--cors *`) — any web page a LAN user visits can script the assistant cross-origin.
   Neither the published client port nor the CORS grant existed pre-migration.
7. **The new default surface shipped with zero browser/e2e test coverage** while the
   demoted host UI keeps its full Playwright suite — which is why every one of these
   regressions shipped silently and will keep shipping until a client e2e gate exists.

**The two highest-leverage fixes:** (a) flip the Electron default back to the host UI chat
(one branch in `resolveInitialUrl`) and gate the client chat behind an explicit opt-in until
the §12.2 contract passes; (b) publish `@openpalm/portal-sdk` / add it to the publish DAG
before the next cut. Those two changes resolve or defuse the majority of user-facing impact
while the client-parity work proceeds.

---

## Confirmed findings

Severity shown is the post-verification severity (verifiers downgraded several
"critical" claims to high/medium where the capability still exists on the host UI
fallback or the gap is documented deferred work).

### A. Root cause: surface routing & admin reachability

**A1. [HIGH] Electron prefers the feature-poor client chat over the intact host chat**
`packages/electron/src/main.ts:724-745`. Setup complete + client `/health` answers →
client chat; host chat only on probe failure. The probe is capability-blind (serve.mjs
SPA-fallbacks every path to 200) and the client build is auto-downloaded from npm each
launch, so the probe normally succeeds. Pre-migration Electron always loaded
`UI_PORT/chat`. Violates the plan's own parity gate (§12.2); introduced by `05086edf`.
**Fix:** invert the preference — land on `http://127.0.0.1:${UI_PORT}/chat` by default and
gate the client chat behind an explicit opt-in (env var / settings flag / tray toggle)
until each §12.2 item passes; keep the client server startup for opt-in testing. Add a
persistent "Open host app" link in `packages/client/src/routes/+layout.svelte`
(main.ts:781-787 already allows 127.0.0.1 window.open targets). Update
ui-runtime-modes-plan.md §7/§12.2 to state which surface Electron fronts.

**A2. [HIGH] Admin/host console unreachable from Electron in the normal state (user report #2)**
Tray menu (`packages/electron/src/tray.ts:111-145`) has no admin entry; client SPA nav is
only /chat + /connections with zero `/host`/3880 references; preload exposes no host-UI
IPC; no application menu; no URL bar. Admin is reachable from Electron only when the
client server fails. **Fix:** (1) add an "Open Admin Dashboard" tray item wired to
`http://127.0.0.1:${UI_PORT}/host`; (2) give the client SPA a way back — extend
`writeClientRuntimeConfig` with an optional `hostUrl` field (or a preload `getHostUiUrl()`
IPC) and render a "Manage assistant" link in the client layout; (3) add a regression test
asserting the tray template contains the host entry. Fixing A1 also restores in-app /host
links.

**A3. [MEDIUM] `openpalm admin` opens the root URL, which lands on /chat**
`packages/cli/src/lib/ui-server.ts:303,314,337` — `adminHostUi` only sets child env; the
opened/printed URL is the root, and the landing guard resolves a healthy install to
`/chat`. Combined with the alias-less `/admin` 404, this is user report #2 on the CLI
side. **Fix:** when `opts.adminHostUi` is true, open and print `${uiUrl}/host`
(one-line change at ui-server.ts:337 plus the log at :314).

**A4. [LOW] `openpalm app` opens the voiceless client chat and hard-exits if it's missing**
`packages/cli/src/lib/ui-server.ts:329-335` exits 1 instead of falling back to the
voice-capable host UI (asymmetric with Electron's fallback). **Fix:** fall back to opening
`uiUrl` and mention the host UI chat in the command output until parity lands.

### B. Chat feature parity — what the default surface lost

The client chat fails **all six items** of the ratified §12.2 chat-parity contract
(docs/technical/ui-runtime-modes-plan.md:877-886), and the decision issue the plan
requires ("file as its own issue", line 888) was never filed. [HIGH — checklist finding]
**Fix:** file the decision issue; treat the six items as the acceptance checklist for
making the client chat default; add a parity test pinning the contract.

**B1. [HIGH] Entire voice subsystem absent from the client chat (user report #1)**
Only voice-related content in `packages/client` is the comment "voice is host-app-only for
now" (`ChatInput.svelte:3`). No dictation mic, no conversation mode (VAD, barge-in,
earcons, calibration), no TTS auto-speak / streaming sentence TTS, no per-message speak, no
VoiceStatusStrip, no global-mic-hotkey handler. The full stack lives intact only in
`packages/ui/src/lib/voice/*` + chat components; ui-kit has no voice modules.
docs/technical/ui-runtime-modes-plan.md §12.1-12.2 documents the gap; the parity decision
was never made. **Fix:** execute the §12.2 decision — either port the stack (see B10 for
the structural blocker and the concrete path) or ratify "voice is host-chat-only" AND stop
routing users to the client chat by default (A1). Short-term: A1 alone restores voice for
desktop users.

**B2. [HIGH] No live SSE streaming — replies invisible until the turn completes (or 150s timeout)**
Transport has no `/event` subscription (`packages/client/src/lib/transport/index.ts:49-54`);
`sendMessage` awaits the full response under `AbortSignal.timeout(150_000)`; the page shows
only "Thinking…". No reconnect/Last-Event-ID recovery. **Fix:** add
`subscribeEvents(handlers)` (GET `${base}/event`, reuse `parseSseStream`, port
backoff/Last-Event-ID from `packages/ui/src/lib/chat/session-events.ts`); port
`extractTextDelta`/`isTurnEnd` from `oc-events.ts`; render incremental pending text.

**B3. [HIGH] No stop/cancel for in-flight turns; composer fully locked while sending**
No `abortTurn` in the transport, no stop button, textarea `disabled={sending}`
(`ChatInput.svelte:55`). Old chat had stop-generation + draft-while-sending. **Fix:** add
`abortTurn(sessionId)` (POST `/session/{id}/abort`); pass a caller-owned AbortController
into `sendMessage`; thread `onStop` through ChatInput; gate only submission, not typing.

**B4. [HIGH] Permission requests and assistant questions are unanswerable**
Any permission-gated tool use or structured question wedges the turn for 150s then errors —
no PermissionCard/QuestionCard, no reply path, though guardian relays the ask flow
(`guardian/src/proxy.ts:273-338`). Tool-permission workflows are effectively broken for app
users. **Fix:** after B2 lands, surface PermissionCard/QuestionCard (move to ui-kit or copy)
and add `replyPermission`/`replyQuestion`/`rejectQuestion` transport methods mirroring
455d8728 `packages/ui/src/lib/api/chat.ts:140-166`.

**B5. [HIGH] Session history not ported — old sessions open empty; reload discards the live transcript**
`selectSession` sets `turns=[]` + a disclaimer (`+page.svelte:57-64`); no
message-history method on the transport; turns are component-local state. **Fix:** add
`getSessionMessages(sessionId)` to the transport; port `flattenSessionMessages` from
`packages/ui/src/lib/chat/session-messages.ts`; call from `selectSession()` and on mount.

**B6. [MEDIUM] Markdown/code rendering lost — replies render as plain pre-wrapped text**
`ChatTurn.svelte:33` renders `<p>{text}</p>`; no markdown dep in the client. **Fix:** port
`packages/ui/src/lib/markdown` (markdown-it, html:false) into client or ui-kit and render
via `{@html renderMarkdown(text)}` with the old escaping guarantees.

**B7. [MEDIUM] Copy affordances lost (message-copy + per-code-block copy)**
Zero clipboard code in the client. **Fix:** port `copyMessage` and `decorateCodeCopy` from
`packages/ui/src/lib/components/chat/ChatMessage.svelte` (code-block half depends on B6).

**B8. [MEDIUM→HIGH] Composer resilience lost: IME guard, draft-while-sending, failed-send retry — plus focus destruction on every send**
No `e.isComposing` guard — Enter during CJK/Japanese/Korean composition **submits the
half-composed message** (the old component added this guard deliberately in `71f1ebc7`
with a regression test; the client copy silently dropped it — independently re-confirmed
by the a11y gap round at high severity). The `disabled={sending}` textarea also destroys
keyboard focus to `<body>` on every send with no restore (WCAG 2.4.3 — keyboard/SR users
re-Tab the whole page after each message), blocks drafting, and failed sends leave a
misleading transcript entry with no retry/reconnect. **Fix:** add
`if (e.isComposing) return;` as the first line of `handleKeydown`
(`ChatInput.svelte:18`) and port the isComposing unit test; replace `disabled={sending}`
with a submit-block derivation (restoring draft-while-sending and focus); on failure
drop/mark the optimistic turn, keep `lastFailedText`, add retry + reconnect actions
(mirror 455d8728 `chat-state.svelte.ts:683-780`).

**B9. [MEDIUM] Tool-activity visibility lost (no ToolLog rail / live tool states)**
Long tool-running turns are an opaque, uninterruptible wait (combined with B3). **Fix:**
after B2, port ToolLog/ToolStrip and populate from tool events (455d8728
`chat-state` pendingToolStates).

**B10. [MEDIUM] Structural blocker for any voice port: voice isn't in ui-kit and the client purity gate forbids the voice endpoints**
`packages/client/tests/purity.test.ts:32` forbids `/api/host` markers in the bundle;
`packages/ui/src/lib/api/voice.ts` calls `/api/host/voice`, `/api/transcribe`,
`/api/speak`; the SPA has no server routes to receive them. "Just copying the components"
cannot work. **Fix (design first):** (1) move browser-pure voice modules (vad, earcon,
audio-playback, sentence-stream, speakable-text, media-recorder, state machine) into
ui-kit or a new `@openpalm/voice` package; (2) add speak/transcribe to the per-connection
edge (guardian) and a `voice` block to `writeClientRuntimeConfig`; (3) keep engine CONFIG
host-only (`/api/host/voice` legitimately stays). Spell this constraint out in the §12.2
decision issue.

**B11. [MEDIUM] Electron voice plumbing dead against the default window**
Global mic hotkey (Ctrl/Cmd+Shift+M) still registered **system-wide** (steals the chord
from other apps) but no-ops — the only consumer of `global-mic-toggle`,
`set-tray-mic-recording`, and `request-mic-permission` IPC is `packages/ui`'s
VoiceControl. The macOS TCC mic-permission flow has no caller on the default surface.
**Fix:** skip `registerGlobalMicShortcut()` (and hide mic tray affordances) when the window
resolved to the client URL — or make the hotkey navigate to the host chat and toggle the
mic; add all three harness integrations to the §12.2 contract.

**B12. [MEDIUM] Desktop notifications for replies/errors lost on the default surface**
Client SPA never calls the notify bridge; close-to-tray is the app's resting state, so
long tasks complete silently. (Electron-only loss; opt-in feature.) **Fix:** port
`packages/ui/src/lib/desktop-notifications.ts` (feature-detect `window.openpalm?.notify`,
add a web Notification fallback) and call on reply completion/error; surface update
availability via a client banner or tray item.

**B13. [MEDIUM] Autoscroll/follow-state lost: client force-scrolls to bottom**
Unconditional `scrollTo` yanks the viewport if the user scrolled up; no jump-to-latest
pill; no reduced-motion handling. Becomes load-bearing once B2 lands. **Fix:** port
`packages/ui/src/lib/chat/autoscroll.ts` (pure, unit-tested) + the jump pill.

**B14. [LOW→MEDIUM] No session management on narrow screens — and no keyboard/AT path either**
The sessions sidebar (new-chat button, session list, connection label) is `display:none`
below 44rem with no toggle — unreachable by mouse, touch, keyboard, or screen reader
(WCAG 1.4.10 reflow loss; the a11y gap round independently confirmed this at medium). The
old chat solved exactly this with a focus-trapped, Escape-closable garden-veil dialog.
**Fix:** small-screen sessions drawer modeled on the old veil (aria-haspopup/expanded,
aria-modal, focus trap, inert background) — requires making the focus-trap primitives
available to the client (see G-K14 ui-kit contract finding).

**B15. [LOW] In-chat endpoint switching, "manage this assistant" shortcuts, /advanced entry lost**
Switching assistants costs a page nav that (per B5) destroys the transcript; /advanced is
unreachable from the client. **Fix:** post-parity: in-chat connection switcher preserving
per-connection session state; decide whether /advanced stays host-only and link it for the
local assistant.

**B16. [LOW→MEDIUM] Theme frozen at page load: no manual toggle AND no live system-theme subscription; visibility-change reachability probe also lost**
`app.html`'s boot script is a one-shot IIFE — OS-scheduled dark-mode changes (sunset
auto-switch) are ignored mid-session with no in-app recovery, and stale theme-color metas
mismatch the PWA chrome (gap round upgraded this: the old app subscribed to
`prefers-color-scheme` changes). No `visibilitychange` health/session refresh either.
**Fix:** add a `matchMedia('(prefers-color-scheme: dark)')` change listener re-running the
resolve/apply logic when the stored preference is 'system'; theme toggle in the layout
writing `openpalm.theme`; visibilitychange handler calling `probeHealth()` + session
refresh.

### C. Release & packaging breakage

**C1. [HIGH] Published 0.13.0-beta.1 portal packages are uninstallable — `@openpalm/portal-sdk` missing from the publish DAG and never published**
Verified against the live registry: `@openpalm/portal-sdk` → E404; the published
`@openpalm/{discord,slack}-portal@0.13.0-beta.1` pin `@openpalm/portal-sdk@0.12.52`.
Operators advancing `OP_HOME/data/portal/tools/package.json` get a hard portal cold-start
failure (`containers/portal/start.sh:26-29`); the next stable 0.13.0 cut ships the same
uninstallable artifacts; the seeds' `^0.12.0` range silently never delivers 0.13.x
adapters. **Fix:** (1) add an `npm-portal-sdk` job to release.yml (exact-version,
`needs`-ed by the portal jobs and tag-release); (2) add portal-sdk to `units.portals` in
release-package-groups.json and `UNITS.portals.stamp` in bump-unit.mjs; (3) publish
`@openpalm/portal-sdk@0.12.52` immediately (or cut 0.13.0-beta.2 adapters) to unbreak the
already-published beta; (4) advance the seed ranges at release time; (5) add a static test
asserting every `workspace:*` dep of a published package is itself in the publish DAG.

**C2. [MEDIUM] Packaged Electron app ships no client artifact — electron-builder.yml lacks the extraResources the code expects, and the release job never builds the client**
`packages/electron/electron-builder.yml:15-23` lists only ui-build/admin-tools/skeleton;
`client-assets.ts:79-84`'s bundled channel is dead wiring; `resources/bin/serve.mjs` is
also unpackaged. Offline/firewalled fresh installs (or any npm outage) permanently run the
fallback host UI with no indication. **Fix:** add
`{from: ../../packages/client/build, to: client-build}` AND
`{from: ../../packages/client/bin, to: bin}` extraResources; build the client in the
electron release job (+`needs: npm-client`); add a static test pinning the
electron-builder.yml entries.

**C3. [LOW] Client artifact never seeded at install and never refreshed by `openpalm update` — `seedClientBuild` is dead code**
UI artifact is seeded at install; the client is only fetched lazily at serve time.
Air-gapped installs never get it; `openpalm update` prints "Update complete" while the
client stays stale. **Fix:** call `seedClientBuild` in `prepareInstallFiles` beside
`seedUiBuild`; add `checkAndUpdateClientBuild` to `runUpgradeAction`.

**C4. [LOW] `d8b3fe04` "stamp all to 0.13.0-beta.1" missed packages/ui-kit — it belongs to no release unit, so drift is CI-invisible**
ui-kit sits at 0.12.52. Not load-bearing today (private, workspace:* raw source) but
misleads debugging and any future publish. **Fix:** add ui-kit to `UNITS.platform.stamp`
and `units.platform`; optionally commit a lockfile-only update with stamps.

### D. CLI / serving correctness

**D1. [HIGH] `openpalm admin`/`openpalm app` silently attach to an already-running non-admin instance; EADDRINUSE child death reported as success; uncapped client respawn loop**
Readiness is a bare port poll (200 **or** 401) with no instance-identity check and no race
against child exit (`ui-supervisor.ts:63-68,300-307`). With a bare `openpalm` serve already
on 3880, `openpalm admin` reports success, opens a UI without admin capability, and leaves
a respawn loop logging every second. Directly produces "admin UI is missing" on CLI hosts.
**Fix:** pre-spawn probe; if the port answers, fetch `/api/runtime` and compare `hostMode`
(reuse only on match, otherwise a clear error); race `exited` against `waitForReady`; cap
and back off the client-server respawn loop.

**D2. [HIGH] `openpalm app` exits 1 on installs with a persisted OP_HOST_CLIENT_PORT (the documented headless flow) and orphans both spawned children**
`client-server.ts` resolves the serve port from persisted stack.env + process.env, while
`ui-server.ts:304` builds the probe URL from `process.env` only — fresh shell: serves on
9392, probes 3890, times out, `process.exit(1)` without stopping the client handle or
supervisor. **Fix:** one authoritative resolver (export the merged-env port resolution
from client-server.ts, or return the resolved port on the handle) used for the probe URL;
stop both children on the failure path. Mirror the merged-env read in Electron (see F2).

**D3. [MEDIUM] Persisted OP_HOST_UI_PORT written at install but never read back by any host server**
Headless install persists it; later `openpalm`/`openpalm admin`/Electron serve on 3880
anyway, contradicting `manual-headless-install.md:212-221` (shipped in the same fix
commit). It is the only persisted key nothing reads back. **Fix:** resolve the UI port
through persisted stack.env (mirror client-server.ts's merge) in ui-server.ts and
Electron main.ts.

**D4. [LOW] `openpalm client-serve` run directly serves on 4180 (serve.mjs fallback), not the platform's 3890**
Only the direct foreground invocation diverges — 4180 appears nowhere else in the repo.
**Fix:** default `process.env.PORT ??= String(resolveClientAppPort(process.env))` in the
command before importing serve.mjs; consider aligning serve.mjs's own fallback to 3890.

### E. Transport, connections & endpoint resolution

**E1. [MEDIUM] Assistant endpoint resolution diverges across Electron, CLI, and container — including a browser-breaking `http://0.0.0.0:3800` seed from Electron**
Three override chains read three env views. The admin UI's LAN-exposure toggle writes
`OP_ASSISTANT_BIND_ADDRESS=0.0.0.0`; Electron then seeds the locked default connection as
`http://0.0.0.0:3800` (test-pinned!), which browsers can't fetch; CLI ignores
OP_OPENCODE_URL/OP_ASSISTANT_URL that the host UI honors. Produces "chat works in one
surface but not another". **Fix:** one shared `resolveAssistantEndpoint(homeDir, env)` in
@openpalm/lib implementing `OP_CLIENT_DEFAULT_ASSISTANT_URL || OP_OPENCODE_URL ||
OP_ASSISTANT_URL || http://127.0.0.1:${port}` over `readStackEnv`, always normalizing
wildcard hosts to 127.0.0.1 for browser-facing URLs (reuse `normalizeLoopbackUrl`); call it
from all three writers.

**E2. [MEDIUM] Electron resolves the client port from process.env only while the CLI merges persisted stack.env — OP_HOST_CLIENT_PORT override breaks Electron client CORS**
CLI-served client + container CORS allowlist agree on the custom port; the Electron-served
client stays on 3890 — an origin OpenCode wasn't started with — so every chat request fails
preflight. Finder-launched Electron has a minimal env, making stack.env the only realistic
override channel. **Fix:** merge `parseEnvFile(knowledge/env/stack.env)` under process.env
before `resolveClientAppPort` in Electron main.ts.

**E3. [MEDIUM] Direct-from-browser transport silently breaks remote connections lacking CORS config — and the health badge can't distinguish CORS block from downtime**
Guardian defaults to deny-all origins; the client's `authorization` header forces
preflight; a CORS-blocked fetch surfaces as bare "unreachable". (The host-UI server-side
broker still exists, so old setups keep working there.) **Fix:** detect the CORS case in
`probeHealth` and show a distinct "blocked (CORS)" state with remediation text; document
`GUARDIAN_CORS_ALLOWED_ORIGINS` as required when sharing a guardian with browser clients;
consider keeping an optional same-origin proxy path for host-served modes.

**E4. [MEDIUM] Tray "Open Local App" opens a hardcoded client URL with no health check**
ERR_CONNECTION_REFUSED page whenever the client server isn't running (build missing, child
crashed — it isn't respawned). Same for the /host "Install OpenPalm app" button inside
Electron. **Fix:** guard `openLocalApp` with a quick probe (fall back to the host chat or
notify); rebuild the tray menu with the item disabled while `clientProcess` is null.

**E5. [LOW] Transport discards server error bodies — errors regress to "HTTP <status>"**
Guardian/OpenCode structured errors (e.g. `cors_origin_denied`, provider auth failures)
are thrown away. **Fix:** on `!response.ok`, read the body (prefer `message`/`error` JSON
fields, else trimmed text), mirroring the old `readErrorMessage`.

**E6. [LOW] Locked seeded connections can never carry credentials**
Runtime-config hardcodes `auth: none` + `locked: true`; the store/UI forbid editing locked
entries — an auth-fronted default assistant URL permanently 401s with no UI path to supply
credentials. **Fix:** allow attaching/clearing a secretRef on locked entries (narrow
`setSecretRef` that bypasses the locked check), or a "Set credentials" affordance that only
writes the secret store.

**E7. [LOW] Connection passwords/tokens stored as plaintext JSON in IndexedDB**
Readable by any same-origin script; the old design kept credentials server-side (0600
endpoints.json — that path still exists for the host UI). Some browser storage is inherent
to the no-server SPA; plaintext-in-IDB is the weakest variant. **Fix:** wrap secrets with
WebCrypto (non-extractable AES-GCM key stored as a structured-clone key object; ciphertext
in meta); document residual exposure in the form copy.

**E8. [LOW] Basic-auth header built with `btoa()` throws on non-Latin-1 passwords**
Synchronous InvalidCharacterError before any I/O; probe reports "unreachable". Old broker
used UTF-8 Buffer encoding. **Fix:** UTF-8-encode before base64 in `authorizationHeader()`.

**E9. [LOW] /connections edit form silently ignores a changed Basic-auth username unless the password is retyped**
Can also silently revert a custom username to the `openpalm` default → hard-to-diagnose
401s. **Fix:** load stored material into the edit form; preserve the unedited half when
rewriting the secret.

### F. Stale references, docs & spec drift

**F1. [MEDIUM] Shipped assistant skill instructs calling the dead `GET /admin/config/validate` (404 since the rename)**
`packages/skeleton/knowledge/skills/config-diagnostics/SKILL.md` (4 references) ships to
user installs and drives the "why isn't my AI connection working?" flow. **Fix:** update to
`/api/host/config/validate`; add skeleton knowledge to an admin-paths hygiene sweep test so
shipped skills can't reference dead routes again.

**F2. [MEDIUM] api-spec.md documents 14+ endpoints that don't exist at HEAD and mis-describes the secrets write API**
The Phase 4 rename was applied textually without verifying existence (network/check,
automations/catalog*, artifacts*, audit, secrets/generate, opencode/providers collection,
etc.); secrets docs claim POST on a GET-only collection route. **Fix:** prune/correct; better,
generate the endpoint inventory from `packages/ui/src/routes` (the guard-hygiene test
already walks it) and reduce api-spec.md to per-endpoint payload docs.

**F3. [LOW] ui-runtime-modes.md overstates security enforcement and the Electron serving model**
Claims client-side HTTPS enforcement that is unshipped Phase 6.5 work (the flag has zero
consumers); describes the pre-P5c Electron model, masking exactly the regression users
hit. **Fix:** correct the security bullet (guardian CORS allowlist is the only shipped
enforcement) and the electron-host row (window fronts the client chat at 3890; host app at
3880 reachable only by URL — or update after fixing A1/A2).

**F4. [LOW] Stale-comment/doc sweep needed after the /admin→/api/host rename**
Dead `/admin/voice`, `/admin/providers/import-host`, `PATCH /admin/versions`,
`GET /admin/automations`, `/splash` references and a self-contradicting harness-contract
header survive across packages/electron, packages/ui, packages/lib, playwright config, and
two design docs — especially misleading for the voice-restoration work above. **Fix:**
one-time sweep (12 files listed in the finding); extend the admin-paths hygiene test's
scope.

**F5. [LOW] Plan §10/§12 handoff is stale in the completed direction — five "open" items are already done at HEAD**
Locked-entry pruning, boot storage-failure fallback, storage typing, kit CSP, and the
skeleton-pin advance are done but listed open — inviting duplicate work. **Fix:** refresh
§10/§12 with commit pointers, leaving the true remainder (hosted origin, pairing,
HTTPS-refusal UX, TLS guide, Slice B, chat-parity port).

**F6. [LOW] Known-deferred Phase 6–8 scope users may misreport as regressions (deliberate, scheduled — distinct from everything above)**
Assistant-settings editing from the container surface, phone/hosted install
(app.openpalm.dev), pairing/QR, protocol validation, TLS guide. **Fix:** add a short
"not yet shipped" section to ui-runtime-modes.md naming them; keep on the Phase 6/6.5
backlog (#511, #557).

---

## Gap-round findings (5 follow-up finders dispatched by the completeness critic)

The gap round also independently re-confirmed A1/A2 (Electron routing/admin — its G2
finding matched the same root cause), B8 (IME guard, upgraded), B14 (mobile sessions,
upgraded), and B16 (theme, upgraded); those are merged above rather than repeated.

### G. Accessibility & test coverage (new default surface)

**G1. [HIGH] Client chat never announces assistant replies to screen readers — live-region subsystem lost**
The `.thread` div has no `role="log"`/`aria-live`; ChatTurn nodes append outside any live
region; the sole live region is the transient "Thinking…" note removed before the reply
renders. Old chat wrapped the streamed reply in `aria-live="polite"`. Combined with B2
(no streaming, up to 150s blocking sends), an SR user gets a silent multi-minute wait
with no completion signal — WCAG 4.1.3 failure on the primary flow. **Fix:** add
`role="log"` + `aria-label="Chat history"` to the thread container; keep a persistent
status element mounted and swap its text (mirror the s-pending/s-loading pattern from
`packages/ui/src/routes/chat/+page.svelte:479-521`); render pending streamed text inside
the live region once B2 lands.

**G2. [HIGH] Zero browser/e2e test coverage for the new default surface — while the demoted host UI keeps its full Playwright suite**
`packages/client` has only 10 bun unit tests; no Playwright, no DOM rendering of any
component; CI gives the client only typecheck + build + unit tests. Every regression in
this audit shipped without a test able to catch it — this guarantees continued silent
feature loss. **Fix:** add a Playwright project to packages/client (chat round-trip
against a stubbed transport with live-region + focus assertions; connections add/edit
with Escape/focus assertions; keyboard-only traversal at desktop and 375px;
`@axe-core/playwright` scan of /chat and /connections); wire into ci.yml after the
client build step and into the browser-tests job.

**G3. [MEDIUM] Connections add/edit form drops keyboard focus to `<body>` on open/cancel/save; no Escape, no focus trap — and the client structurally cannot reuse ui-kit's accessible Drawer**
This form is the first-run onboarding flow (/ → /connections/new → auto-opened form).
ui-kit's Drawer imports `$lib/actions/focus-trap.js` — an app-provided contract the
client doesn't fulfill, so the project's accessible dialog primitives are unusable from
the client (this also blocks the B14 fix). **Fix:** short-term, focus the first field on
open, restore focus to the invoker on cancel/save, add Escape handling. Structurally:
promote focus-trap into ui-kit as a real export (`./actions/*` subpath) or give
packages/client the `$lib` contract modules.

**G4. [MEDIUM] Session list rows lost `aria-current`; credentials badge invisible to screen readers**
Active session conveyed by border color only (WCAG 4.1.2/1.4.1 — old SessionList had
`aria-current` plus an sr-only "(current)" suffix); the connections lock badge is an
icon-only span with a hover title. **Fix:** add `aria-current` to the session button
(`+page.svelte:138-143`); give the lock badge an sr-only label or `aria-label` with
`role="img"`.

### H. PWA / service-worker hazards

**H1. [MEDIUM] Service-worker runtime cache serves stale assistant API data and masks outages for the default (unauthenticated) connection**
The `openpalm-public-get` NetworkFirst rule (`vite.config.ts:58-83`) caches any
unauthenticated GET with no expiration and no networkTimeoutSeconds — after any healthy
period, an assistant outage is invisible: cached health probes keep the badge
"reachable" and cached session lists render, but sends fail. Applies inside Electron
too (127.0.0.1 is a secure context; the SW persists in the profile). Latent hazard: the
rule would also match a future unauthenticated SSE endpoint and try to cache an infinite
event-stream body. **Fix:** scope the rule to app-shell-adjacent static content, or add
`networkTimeoutSeconds` + ExpirationPlugin, exclude `Accept: text/event-stream`, and
make `probeHealth` cache-proof (`cache: 'no-store'` or a header the urlPattern rejects);
re-pin `pwa-config.test.ts` on the exclusions.

**H2. [MEDIUM] serve.mjs answers missing build assets with 200 index.html — the SW precaches HTML as JS and durably corrupts installs**
A non-atomic artifact swap/seed (`client-assets.ts` `copyTree` has no destination
clearing) or any partial copy converts into a permanently broken client: the SW caches
index.html under a chunk URL until a byte-different sw.js arrives; the unconditional-200
contract is even test-pinned. **Fix:** restrict the SPA fallback to navigation-style
requests (Accept text/html or extensionless path), 404 otherwise; `cache-control:
no-cache` for index.html/sw.js/registerSW.js; update `serve.test.ts` accordingly.

**H3. [LOW] Installed/cached client PWA can pin a stale or dead build — `openpalm update` never refreshes the host client artifact and there is no cache-escape affordance**
Extends C3: blocked-major updates are fully silent, no SW/cache reset exists anywhere
(no `clearStorageData` in Electron, no reset action in the client). **Fix:** add the
client step to `runUpgradeAction` (C3), surface the blocked-major case, add a "reset app
cache" action (unregister SW + caches.delete + reload), and clear the client origin's SW
in Electron when the resolved build version changes.

**H4. [LOW] The PWA install surface offers only the feature-poor client with no route to setup, admin, or voice**
Standalone display hides the URL bar, so the installed app can't navigate to the host UI
at all; Google-hosted fonts also aren't precached (offline typography loss). Documented
reduced scope, but the escape hatch is missing. **Fix:** include the host UI URL in
runtime-config.json and render an "Open OpenPalm admin/setup" link (target=_blank works
from standalone), or gate installability until parity; self-host the fonts.

### I. Container / compose runtime & security

**I1. [HIGH] Release DAG lets an assistant image ship whose baked PLATFORM_VERSION has no published @openpalm/client/@openpalm/skeleton — a `unit=assistant` release bricks fresh-boot client install and retags `:latest`**
`docker-assistant` needs only `[compute-version, bump]` — no ordering after npm-client /
npm-skeleton, and nothing restricts image-producing units to versions that exist on npm.
Running the existing assistant unit today produces `openpalm/assistant:0.13.1` (+
`:latest`) whose every fresh boot runs `npm install @openpalm/client@0.13.1` → E404
(verified live: neither package has 0.13.1) → no chat surface on 3810, silently
(see I2). Pre-#559 this failure class was invisible; now it's the primary user surface.
**Fix:** add npm-client/npm-skeleton to docker-assistant's `needs` (with unit-tolerant
`if`s); for unit=assistant/images resolve PLATFORM_VERSION from the last *published*
platform version; add a preflight step failing the build if
`npm view @openpalm/client@$PLATFORM_VERSION` 404s.

**I2. [MEDIUM] Compose chat surface can silently not exist: boot-time npm install of @openpalm/client has no fallback artifact, no healthcheck coverage, and no co-process supervision**
Offline/air-gapped/proxied first boot or npm outage → install fails, `start_client`
returns 0, stack reports healthy, port 3810 published with nothing listening; serve.mjs
crash also goes unnoticed until container restart. **Fix:** bake a fallback client into
the image (Dockerfile stage + `start_client` fallback); extend the compose healthcheck to
probe the client; supervise/respawn the co-process in entrypoint.sh (the host-side
client-server already does).

**I3. [MEDIUM] LAN exposure regression: `OP_BIND_ADDRESS=0.0.0.0` now publishes an unauthenticated chat client AND gives OpenCode `--cors *` with auth disabled**
Pre-migration, no client port was published and OpenCode had zero `--cors` flags; the
only LAN web UI had password login. Now any internet page a LAN user visits can script
the assistant API cross-origin (drive-by command of an agent with tool/file access). The
client also ignores its own declared HTTPS-for-remote rule (`features.ts:130` has zero
consumers) while storing credentials in plaintext IndexedDB (E7). **Fix:** never emit
`--cors *` — require explicit origins via the already-supported
OP_CLIENT_CORS_ALLOWED_ORIGINS; enforce (not just warn) auth or refusal when the bind
address is non-loopback; enforce the HTTPS-for-remote rule in the connections form and
transport; fix E7 or document TLS as a hard requirement for LAN client deployments.

**I4. [LOW] Client guardian/remote-connection path is dead-on-arrival in the shipped compose stack**
`GUARDIAN_DIRECT_INGRESS=false` and an empty CORS allowlist default off
(`portals.compose.yml:114-115`), so every guardian connection a browser user adds fails
(404 when ingress off; CORS-denied even when on) with no error naming the two env vars — the
only working default browser path is the auth-less direct OpenCode connection, while the
assistant entrypoint *does* auto-seed OpenCode CORS for the client origins (the asymmetry).
**Fix:** default `GUARDIAN_CORS_ALLOWED_ORIGINS` to the shipped client origins as the
assistant entrypoint already does; make the client probe distinguish "CORS denied / ingress
disabled" and link the knobs; document both in environment-and-mounts.md.

**I5. [LOW] Two divergent writers of the client `runtime-config.json` use different locked-connection ids**
Entrypoint inline JS writes id `assistant-container-opencode`; the lib helper writes
`openpalm-assistant-opencode`. Harmless today (distinct origins, IndexedDB per-origin
isolation) but any schema evolution in the lib writer silently never reaches the container
path, and any future shared origin makes the seeder delete/replace the other writer's locked
entry every boot. **Fix:** share the id/label constants (+ a static test asserting the
entrypoint contains the exported id), or generate the file from one place.

### J. First-run onboarding & landing-matrix interplay

**J1. [MEDIUM] `openpalm app` is setup-unaware — an interrupted install opens the client chat wired to a dead assistant**
`setup_incomplete`/`installed_offline` installs get a served client chat that only shows
"Could not load sessions", with no redirect to `/setup`, no "finish setup" affordance, and
no stack-start attempt — the host landing matrix that routes these states is never consulted
because the browser points straight at the client origin. **Fix:** in `startUIServer`, probe
`/api/setup/status` before honoring `openTarget: 'client'` and open `${uiUrl}/setup` when
incomplete (as Electron does at main.ts:728-733); longer term give the client a "needs setup
/ offline" state with a host-UI link.

**J2. [MEDIUM] Electron's default surface bypasses the landing matrix's recovery branches**
A stopped/crashed/unhealthy stack at launch (routine post-reboot) lands Electron in a dead
client chat instead of `/host` (installed_offline) or `/host?tab=diagnostics`
(installed_broken) — and with no tray/menu path to admin (A2), there's no recovery. The
migration built these branches (`resolve-landing.ts:65-66`) then made the default surface
structurally unable to trigger them. **Fix:** add an unauthenticated `GET /api/runtime/landing`
returning the resolver's path; have `resolveInitialUrl` load `${UI_PORT}${landing}` whenever
it isn't `/chat` — covers setup_incomplete/offline/broken and future migration gates with one
probe.

**J3. [LOW] Blocking-migration gate is dead code and structurally bypassed**
Nothing produces `pending`, `/attention` is unreachable, and the landing guard only covers
host-UI navigations to `/` — so the FIRST real blocking OP_HOME migration will let Electron,
`openpalm app`, and `/chat`-bookmark users operate against a mid-migration stack with no
`/attention` screen (the silent-data-damage scenario the page exists to prevent). **Fix:**
before the first real migration, make the gate block `/chat`/`/connections`; expose migration
status in a machine endpoint consulted by Electron and `openpalm app` (same vector as J2); add
a hooks test that a pending migration diverts `/chat`.

**J4. [LOW] Setup-wizard completion screen's "Admin Dashboard" button lands on /chat**
`DeployStep.svelte:250` points its admin affordances at `/` (→ /chat for a running stack), not
`/host` — confusion at the exact moment users first look for the dashboard (compounds A2/A3).
This is a *pre-existing* mislabel the migration preserved (the `/admin`→`/host` rename made it
wrong), not newly introduced; the dashboard is still reachable via the chat settings drawer.
**Fix:** point both affordances at `/host`.

### K. Host-UI self-parity (did the surviving surface itself regress?)

**K1. [LOW] `/host` admin surface lost the global voice controls and Advanced-mode switch that `/admin` had**
`/host` mounts the bare `Navbar` (not `ChatNavbar`), so the mic/speaker/stop controls and
Chat/Advanced switch are gone; since `voiceState` is module-level and audio survives SPA nav,
TTS started in chat keeps playing on `/host` with no way to stop it there. Partly intentional
(chrome-untangle hygiene forbids chat imports in the admin bundle) and TTS is still stoppable
via the Voice settings tab — hence low. **Fix:** add a speaker/stop control to the host navbar
so in-flight TTS is controllable from the dashboard.

**K2. [LOW] Capability-driven chrome initializes only in `onMount` — SSR HTML lost the admin button; AkmTab captures capabilities non-reactively**
Pre-migration the layout ran `featuresService.init` in the script body (executes during SSR),
so the admin button was in SSR HTML; at HEAD `initializeRuntimeContext` runs only in `onMount`,
giving a flash-of-missing-chrome on every full load, and `AkmTab`'s `hostMaintenance` is
captured non-reactively (latent staleness). **Fix:** initialize the SSR-safe server half of the
runtime context synchronously during layout init; make the AkmTab capability read `$derived`.

**K3. [LOW] `hooks.server.ts` dropped the setup-complete memoization — sync filesystem probes now run on every request**
`isSetupComplete` + `classifyLocalInstall` (multiple `existsSync`/`readFileSync` + dotenv
parses) now run on every request including `/api/*`, `/proxy/*`, and the host UI's 10s poll;
the pre-migration memo (false→true) and 5s launch cache were dropped (introduced by `b629dc56`
on the PR branch). **Fix:** restore the setup-complete memo and route `classifyLocalInstall`
through the existing 5s launch cache.

---

## Recommended fix sequence

**Wave 0 — stop the bleeding (small diffs, big user impact):**
1. A1: flip Electron's default surface back to the host chat; client chat behind opt-in.
2. A2(1): tray "Open Admin Dashboard" item. A3: `openpalm admin` opens `/host`.
3. C1(3): publish `@openpalm/portal-sdk` (or beta-2 adapters) to unbreak npm artifacts.
4. B11 short-term: don't register the global mic hotkey when fronting the client URL.
5. A4: `openpalm app` falls back to the host UI instead of exit(1).

Also in Wave 0, gate the LAN-exposure security regression: **J3** — stop emitting
`--cors *` and force auth (or refuse to start) when the assistant binds non-loopback.

**Wave 1 — release/DAG correctness (before the next cut):**
C1 (DAG + stamp + seed ranges + workspace-dep static test), **I1** (docker-assistant needs
npm-client/npm-skeleton + published-version preflight — same class as C1), C2 (electron
packaging), C4 (ui-kit stamping), C3 (install/update seeding).

**Wave 2 — CLI/env & runtime correctness:** D1, D2, D3, E1, E2, E4, D4; **J1/J2**
(setup-aware `openpalm app`/Electron landing), **I2** (compose client fallback +
healthcheck + supervision), **H2** (serve.mjs 404 for missing assets), **K3** (restore the
hooks memo).

**Wave 3 — client chat parity (the §12.2 program, gated by the decision issue):**
B2 (events/streaming) → B3 (stop) → B5 (history) → B6/B7 (markdown/copy) → B8 (composer:
IME guard + focus + retry) → B4 (permission/question cards) → B9 (tool log) → B13
(autoscroll) → B12 (notifications) → B14-B16. Accessibility rides along: **G1** (live
region), **G4** (aria-current/badge), **G3** (form focus trap — needs the ui-kit
`$lib`/focus-trap contract), **G2** (add the client Playwright/axe suite — do this early so
the rest is guarded). Voice: B10 design (voice package + per-connection speak/transcribe
edge) then B1 port — or ratify host-only voice and keep A1's routing.

**Wave 4 — hygiene & polish:** F1, F2, F3, F4, F5, F6, E5-E9; **H1/H3/H4** (SW cache
scope, staleness escape, PWA host-UI hatch), **I4/I5** (guardian CORS defaults, unified
runtime-config writer), **J4** (setup wizard → /host), **K1/K2** (host navbar voice
controls, SSR chrome), plus the parity-contract pin test.

---

## Refuted claims (verified NOT issues — don't re-report)

1. **"Container chat surface downgraded from full UI with voice"** — the container UI
   co-process was never user-reachable (no published port, login impossible in-container);
   PR #559 removed no working capability there.
2. **"Admin 'latest versions' endpoint not extended for @openpalm/client"** — the endpoint
   is dead surface (its only caller has zero consumers); the real update path
   (`checkAndUpdateClientBuild`) resolves and applies npm latest.
3. **"Chat deep links (?session=/?new=1) lost"** — the host chat still honors both; nothing
   anywhere generates those links into the client SPA.
4. **"sendMessage's SSE branch truncates streamed replies"** — code reading accurate, but no
   component in this stack answers the message POST with SSE (guardian documents it as
   blocking); no user impact.

## Coverage notes

- **First wave:** 8 dimensions × independent reviewers → 72 raw findings → 48 after dedup →
  44 confirmed by adversarial verification, 4 refuted, 0 verification failures.
- **Gap round:** a completeness critic dispatched 5 follow-up finders (accessibility &
  test coverage, PWA/service-worker, container/compose runtime, first-run onboarding/landing
  matrix, host-UI self-parity through the 355-file packages/ui churn). Each finding was
  verified the same way. It confirmed **25** findings — 20 distinct new ones (sections G–K)
  and 5 that independently re-confirmed first-wave items (voice absence → B1, Electron
  routing → A1/A2, IME guard → B8, mobile sessions → B14, theme → B16), which were merged
  into those findings rather than double-counted.
- **Total: 64 distinct confirmed findings** (15 high, 26 medium, 23 low after the
  gap-round severity re-scoring — 63 are numbered A1–K3; the 64th is the §12.2 chat-parity
  contract, folded into the section B intro), 4 refuted. Across both waves: 150 agents,
  ~6.2M subagent tokens, 2,269 tool calls; every file:line citation re-checked at HEAD
  `d8b3fe04`.
- Two findings (J4 setup-wizard mislabel, K1 partly) are pre-existing issues the rename
  merely exposed; they are flagged as such and kept because they compound the admin-
  reachability theme users are hitting now.
