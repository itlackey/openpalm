<script lang="ts">
  /**
   * Screen2ExtrasStep — "Optional extras"
   *
   * Flat hairline-row layout (spec: /tmp/wiz/extras-finish-redesign.html).
   * Three rows with inline accordion expansion (no modal, no bordered cards,
   * no sub-section headings):
   *   1. Voice  — bundled openpalm-voice; toggle drives onvoiceenabledchange + engine defaults
   *   2. Discord — botToken + applicationId credential fields
   *   3. Slack  — slackBotToken + slackAppToken credential fields
   *
   * Props:
   *   modelMode               — 'cloud' | 'local' | 'both' — drives voice default selection
   *   voiceEnabled            — explicit voice on/off toggle state (OFF by default)
   *   voiceTts                — current TTS engine value
   *   voiceStt                — current STT engine value
   *   hasOpenAI               — true if OpenAI is a verified provider (affects voice default)
   *   voiceProfiles           — available voice addon hardware profiles
   *   selectedVoiceProfile    — currently selected voice profile id
   *   portalSelection         — current portal enable + credential state
   *   onvoiceenabledchange    — called when voice toggle flips
   *   onchangetts             — called when TTS engine/config changes
   *   onchangestt             — called when STT engine/config changes
   *   onvoiceprofilechange    — called when voice hardware profile changes
   *   onportaltoggle          — called when a portal toggle flips
   *   oncredentialchange      — called when a portal credential field changes
   *   onnext                  — proceed to Screen 3 (always enabled)
   */

  import type { VoiceEngineValue, PortalState } from '$lib/client/types.js';
  import type { VoiceAddonProfile } from '$lib/api.js';
  import { PORTALS } from '$lib/client/constants.js';
  import { isPortalEnabled as _isPortalEnabled, getCredValue as _getCredValue } from '$lib/client/helpers.js';

  type ModelMode = 'cloud' | 'local' | 'both';

  interface Props {
    /** Which model mode was chosen on Screen 1. Drives voice default logic. */
    modelMode: ModelMode;
    /**
     * Explicit voice on/off state — OFF by default.
     * CRITICAL: must not be derived from engine selection. The parent owns this
     * as $state(false) and passes it down. Only when this is true should voice
     * addon be included in the payload.
     */
    voiceEnabled: boolean;
    /** Current TTS engine value. */
    voiceTts: VoiceEngineValue;
    /** Current STT engine value. */
    voiceStt: VoiceEngineValue;
    /** True when OpenAI is a verified provider (affects default engine). */
    hasOpenAI?: boolean;
    /** Voice addon hardware profiles (CPU / CUDA / ROCm). */
    voiceProfiles?: VoiceAddonProfile[];
    /** Currently selected voice profile id. */
    selectedVoiceProfile?: string;
    /** Portal enable + credential state (discord, slack). */
    portalSelection?: Record<string, boolean | PortalState>;

    onvoiceenabledchange: (enabled: boolean) => void;
    onchangetts: (v: VoiceEngineValue) => void;
    onchangestt: (v: VoiceEngineValue) => void;
    onvoiceprofilechange?: (id: string) => void;
    onportaltoggle: (id: string) => void;
    oncredentialchange: (chId: string, credKey: string, value: string) => void;
    onnext: () => void;
  }

  let {
    modelMode,
    voiceEnabled,
    voiceTts,
    voiceStt,
    hasOpenAI = false,
    portalSelection = {},
    onvoiceenabledchange,
    onchangetts,
    onchangestt,
    onportaltoggle,
    oncredentialchange,
    onnext: _onnext,
  }: Props = $props();

  // Determine default TTS/STT engine based on modelMode and hasOpenAI.
  // Called by the toggle handler when voice is turned ON to initialize engines.
  function defaultTtsEngine(): string {
    if (modelMode === 'local' || modelMode === 'both') return 'openpalm-voice';
    if (hasOpenAI) return 'openai-tts';
    return 'browser-tts';
  }

  function defaultSttEngine(): string {
    if (modelMode === 'local' || modelMode === 'both') return 'openpalm-voice';
    if (hasOpenAI) return 'openai-stt';
    return 'browser-stt';
  }

  function handleVoiceToggle() {
    const next = !voiceEnabled;
    onvoiceenabledchange(next);
    if (next) {
      // When turning voice ON, set the bundled openpalm-voice engine so the
      // payload's addons.voice is included. Mirror what handleEnableVoiceChange
      // does in the parent for the engines, falling back to defaults.
      if (!voiceTts.engine || voiceTts.engine === '') {
        onchangetts({ engine: defaultTtsEngine() });
      }
      if (!voiceStt.engine || voiceStt.engine === '') {
        onchangestt({ engine: defaultSttEngine() });
      }
      // Ensure bundled engine is set when the new default is openpalm-voice
      if (defaultTtsEngine() === 'openpalm-voice') {
        onchangetts({ engine: 'openpalm-voice' });
      }
      if (defaultSttEngine() === 'openpalm-voice') {
        onchangestt({ engine: 'openpalm-voice' });
      }
    }
  }

  function isPortalEnabled(chId: string, locked?: boolean): boolean {
    return _isPortalEnabled(portalSelection, chId, locked);
  }

  function getCredValue(chId: string, key: string): string {
    return _getCredValue(portalSelection, chId, key);
  }

  // Non-API, non-locked portals only
  const configurablePortals = $derived(PORTALS.filter((ch) => !ch.locked));

  // Discord and Slack portal definitions (looked up from PORTALS constant)
  const discordCh = $derived(configurablePortals.find((ch) => ch.id === 'discord'));
  const slackCh = $derived(configurablePortals.find((ch) => ch.id === 'slack'));
  const discordOn = $derived(isPortalEnabled('discord'));
  const slackOn = $derived(isPortalEnabled('slack'));
</script>

<div data-testid="step-extras" class="addon-list" role="list">

  <!-- ── Voice ──────────────────────────────────────────────────────── -->
  <div class="addon-row" role="listitem">
    <div class="addon-row-header">
      <div class="addon-icon voice-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>
      </div>
      <div class="addon-body">
        <div class="addon-title">Voice</div>
        <div class="addon-sub">Talk to your assistant and hear it reply</div>
      </div>
      <div class="toggle-wrap">
        <label class="toggle" aria-label="Enable Voice">
          <input
            type="checkbox"
            checked={voiceEnabled}
            onchange={handleVoiceToggle}
          />
          <div class="toggle-track"></div>
          <div class="toggle-thumb"></div>
        </label>
      </div>
    </div>
    <!-- Inline accordion: voice settings -->
    <div class="addon-panel" class:open={voiceEnabled} aria-live="polite">
      <div class="addon-panel-inner">
        <p class="panel-question">How should your assistant speak?</p>
        <div class="voice-option">
          <div class="voice-option-dot">
            <div class="voice-option-dot-inner"></div>
          </div>
          <div>
            <div class="voice-option-text">Built-in voice — free, runs on this computer</div>
            <div class="voice-option-sub">No internet needed. Sounds natural, works out of the box.</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Discord ────────────────────────────────────────────────────── -->
  {#if discordCh}
    <div class="addon-row" role="listitem">
      <div class="addon-row-header">
        <div class="addon-icon discord-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="#5865f2"><path d="M19 5.3A16 16 0 0015 4l-.2.4a14 14 0 00-4 0L10.5 4a16 16 0 00-4 1.3C4 9 3.3 12.6 3.6 16.2A16 16 0 008.5 18.7c.4-.5.8-1.1 1-1.7a9 9 0 01-1.6-.8l.4-.3a11 11 0 009.4 0l.4.3a9 9 0 01-1.6.8c.3.6.6 1.2 1 1.7a16 16 0 004.9-2.5c.4-4.2-.7-7.8-2.4-10.9zM9 14c-.8 0-1.4-.7-1.4-1.6S8.2 10.8 9 10.8s1.4.7 1.4 1.6S9.8 14 9 14zm6 0c-.8 0-1.4-.7-1.4-1.6s.6-1.6 1.4-1.6 1.4.7 1.4 1.6S15.8 14 15 14z"/></svg>
        </div>
        <div class="addon-body">
          <div class="addon-title">Discord</div>
          <div class="addon-sub">Reach your assistant from a Discord server</div>
        </div>
        <div class="toggle-wrap">
          <label class="toggle" aria-label="Enable Discord">
            <input
              type="checkbox"
              checked={discordOn}
              onchange={() => onportaltoggle('discord')}
            />
            <div class="toggle-track"></div>
            <div class="toggle-thumb"></div>
          </label>
        </div>
      </div>
      <!-- Inline accordion: Discord token fields -->
      <div class="addon-panel" class:open={discordOn} aria-live="polite">
        <div class="addon-panel-inner">
          <div class="field-group">
            <div>
              <label class="field-label" for="cred-discord-botToken">Bot token</label>
              <input
                class="field-input"
                type="password"
                id="cred-discord-botToken"
                placeholder="Paste your bot token here"
                autocomplete="off"
                value={getCredValue('discord', 'botToken')}
                oninput={(e) => {
                  e.stopPropagation();
                  oncredentialchange('discord', 'botToken', (e.currentTarget as HTMLInputElement).value);
                }}
                onclick={(e) => e.stopPropagation()}
              />
              <p class="field-help">
                <a
                  href="https://discord.com/developers/docs/quick-start/getting-started"
                  target="_blank"
                  rel="noopener"
                >How to create a Discord bot and get your token →</a>
              </p>
            </div>
            <div>
              <label class="field-label" for="cred-discord-applicationId">Application ID</label>
              <input
                class="field-input"
                type="text"
                id="cred-discord-applicationId"
                placeholder="Your app's numeric ID"
                autocomplete="off"
                value={getCredValue('discord', 'applicationId')}
                oninput={(e) => {
                  e.stopPropagation();
                  oncredentialchange('discord', 'applicationId', (e.currentTarget as HTMLInputElement).value);
                }}
                onclick={(e) => e.stopPropagation()}
              />
              <p class="field-help">Found in the Discord Developer Portal under your application's General Information page.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- ── Slack ──────────────────────────────────────────────────────── -->
  {#if slackCh}
    <div class="addon-row" role="listitem">
      <div class="addon-row-header">
        <div class="addon-icon slack-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path fill="#36C5F0" d="M9 13.5a2 2 0 11-2-2h2v2z"/><path fill="#2EB67D" d="M10.5 9a2 2 0 112 2H10.5v-2z"/><path fill="#ECB22E" d="M15 10.5a2 2 0 112 2h-2v-2z"/><path fill="#E01E5A" d="M13.5 15a2 2 0 11-2 2v-2h2z"/></svg>
        </div>
        <div class="addon-body">
          <div class="addon-title">Slack</div>
          <div class="addon-sub">Reach your assistant from a Slack workspace</div>
        </div>
        <div class="toggle-wrap">
          <label class="toggle" aria-label="Enable Slack">
            <input
              type="checkbox"
              checked={slackOn}
              onchange={() => onportaltoggle('slack')}
            />
            <div class="toggle-track"></div>
            <div class="toggle-thumb"></div>
          </label>
        </div>
      </div>
      <!-- Inline accordion: Slack token fields -->
      <div class="addon-panel" class:open={slackOn} aria-live="polite">
        <div class="addon-panel-inner">
          <div class="field-group">
            <div>
              <label class="field-label" for="cred-slack-slackBotToken">Bot token</label>
              <input
                class="field-input"
                type="password"
                id="cred-slack-slackBotToken"
                placeholder="xoxb-…"
                autocomplete="off"
                value={getCredValue('slack', 'slackBotToken')}
                oninput={(e) => {
                  e.stopPropagation();
                  oncredentialchange('slack', 'slackBotToken', (e.currentTarget as HTMLInputElement).value);
                }}
                onclick={(e) => e.stopPropagation()}
              />
            </div>
            <div>
              <label class="field-label" for="cred-slack-slackAppToken">App-level token</label>
              <input
                class="field-input"
                type="password"
                id="cred-slack-slackAppToken"
                placeholder="xapp-…"
                autocomplete="off"
                value={getCredValue('slack', 'slackAppToken')}
                oninput={(e) => {
                  e.stopPropagation();
                  oncredentialchange('slack', 'slackAppToken', (e.currentTarget as HTMLInputElement).value);
                }}
                onclick={(e) => e.stopPropagation()}
              />
              <p class="field-help">
                <a
                  href="https://api.slack.com/quickstart"
                  target="_blank"
                  rel="noopener"
                >How to create a Slack app and get your tokens →</a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}

</div>

<style>
  /* ── Add-on list: hairline dividers, no bordered box ─────────────── */
  .addon-list {
    display: flex;
    flex-direction: column;
  }

  .addon-row {
    border-top: 1px solid var(--color-border);
  }

  .addon-row:last-child {
    border-bottom: 1px solid var(--color-border);
  }

  /* Row header: icon + text + toggle on one line */
  .addon-row-header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 4px;
    cursor: default;
  }

  /* Small tinted icon bubble */
  .addon-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .addon-icon svg { width: 19px; height: 19px; }

  .voice-icon { background: rgba(59, 130, 246, 0.10); }
  .discord-icon { background: rgba(88, 101, 242, 0.10); }
  .slack-icon { background: rgba(74, 21, 75, 0.08); }

  .addon-body {
    flex: 1;
    min-width: 0;
  }

  .addon-title {
    font-size: var(--text-lg, 1rem);
    font-weight: 500;
    color: var(--color-text);
    line-height: 1.3;
  }

  .addon-sub {
    font-size: var(--text-sm, 0.8125rem);
    color: var(--color-text-secondary);
    margin-top: 3px;
    line-height: 1.45;
  }

  /* ── Toggle switch ─────────────────────────────────────────────── */
  .toggle-wrap {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .toggle {
    position: relative;
    width: 42px;
    height: 24px;
    cursor: pointer;
    display: block;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
    position: absolute;
  }

  .toggle-track {
    position: absolute;
    inset: 0;
    border-radius: var(--radius-full, 9999px);
    background: var(--color-border-hover);
    transition: background 200ms;
  }

  .toggle input:checked + .toggle-track {
    background: var(--color-primary);
  }

  .toggle-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
    transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: none;
  }

  .toggle input:checked ~ .toggle-thumb {
    transform: translateX(18px);
  }

  .toggle input:focus-visible + .toggle-track {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* ── Accordion expansion panel ─────────────────────────────────── */
  .addon-panel {
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition:
      max-height 350ms cubic-bezier(0.4, 0, 0.2, 1),
      opacity 250ms ease;
    /* Left indent aligns with addon-body (36px icon + 14px gap = 50px) */
    padding: 0 4px 0 54px;
  }

  .addon-panel.open {
    max-height: 480px;
    opacity: 1;
  }

  .addon-panel-inner {
    padding-bottom: 20px;
  }

  .panel-question {
    font-size: var(--text-sm, 0.8125rem);
    color: var(--color-text-secondary);
    margin-bottom: 12px;
  }

  /* ── Voice option: single pre-selected line ────────────────────── */
  .voice-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .voice-option-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--color-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
  }

  .voice-option-dot-inner {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-primary);
  }

  .voice-option-text {
    font-size: var(--text-base, 0.875rem);
    color: var(--color-text);
    font-weight: 500;
  }

  .voice-option-sub {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-tertiary);
    margin-top: 2px;
  }

  /* ── Form fields inside accordion panels ───────────────────────── */
  .field-group {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field-label {
    font-size: var(--text-sm, 0.8125rem);
    font-weight: 600;
    color: var(--color-text);
    display: block;
    margin-bottom: 5px;
  }

  .field-input {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--color-border-hover);
    border-radius: var(--radius-md, 8px);
    background: var(--color-surface);
    font-family: inherit;
    font-size: var(--text-base, 0.875rem);
    color: var(--color-text);
    transition: border-color 150ms, box-shadow 150ms;
    appearance: none;
  }

  .field-input::placeholder {
    color: var(--color-text-tertiary);
  }

  .field-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  .field-help {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-tertiary);
    margin-top: 5px;
    line-height: 1.5;
  }

  .field-help a {
    color: var(--color-primary);
    text-underline-offset: 2px;
    text-decoration: underline;
  }

  .field-help a:hover {
    color: var(--color-primary-hover);
  }

  /* ── Responsive ────────────────────────────────────────────────── */
  @media (max-width: 600px) {
    .addon-panel {
      padding-left: 4px;
    }
  }
</style>
