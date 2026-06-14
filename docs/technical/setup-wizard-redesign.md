# Setup Wizard Redesign Blueprint

**Goal:** reduce the 7-step wizard to 3 visible screens plus a hidden detection phase and a deploy screen, so setup is "as easy as signing up for a website."

---

## Owner Decisions (RESOLVED — 2026-06-13)

These were confirmed by the owner; implement exactly as stated.

1. **ElevenLabs voice — INCLUDE NOW.** Add an `elevenlabs-tts` engine entry to the TTS engine catalog and a key-input field on Screen 2's voice section, presented as a cloud TTS choice (available regardless of model mode). Wire its key/provider into the existing `tts` payload block.

2. **Anthropic — FULL removal as a model provider.** Remove `"anthropic"` from the shared `LLM_PROVIDERS` tuple (line 10), `PROVIDER_KEY_MAP` (line 33), and `PROVIDER_LABELS` (line 87), AND do the TypeScript consumer sweep (update/cast the admin test fixtures and any `(typeof LLM_PROVIDERS)[number]` call sites so the build stays green). ALSO keep the `WIZARD_EXCLUDED_PROVIDERS` filter and the host-import Anthropic filter as belt-and-suspenders. **LEAVE the Claude Code CLI agent tooling untouched** (admin Connections / AKM agent platforms — that is a separate feature, not a wizard model provider).

3. **`imageTag` and `hostAkm` — HIDE BOTH from the wizard entirely.** No Advanced disclosure in the wizard. `imageTag` uses the default (auto-resolved) and is editable only post-install from the admin dashboard. `hostAkm` is **auto-defaulted to `true` when the host has AKM installed** (i.e. set `hostAkmEnabled = hostAkmAvailable` from detection, no UI), otherwise `false`. Drop the Infrastructure/Advanced disclosure plan for these two fields.

4. **"Use both" card — CO-EQUAL, do NOT de-emphasise** (owner, 2026-06-13). This **overrides** the earlier de-emphasis design note (Screen 1 section, UX Review Resolutions SUGGESTION-2, and a11y/IA review BLOCKING-1). The three model-mode cards (Local, Cloud, Use both) are rendered at equal visual weight. The visual judge's BLOCK-8 ("Both de-emphasis not landed") is therefore **void** — equal weight is the intended state.

---

## 1. Flow and Decision Logic

### Phase 0 — Silent Detection (runs immediately on `/setup` load, concurrent with SystemCheck)

The server-side `/api/setup/recommend` endpoint is already called during the existing WelcomeStep. In the new design it is called as soon as the wizard page mounts, BEFORE showing Screen 1. The client waits at most 3 s, then continues regardless.

**Optimistic render:** Screen 1 renders immediately with a "Detecting your system…" shimmer on the card that would be pre-selected, rather than blanking the page during detection. When the detection promise resolves, the shimmer is replaced with the actual recommendation. If detection times out, a dismissible banner reads: "Detection timed out — results may be incomplete. Re-run detection?" with a Re-detect button that re-calls `GET /api/setup/recommend` without a page reload.

Detection inputs (all existing APIs, no new endpoints needed):

| Signal | Source |
|---|---|
| GPU info + VRAM (>= `MIN_LOCAL_GPU_VRAM_MB` = 8192 MiB) | `/api/setup/recommend` → `gpu` field (uses `detectGpu()` in `hardware-detect.ts`) |
| Apple Silicon | same — `gpu.vendor === 'apple'` |
| Host credential count | `/api/setup/host-status` → `credentialCount` |
| Local runtimes running (ollama/lmstudio/model-runner) | `/api/setup/recommend` → `hostProviders` |
| Host cloud providers configured | `/api/setup/recommend` → `cloudProviders` |

**Local-models gate:** Local models option on Screen 1 is available (shown, selectable) only when:

```
gpu.vramMb >= 8192 (MIN_LOCAL_GPU_VRAM_MB)
  OR gpu.vendor === 'apple'          // Apple Silicon / MLX
  OR hostProviders.length > 0        // ollama/lmstudio already running
```

If none of the above is true, the "Local models" card is rendered disabled with a one-line reason: "Local models need a GPU with 8 GB+ VRAM or Apple Silicon — not detected on this machine."

**Pre-selection logic (sets wizard state before Screen 1 renders):**

| Condition | Pre-selected choice | Notes |
|---|---|---|
| `cloudProviders.length > 0` | Cloud/remote | Host creds import offered on Screen 1 |
| `credentialCount > 0` (host OpenCode) | Cloud/remote | Host import shown prominently |
| `hostProviders.length > 0` (ollama/lmstudio/model-runner running) | Local + already-running runtime flagged | |
| `gpu.vramMb >= 8192` (NVIDIA/AMD) | Local (in-stack Ollama) | `ollamaEnabled=true`, profile auto-set to `cuda`/`rocm` |
| `gpu.vendor === 'apple'` | Local (host Ollama via Metal) | In-stack Ollama NOT enabled; callout shown with Re-check button |
| None of the above | Cloud/remote | Local option disabled |

### SystemCheck auto-advance and failure handling

SystemCheckStep runs as hidden "screen 0" and auto-advances to Screen 1 on success. **On failure** (`systemCheckPassed = false`), SystemCheck does NOT auto-advance. Instead, it surfaces the Docker error inline on Screen 1 as a dismissible alert with a "Retry" button. The Install button on Screen 3 remains disabled until `systemCheckPassed` is true. This prevents the user from landing on a blank spinner or being silently advanced to a state where Install will immediately fail.

---

### Screen 1 — Models (THE decision)

**Headline:** "Where should your assistant run?"
(Changed from "How do you want to power your assistant?" — uses user outcome framing rather than technical framing. Pilot-test with a non-technical user before committing.)

Three `SelectableCard` options (radio behaviour — only one active):

```
[Cloud / remote]   Use OpenAI, Google, Groq, or any API key / endpoint
[Local models]     Run models on your own hardware     ← disabled + reason if not gated
[Use both]         Local models for everyday tasks, cloud for when you need more power
                   (you control which)                 ← visually de-emphasised; see below
```

The "Use both" card is visually de-emphasised relative to Cloud and Local: rendered at a smaller weight, after the primary two options, with a sub-label that avoids the word "fallback". The sub-label reads: "Use local models for everyday tasks, cloud models when you need more power — you control which." This replaces the earlier "Local fallback + cloud for heavy tasks" which buried the local capability and confused non-expert users.

**Card ordering:** Local → Cloud → Use both (escalating complexity).

Selecting "Cloud / remote" or "Both" reveals the **provider attach sub-panel** inline below the cards.

#### Cloud attach sub-panel (shown when Cloud or Both selected)

The sub-panel auto-selects the highest-confidence path based on detection results, rather than showing all three options at once:

- **When `credentialCount > 0` or `cloudProviders.length > 0`:** default shows "Import from this machine" with the count of importable providers. The other two options are collapsed behind an "Other options" disclosure.
- **When no host creds exist:** default shows the OAuth provider list. Import and Custom are collapsed behind "Other options".
- **Custom endpoint** is always behind "Advanced — enter a custom endpoint" disclosure; never shown by default.

This replaces the original design that showed all three RadioRows simultaneously — that produced four levels of nesting (card selection, RadioRow, OAuth list, text fields) with no visual boundary.

The three sub-paths remain identical in function:

1. **Import from this machine** — shown only when `credentialCount > 0` OR `cloudProviders.length > 0`. Triggers `POST /api/setup/import-host`. On success, shows "Imported N provider(s)" and auto-advances model selection.

2. **Sign in with a provider** — OAuth sub-list. Renders providers for which `opencodeAuth[id]` has at least one auth method. Uses existing `opencode/provider/:id/oauth/authorize` + callback long-poll flow. Anthropic is excluded via `WIZARD_EXCLUDED_PROVIDERS` filter constant (see section 4). Providers shown: openai, google, huggingface, groq, mistral, together, deepseek, xai.

3. **Custom endpoint** — Two fields: Base URL (required) and API Key (optional). Maps to `openai-compatible` provider entry. "Detect models" button calls `POST /api/setup/detect-providers`.

**320–480 px layout budget:** The sub-panel must be a visually distinct "attachment zone" below the cards with a clear separator line. The three RadioRow choices render as a compact vertical list (not cards) so they never clip. At 320 px, the three SelectableCards stack full-width and the sub-panel sits below as a bordered section. The attachment zone has a `max-height` cap with `overflow-y: auto` so it cannot push the Next button off-screen on small viewports.

When "Local models" or "Both" is selected:

- If `hostProviders` has running runtimes: show "Using [ollama/lmstudio] already running on your machine" as a read-only status.
- If `gpu.vramMb >= 8192` and `!hostProviders.length`: show "Will install Ollama in the stack (GPU detected: [name], [N] GB). First pull downloads ~[4–8 GB]." `ollamaEnabled` is set to `true` and the addon profile is set to `cuda`/`rocm`.
- If `gpu.vendor === 'apple'`: show a callout: "Apple Silicon detected — for best performance, install Ollama for macOS (https://ollama.com/download) and leave it running before continuing. Once Ollama is running, click Re-check to continue." A **Re-check** button re-calls `GET /api/setup/recommend` and updates `detectedHostProviders` without a page reload. Without this button, Apple Silicon users who do not have Ollama pre-installed are permanently stuck in their current wizard session.

**"Both" mode — primary model selection (RESOLVED):** When the user picks "Both" (local + cloud), local is the primary model. Cloud is used as a supplement for heavy tasks. The existing `buildModelOptions()` helper currently ranks cloud over local; this must be inverted when `modelMode === 'both'`. The `ModelSummary` explicitly states: "Primary: [local model]. Cloud models available for complex tasks." This resolves Open Question 3 from the previous draft and satisfies Nielsen Heuristic 1 (system status visible) by making the tie-break outcome explicit.

**Model auto-selection:** Once at least one provider is verified/imported, `applyImportedModelPreferences()` + `buildModelOptions()` auto-select the LLM model. The `ModelSummary` component shows "Chat model: [model] via [provider]" with an edit affordance. The edit affordance uses a pencil icon button (minimum 44×44 px touch target) rather than a bare text link, for discoverability per rubric D7. Clicking it opens a lightweight drawer (reusing the existing Drawer component from the provider tab refactor) rather than an inline expansion — this sidesteps the three-level hierarchy problem (card → panel → model list) that would appear on Screen 1 if expanded inline.

The "Next" button on Screen 1 is enabled when:
- At least one provider is verified (for Cloud or Both), OR
- `ollamaEnabled = true` or `hostProviders.length > 0` (for Local), OR
- User has activated the "Install without a provider" escape hatch (maps to the existing `allowEmptyInstall` path).

**"Install without a provider" escape hatch:** Rendered as a muted text-link below the Next button (not a peer-level button), labelled: "Install without a provider — you can add one later from the dashboard." This prevents the false visual hierarchy where skip and proceed appear equivalent. If clicked, the user proceeds with no provider configured; ReviewStep already shows the "No AI provider connected" warning downstream.

---

### Screen 2 — Extras (Voice + Channels)

**Headline:** "Optional: voice and channels"
**Sub-headline:** "Everything here can be skipped — add any of these later from the dashboard."

The "Skip all" button previously placed at top-right is **removed**. It created navigation anxiety (two competing exit paths) and its placement at top-right conflicted with close/dismiss conventions on mobile. Instead, a single "Continue to Review" CTA at the bottom is always enabled, communicating optionality through the sub-headline. The user can reach Screen 3 at any time without touching any control on Screen 2.

#### Voice section

A single `SettingToggle` — Voice is OFF by default.

**Critical state change from current code:** The existing `enableVoice` derived in `+page.svelte` (lines 102–104) is `true` whenever `voiceTts.engine === 'openpalm-voice'`. The new Screen 2 must introduce an explicit `voiceEnabled` boolean `$state` (OFF by default) that is separate from the engine selection. The voice toggle's `onchange` handler drives `voiceEnabled`; the engine selection is only applied when `voiceEnabled` is `true`. This prevents the existing derived from silently enabling voice the moment an engine is pre-selected during auto-configuration when the user selects Local or Both on Screen 1. Without this change, any user on a local/both path will arrive at Screen 2 with voice effectively on before they have touched the toggle.

When toggled ON, the voice engine selection is shown. Default selection logic:

| Condition | Default TTS | Default STT |
|---|---|---|
| Local models enabled (`modelMode === 'local'`) | `openpalm-voice` (Kokoro) | `openpalm-voice` (Whisper) |
| Both mode (`modelMode === 'both'`) | `openpalm-voice` (Kokoro) | `openpalm-voice` (Whisper) — local voice always preferred when available |
| Cloud only, OpenAI is a verified provider | `openai-tts` | `openai-stt` |
| Cloud only, no OpenAI | `browser-tts` | `browser-stt` |

The "Both" row is now explicit: local voice is always preferred when available, same as Local mode. Cloud voice (openai-tts) is never the default in Both mode even if OpenAI is verified — this prevents unexpected API cost for users who have local voice capability.

Kokoro download notice (existing copy from `VoiceStep.svelte`) is shown inline when `openpalm-voice` is selected: "First install downloads the OpenPalm Voice image (~2.4 GB CPU / ~7.6 GB CUDA). The install step will wait for it."

The voice hardware profile picker (existing `VoiceProfileSelector`) is shown collapsed with the auto-selected profile label; user can expand to change.

**ElevenLabs:** Deferred pending owner decision (Open Question 1 above). If added, it belongs here as a cloud TTS choice with a key-input field.

#### Channels section

Clearly separated from the Voice section by a section heading and generous whitespace. For each channel in `CHANNELS` (Discord, Slack — excluding the always-on `api` channel which needs no wizard config):

- A `SettingToggle` for each, OFF by default.
- When toggled ON, the channel's `credentials` fields (from `CHANNELS[].credentials`) expand inline via `{#if}`.
- Toggling OFF collapses the fields and clears `channelSelection[id]`.
- "API" channel is always silently enabled (existing `ch.locked` behaviour); no UI shown.

"Continue to Review" (Next button) on Screen 2 is always enabled (all optional).

---

### Screen 3 — Review & Install

Reuses `ReviewStep.svelte` with the following targeted changes. The component is NOT reused "nearly unchanged" as originally stated — the `ongostepedit()` call sites and the password section both require modification.

#### Step-index mapping (RESOLVED)

The existing `ReviewStep.svelte` has five Edit buttons using numeric step indices that map to the old 7-step scheme. These are replaced with typed callbacks in the new design:

| ReviewStep section | Old `ongostepedit()` call | New typed callback | Navigates to |
|---|---|---|---|
| Account | `ongostepedit(1)` | removed — password handled inline on Screen 3 | n/a |
| Models | `ongostepedit(3)` | `oneditmodels()` | Screen 1 |
| Providers | `ongostepedit(2)` | `oneditmodels()` | Screen 1 (providers are set on Screen 1) |
| Channels | `ongostepedit(5)` | `oneditextras()` | Screen 2 |
| Voice | `ongostepedit(4)` | `oneditextras()` | Screen 2 |
| Options | `ongostepedit(5)` | removed — Options card replaced by Infrastructure card (see below) |

`ReviewStep` props change from `ongostepedit: (step: number) => void` to `oneditmodels: () => void; oneditextras: () => void`. This is a breaking interface change on ReviewStep; all call sites in `+page.svelte` must be updated.

#### Password handling (RESOLVED)

The existing ReviewStep places the password in the middle of the review cards list with a partially-masked display. This is insufficient: the user is in commit-mode at review time, and if they miss copying the password they are locked out.

Changes required:
- The Account / password card moves to **the top of the review list**, above all other cards, rendered with a visually distinct bordered callout treatment (not a plain review card row).
- A show/hide toggle (eye icon) is added so the user can verify the full password before copying. The existing `token-save-box` partial mask is replaced with this toggle.
- The Copy button already exists and is kept.
- A **mandatory checkbox** ("I've saved my password") is added below the password card. The Install button is disabled until this checkbox is checked. This ensures the user acknowledges the password before proceeding.
- The password card has no Edit button (password generation is deterministic on mount; if they want a different password they can refresh).

#### Infrastructure card (replaces Options card)

The existing "Options" review card shows "None enabled" when `ollamaEnabled` is false, even when Local mode was selected — this is misleading because infrastructure was auto-configured, not a user choice. The "Options" card is renamed to "Infrastructure" and its copy is adjusted:

- If `ollamaEnabled` is true: show "Ollama In-Stack: Enabled" + profile (unchanged from current).
- If `ollamaEnabled` is false and a host provider was detected: show "Using [runtime] running on your machine."
- If `ollamaEnabled` is false and cloud-only: remove the card entirely (no infrastructure to show).

#### Install button

Disabled until both `systemCheckPassed === true` AND the password acknowledgement checkbox is checked. Calls `handleInstall()` → `POST /api/setup/complete` with the same payload shape.

---

### Screen 4 — Installing (DeployStep, unchanged)

`DeployStep.svelte` is reused without changes. It polls `/api/setup/deploy-status` at 2500 ms intervals.

---

## 2. Component Tree

```
/setup/+page.svelte  (orchestrator — restructured)
│
├── SystemCheckStep.svelte          KEEP (hidden "screen 0" — auto-advances on pass;
│                                         on fail, surfaces error inline on Screen 1)
│
├── Screen1ModelsStep.svelte        NEW (replaces WelcomeStep + ProvidersStep + ModelsStep)
│   ├── SelectableCard              REUSE (3×: cloud, local, both — ordered: local/cloud/both)
│   ├── [detection shimmer]         NEW inline shimmer on pre-selected card during Phase 0
│   ├── [detection timeout banner]  NEW dismissible "Detection timed out — Re-detect" banner
│   ├── CloudAttachPanel.svelte     NEW inline sub-panel (auto-selects highest-confidence path)
│   │   ├── [import path]           Default when credentialCount > 0 or cloudProviders > 0
│   │   ├── [oauth path]            Default when no host creds
│   │   ├── [custom path]           Behind "Advanced — enter a custom endpoint" disclosure
│   │   └── ProviderOAuthList.svelte  NEW (extracted from ProvidersStep; excludes Anthropic)
│   ├── LocalModelsStatus.svelte    NEW (running runtime / ollama-will-install /
│   │                                    apple-silicon callout WITH Re-check button)
│   └── ModelSummary.svelte         NEW (inline "Chat model: X via Y" with pencil-icon
│                                        edit button opening a Drawer)
│
├── Screen2ExtrasStep.svelte        NEW (replaces VoiceStep + OptionsStep)
│   ├── [Voice section heading]
│   ├── SettingToggle               REUSE (voice on/off; drives explicit voiceEnabled $state)
│   ├── VoiceEngineSelector         REUSE (expanded only when voiceEnabled is true)
│   ├── VoiceProfileSelector        REUSE (collapsed by default)
│   ├── [Channels section heading]
│   ├── SettingToggle               REUSE (discord on/off)
│   ├── FormField ×2                REUSE (discord credentials — shown only when on)
│   ├── SettingToggle               REUSE (slack on/off)
│   └── FormField ×2                REUSE (slack credentials — shown only when on)
│
├── ReviewStep.svelte               MODIFY (typed callbacks; password card first + mandatory
│                                          checkbox; Infrastructure card; no Options card)
│
└── DeployStep.svelte               KEEP (unchanged)
```

**Deleted step components:** `WelcomeStep.svelte`, `ProvidersStep.svelte`, `VoiceStep.svelte`, `OptionsStep.svelte`, `ModelsStep.svelte` — their logic folds into `Screen1ModelsStep.svelte`, `Screen2ExtrasStep.svelte`, and `+page.svelte`.

---

## 3. State Model and Payload Mapping

### Wizard state (lives in `+page.svelte` `$state`)

The existing state variables in `+page.svelte` are kept verbatim. The new screens are thin presentational wrappers that receive these as props and emit events back.

New top-level state variables:

```ts
// Which high-level model mode did the user pick?
type ModelMode = 'cloud' | 'local' | 'both';
let modelMode = $state<ModelMode>('cloud');  // pre-set by detection

// Explicit voice on/off toggle — separate from engine selection.
// Prevents the existing enableVoice $derived from auto-enabling voice
// when an engine is pre-selected during detection.
let voiceEnabled = $state(false);  // OFF by default, always
```

`voiceEnabled` replaces the role of the existing `enableVoice` derived for the purposes of the wizard toggle. The existing `enableVoice` derived (`voiceTts.engine === 'openpalm-voice' || voiceStt.engine === 'openpalm-voice'`) continues to drive the payload block; Screen2ExtrasStep reads `voiceEnabled` for toggle display and only writes engine values to `voiceTts`/`voiceStt` when `voiceEnabled` is true.

Everything else (`providerState`, `modelSelection`, `voiceTts`, `voiceStt`, `channelSelection`, `ollamaEnabled`, `selectedOllamaProfile`, `selectedVoiceProfile`, `uiLoginPassword`, `hostProviderCount`, `detectedHostProviders`, `opencodeProviders`, `opencodeAuth`) is unchanged.

### Payload contract (unchanged — must not break)

`POST /api/setup/complete` body is built by the existing `$derived.by(() => {...})` block. The new screens write into the same state variables that feed this derived, so the payload shape does not change:

```ts
{
  version: 2,
  addons: { ollama?: true, voice?: true, discord?: true, slack?: true },
  security: { uiLoginPassword },
  connections: [{ id, name, provider, baseUrl, apiKey }],
  llm?: { provider, model, baseUrl },
  embedding?: { provider, model, dims, baseUrl },
  tts?: { enabled, engine, provider?, baseUrl?, model?, voice?, language? },
  stt?: { enabled, engine, provider?, baseUrl?, model?, language? },
  voiceProfile?: string,
  ollamaProfile?: string,
  channelCredentials?: Record<string, Record<string, string>>,
  imageTag?: string,
  hostAkm?: true,
}
```

### Endpoint usage (all existing — no new backend routes needed)

| Action | Endpoint | Existing handler |
|---|---|---|
| Detection | `GET /api/setup/recommend` | `recommendSetup()` in `setup-recommendation.ts` |
| Host status | `GET /api/setup/host-status` | `detectHostOpenCode()` in `host-opencode.ts` |
| Import host | `POST /api/setup/import-host` | `importHostOpenCode()` |
| OAuth start | `POST /api/setup/opencode/provider/:id/oauth/authorize` | `startProviderOAuth()` |
| OAuth poll | `POST /api/setup/opencode/provider/:id/oauth/callback` | `completeProviderOAuth()` (long-poll) |
| Custom endpoint detect | `POST /api/setup/detect-providers` | `detectLocalProviders()` in `model-runner.ts` |
| Fetch models | `GET /api/setup/models` | existing |
| Voice profiles | `GET /api/setup/voice-profiles` | existing |
| Ollama profiles | `GET /api/setup/ollama-profiles` | existing |
| Complete install | `POST /api/setup/complete` | existing `performSetup()` |
| Deploy status | `GET /api/setup/deploy-status` | existing polling |

---

## 4. No-Anthropic Change Set

Anthropic appears in three places that affect the wizard. None of these are in the wizard UI files themselves (the wizard's `PROVIDERS` array in `constants.ts` never included Anthropic). The changes needed are:

### 4a. `packages/lib/src/provider-constants.ts`

Pending owner decision (Open Question 2 above). If the owner confirms platform-wide removal:

- **Line 10:** `LLM_PROVIDERS` array — remove `"anthropic"` from the tuple.
- **Line 33:** `PROVIDER_KEY_MAP` — remove the `anthropic: "ANTHROPIC_API_KEY"` entry.
- **Line 87:** `PROVIDER_LABELS` — remove the `anthropic: "Anthropic"` entry.

If the owner prefers wizard-only exclusion (recommended — zero downstream risk), skip this file entirely and rely on `WIZARD_EXCLUDED_PROVIDERS` below.

### 4b. Host import filter

The `importHostOpenCode()` function in `host-opencode.ts` copies `auth.json` byte-for-byte. If the host user has an Anthropic credential in their OpenCode `auth.json`, it will be imported. To honour the no-Anthropic constraint for the assistant stack, the import handler at `packages/ui/src/routes/api/setup/import-host/+server.ts` (or the underlying lib function) must filter out the `anthropic` key when merging `auth.json`.

After the merge in `importHostOpenCode()`, any `anthropic` key in `merged` must be deleted before `writeFileSync`. The same applies to the live-push step that POSTs provider credentials to OpenCode — omit the `anthropic` provider.

This is a 2-line addition in `host-opencode.ts` and a 1-line guard in the server route.

### 4c. `ProviderOAuthList` (new component — Screen 1)

The new `ProviderOAuthList.svelte` filters the `opencodeProviders` list before rendering. Add a constant:

```ts
// packages/ui/src/lib/client/constants.ts
export const WIZARD_EXCLUDED_PROVIDERS = new Set(['anthropic']);
```

And filter in `ProviderOAuthList.svelte`:

```ts
const filteredProviders = $derived(
  opencodeProviders.filter(p => !WIZARD_EXCLUDED_PROVIDERS.has(p.id))
);
```

This filter is the safe, always-correct approach regardless of what the owner decides for the shared `LLM_PROVIDERS` constant. It does not create a TypeScript cascade.

### 4d. No change to admin Connections tab

The admin Connections tab, CLI, and guardian can still work with Anthropic credentials if the host user adds them manually post-install. The constraint is wizard-only.

---

## 5. File Plan

### Create (new files)

| File | Purpose |
|---|---|
| `packages/ui/src/routes/setup/steps/Screen1ModelsStep.svelte` | New Screen 1 — model mode picker + provider attach |
| `packages/ui/src/routes/setup/steps/CloudAttachPanel.svelte` | Inline cloud attach sub-panel (auto-selects highest-confidence path) |
| `packages/ui/src/routes/setup/steps/ProviderOAuthList.svelte` | OAuth provider list (filtered, no Anthropic) |
| `packages/ui/src/routes/setup/steps/LocalModelsStatus.svelte` | Running runtime / ollama-will-install / Apple callout with Re-check button |
| `packages/ui/src/routes/setup/steps/ModelSummary.svelte` | Inline "Chat model: X" with pencil-icon Drawer edit |

### Modify (existing files)

| File | Change |
|---|---|
| `packages/ui/src/routes/setup/+page.svelte` | Add `modelMode` and `voiceEnabled` state; replace step-index 0–4 with Screen1/Screen2/Review/Deploy wiring; keep all existing state variables and the `$derived` payload block verbatim; remove imports of WelcomeStep/ProvidersStep/ModelsStep/VoiceStep/OptionsStep; add Screen1ModelsStep/Screen2ExtrasStep imports; pass typed `oneditmodels`/`oneditextras` to ReviewStep |
| `packages/ui/src/lib/client/constants.ts` | Change `STEP_LABELS` from 7-entry array to `['Models', 'Extras', 'Review']` (3 visible segments — SystemCheck is not counted in the visible progress bar; it completes before Screen 1 renders so the user never sees it as "current"); add `WIZARD_EXCLUDED_PROVIDERS` export |
| `packages/ui/src/routes/setup/steps/ReviewStep.svelte` | Replace `ongostepedit: (step: number) => void` prop with `oneditmodels: () => void; oneditextras: () => void`; move password card to top + add show/hide toggle + mandatory copy-confirmation checkbox; rename Options card to Infrastructure with auto-config copy; remove Options Edit button |
| `packages/lib/src/control-plane/host-opencode.ts` | Add Anthropic filter in `importHostOpenCode()` merged auth.json write |
| `packages/ui/src/routes/api/setup/import-host/+server.ts` | Add Anthropic omission in live-push loop |
| `packages/ui/e2e/ux-audit.wizard.config.json` | Rewrite all `states` entries to match new step IDs and `data-testid` attributes for the 3-visible-screen flow |

### Delete (step files no longer needed)

| File | Reason |
|---|---|
| `packages/ui/src/routes/setup/steps/WelcomeStep.svelte` | Detection + recommendation copy moves into Screen1ModelsStep; password generation stays in +page.svelte |
| `packages/ui/src/routes/setup/steps/ProvidersStep.svelte` | Provider attach logic moves to CloudAttachPanel + ProviderOAuthList |
| `packages/ui/src/routes/setup/steps/ModelsStep.svelte` | Model pick moves to ModelSummary inside Screen1ModelsStep |
| `packages/ui/src/routes/setup/steps/VoiceStep.svelte` | Voice section moves to Screen2ExtrasStep |
| `packages/ui/src/routes/setup/steps/OptionsStep.svelte` | Channels section moves to Screen2ExtrasStep; ollama/hostAkm/imageTag become auto-configured values |

Also delete vitest files for deleted components:
- `packages/ui/src/routes/setup/steps/ProvidersStep.svelte.vitest.ts`
- `packages/ui/src/routes/setup/steps/ModelsStep.svelte.vitest.ts`

---

## 6. Test Impact

### `packages/ui/e2e/ux-audit.wizard.config.json`

This file hard-codes button IDs and `data-testid` attributes that map to the old 7-step layout. All `states` entries must be rewritten:

| Old state ID | New state ID | New wait selector |
|---|---|---|
| `wizard-1-system-check` | `wizard-0-system-check` | `.step-content` — hidden, auto-advances |
| `wizard-2-get-started` | *(removed)* | n/a |
| `wizard-3-providers-recommended` | `wizard-1-models-import` | `[data-testid="step-models"]` |
| `wizard-4-providers-manual` | `wizard-1-models-custom` | `[data-testid="step-models"]` |
| `wizard-5-models` | `wizard-1-models-local` | `[data-testid="step-models"]` |
| `wizard-6-voice` | `wizard-2-extras` | `[data-testid="step-extras"]` |
| `wizard-7-options` | *(merged into step-extras)* | n/a |
| `wizard-8-review` | `wizard-3-review` | `#review-summary` |

Button IDs on the new screens: `#btn-syscheck-retry`, `#btn-screen1-next`, `#btn-screen2-next`, `#btn-install`. The password acknowledgement checkbox: `#chk-password-saved`.

### `packages/ui/src/routes/setup/steps/ProvidersStep.svelte.vitest.ts`

References the deleted `ProvidersStep.svelte` and includes an `anthropic` provider in its mock data. Delete or replace with a test for `CloudAttachPanel.svelte` / `ProviderOAuthList.svelte`. The Anthropic mock must not be replicated.

### `packages/ui/src/routes/setup/steps/ModelsStep.svelte.vitest.ts`

References the deleted `ModelsStep.svelte`. Delete or replace with a test for `ModelSummary.svelte`.

### `packages/ui/src/routes/admin/providers/` vitest files

`import-host/server.vitest.ts` and `oauth/start/server.vitest.ts` use `'anthropic'` as a test fixture. These test admin Connections routes — they do not need to change for the wizard redesign. However, if the owner chooses to remove `"anthropic"` from the shared `LLM_PROVIDERS` tuple, any TypeScript assertion that passes `'anthropic'` as `(typeof LLM_PROVIDERS)[number]` will fail at compile time. Cast to `string` at those call sites if the admin tests must remain as-is.

### `ProgressBar.svelte`

Reads `STEP_LABELS` from `constants.ts`. Updating `STEP_LABELS` to 3 entries (Models / Extras / Review) gives a 3-segment visible progress bar. SystemCheck is not counted as a segment because it auto-completes before Screen 1 renders — the user must never see progress jump from 0% to step 2. The ProgressBar should visually show all segments as "upcoming" when Screen 1 first appears (segment 1 = current, 2–3 = upcoming), not animate a completion transition for a step the user never saw.

### Manual smoke tests (`e2e/*.manual.ts`)

None of the existing `.manual.ts` files reference wizard step components or button IDs. No changes needed.

---

## 7. UX Review Resolutions

This section records every change the two UX expert reviews forced and why.

### From UX Review 1 (onboarding/cognitive-load)

**BLOCKING-1 — "Both" mode primary model tie-break:** Resolved. "Both" now explicitly sets local as the primary model. `buildModelOptions()` must invert its cloud-over-local ranking when `modelMode === 'both'`. The `ModelSummary` inline text explicitly names the primary model and states "Cloud models available for complex tasks." The user no longer has to guess which model their assistant actually uses.

**BLOCKING-2 — Voice toggle / enableVoice $derived conflict:** Resolved. An explicit `voiceEnabled $state` (OFF by default) is introduced. Engine pre-selection during Phase 0 auto-configuration no longer touches `voiceTts`/`voiceStt` state — it only informs the default selection table that is applied when the user manually toggles voice on. The existing `enableVoice` derived continues to drive the payload block and is no longer the source of truth for the toggle UI.

**BLOCKING-3 — Cloud attach sub-panel density at 320–480 px:** Resolved. The sub-panel auto-selects the highest-confidence path rather than showing all three RadioRows simultaneously. A `max-height` cap with `overflow-y: auto` prevents the sub-panel from pushing Next off-screen. The three choices render as a compact vertical list, not cards. The "Advanced" disclosure hides the custom endpoint until needed.

**BLOCKING-4 — ReviewStep stale `ongostepedit()` indices:** Resolved. The `ongostepedit(step: number)` prop is replaced with typed callbacks: `oneditmodels()` and `oneditextras()`. A concrete mapping table is provided in section 3 above. No integer step indices remain in ReviewStep.

**BLOCKING-5 — Apple Silicon callout dead-end:** Resolved. A "Re-check" button is added to the Apple Silicon callout in `LocalModelsStatus.svelte`. It re-calls `GET /api/setup/recommend` in-place and updates `detectedHostProviders` without a page reload. Copy added: "Once Ollama is running, click Re-check to continue."

**BLOCKING-6 — "Skip for now" visual treatment and label:** Resolved. The escape hatch is rendered as a muted text-link below the Next button (tertiary, not peer-level), labelled: "Install without a provider — you can add one later from the dashboard." This prevents accidental selection and sets honest expectations.

**SUGGESTION-1 — Optimistic render during Phase 0 detection:** Adopted. Screen 1 renders immediately with a shimmer on the pre-selected card. When detection resolves the shimmer is replaced. A "Detection timed out" banner covers the timeout case.

**SUGGESTION-2 — "Both" card visual de-emphasis:** Adopted. "Both" is visually de-emphasised (smaller weight, ordered last), reflecting that it is a power-user configuration.

**SUGGESTION-3 — ModelSummary edit opens drawer instead of inline expansion:** Adopted. The edit affordance opens a lightweight drawer using the existing Drawer component, avoiding a three-level hierarchy on Screen 1.

**SUGGESTION-4 — ElevenLabs:** Deferred to owner (Open Question 1). The blueprint no longer silently omits it; the open question is explicit.

**SUGGESTION-5 — SystemCheck not counted in visible progress bar:** Adopted. `STEP_LABELS` is 3 entries (Models / Extras / Review). SystemCheck is a hidden pre-screen that completes before Screen 1 renders.

**SUGGESTION-6 — Password elevated in ReviewStep:** Adopted. Password card is first in the review list, with show/hide toggle and a mandatory copy-confirmation checkbox. Install button disabled until checkbox is checked.

**SUGGESTION-7 — Remove "Skip all" top-right button on Screen 2:** Adopted. Replaced with always-enabled "Continue to Review" CTA at the bottom. The sub-headline communicates optionality.

**SUGGESTION-8 — WIZARD_LLM_PROVIDERS filter instead of modifying shared constant:** Adopted as the recommended path (Open Question 2 for owner confirmation). `WIZARD_EXCLUDED_PROVIDERS` constant added; shared `LLM_PROVIDERS` left untouched unless the owner explicitly confirms platform-wide removal.

### From UX Review 2 (a11y/IA)

**BLOCKING-1 — "Both" card "fallback" framing:** Resolved. Sub-label changed to: "Use local models for everyday tasks, cloud models when you need more power — you control which." Word "fallback" removed entirely.

**BLOCKING-2 — Cloud attach sub-panel four-level nesting:** Resolved. Same fix as BLOCKING-3 above: auto-select the highest-confidence path, collapse others behind disclosure. Only one sub-panel is shown at a time.

**BLOCKING-3 — "Skip for now" label and visual treatment:** Resolved. Same fix as BLOCKING-6 above.

**BLOCKING-4 — Password buried in ReviewStep, stale Account Edit button:** Resolved. Password card moved to first position in ReviewStep. Mandatory copy-confirmation checkbox added. The Account "Edit" button is removed (no separate account screen exists in the 3-screen flow; the password is managed inline on Screen 3 itself).

**BLOCKING-5 — Apple Silicon re-detect dead-end:** Resolved. Same fix as BLOCKING-5 above (Re-check button).

**BLOCKING-6 — Stale `ongostepedit()` call sites in ReviewStep, misleading Options card:** Resolved. Same fix as BLOCKING-4 above (typed callbacks). Options card renamed Infrastructure with auto-config copy; card hidden when cloud-only.

**BLOCKING-7 — Voice default for "Both" mode not specified:** Resolved. Explicit row added to voice default table: Both mode → `openpalm-voice` (Kokoro/Whisper), same as Local. Local voice is always preferred when available.

**BLOCKING-8 — SystemCheck auto-advance unresolved when systemCheckPassed is false:** Resolved. On failure, SystemCheck does not auto-advance. Error is surfaced inline on Screen 1 with a Retry button. Install button on Screen 3 is disabled until `systemCheckPassed` is true.

**SUGGESTION-A — Headline copy:** Adopted. "Where should your assistant run?" replaces "How do you want to power your assistant?" to use user-outcome framing.

**SUGGESTION-B — Card ordering (escalating complexity):** Adopted. Order is Local → Cloud → Use both.

**SUGGESTION-C — ModelSummary edit affordance (pencil icon, 44×44 px):** Adopted. Pencil icon button replaces bare text link.

**SUGGESTION-D — "Skip all" button placement on mobile:** Moot — the "Skip all" button is removed entirely (per SUGGESTION-7 from review 1).

**SUGGESTION-E — Voice and Channels as separate labeled sections:** Adopted. Screen 2 has two clearly labeled sections with a section heading and generous whitespace between them.

**SUGGESTION-F — ElevenLabs:** Same as SUGGESTION-4 above — deferred to owner as Open Question 1.

**SUGGESTION-G — WIZARD_EXCLUDED_PROVIDERS vs. modifying shared constant:** Adopted. `WIZARD_EXCLUDED_PROVIDERS` is the implementation path; shared constant left untouched.

**SUGGESTION-H — Detection timeout banner:** Adopted. Visible "Detection timed out — results may be incomplete. Re-run detection?" banner fires when the 3s timeout elapses.

**SUGGESTION-I — Password show/hide toggle in ReviewStep:** Adopted. Eye icon toggle added; partial mask (`{uiLoginPassword.substring(0,2)}*********`) replaced with a full-reveal toggle.

**SUGGESTION-J — ProgressBar SystemCheck segment:** Adopted. SystemCheck is not counted as a progress bar segment. Segments are Models / Extras / Review. The bar starts at segment 1 (current = Models) when Screen 1 renders.
