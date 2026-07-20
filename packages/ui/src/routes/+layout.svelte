<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import "../app.css";
  import UpdateBanner from '@openpalm/ui-kit/components/common/UpdateBanner.svelte';
  import Toast from '@openpalm/ui-kit/components/common/Toast.svelte';
  import { themeService } from '$lib/theme-state.svelte.js';
  import { detectClientDisplayMode } from '$lib/client-context.js';
  import { initializeRuntimeContext, initializeServerRuntimeContext } from '$lib/runtime-context.svelte.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import { onVoiceError } from '$lib/voice/voice-state.svelte.js';

  interface Props {
    data: import('./$types').LayoutData;
    children?: import('svelte').Snippet;
  }

  let { children, data }: Props = $props();

  // Components read capabilities via hasCapability()/runtimeContext only
  // — the legacy admin feature-flag alias survives solely in
  // server code (hooks.server.ts / +layout.server.ts) pending Phase 4.

  // Review 2026-07-10 K2: the server half of the runtime context is
  // env-derived and constant at runtime (like the pre-migration
  // `featuresService.init(data.features)` it replaces) — SAFE to run
  // synchronously here in the script body, which executes during SSR too,
  // unlike onMount. This is what makes host:* capabilities (e.g. the /host
  // admin button) present in the FIRST server-rendered HTML instead of
  // flashing in after client-side hydration. `untrack()` marks this as an
  // intentional one-time read, not a reactive subscription — data.serverRuntimeContext
  // is env-derived and doesn't change within a single navigation. The one
  // request-derived field (publicBaseUrl) is excluded inside
  // initializeServerRuntimeContext and only written in onMount (PR #562
  // review: this store is process-global during SSR).
  untrack(() => initializeServerRuntimeContext(data.serverRuntimeContext));

  // Consecutive errors reuse one toast instead of stacking.
  let voiceErrorToastId: string | null = null;

  onMount(() => {
    themeService.init();
    // The client display mode genuinely needs the browser (matchMedia /
    // navigator) and can't be known during SSR, so ONLY that half still runs
    // here — re-deriving effectiveCapabilities for electron/standalone-pwa
    // displays that differ from the 'browser' default the server-half init
    // above already assumed.
    initializeRuntimeContext(data.serverRuntimeContext, {
      displayMode: detectClientDisplayMode(),
    });
    return onVoiceError((message) => {
      voiceErrorToastId = notifications.push('error', message, {
        replaceId: voiceErrorToastId ?? undefined,
      });
    });
  });

  // Voice errors route through the single <Toast /> outlet below. The listener
  // stays in app code so ui-kit never depends on the app's voice modules.
</script>

<!-- ibrush filter: hand-drawn brush displacement used by all icon components -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <filter id="ibrush" x="-40%" y="-40%" width="180%" height="180%">
      <feTurbulence type="fractalNoise" baseFrequency="0.026 0.032" numOctaves="1" seed="3" result="nA"/>
      <feDisplacementMap in="SourceGraphic" in2="nA" scale="2.4" xChannelSelector="R" yChannelSelector="G" result="dA"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.034 0.028" numOctaves="1" seed="17" result="nB"/>
      <feDisplacementMap in="SourceGraphic" in2="nB" scale="3.0" xChannelSelector="R" yChannelSelector="G" result="dB"/>
      <feMerge result="strokes"><feMergeNode in="dA"/><feMergeNode in="dB"/></feMerge>
      <feTurbulence type="turbulence" baseFrequency="0.7 0.7" numOctaves="2" seed="7" result="g"/>
      <feComponentTransfer in="g" result="gm"><feFuncA type="linear" slope="0.55" intercept="0.52"/></feComponentTransfer>
      <feComposite in="strokes" in2="gm" operator="in"/>
    </filter>
  </defs>
</svg>

<UpdateBanner />
{@render children?.()}
<Toast />
