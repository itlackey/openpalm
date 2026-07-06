<script lang="ts">
  import { onMount } from 'svelte';
  import "../app.css";
  import UpdateBanner from '@openpalm/ui-kit/components/common/UpdateBanner.svelte';
  import Toast from '@openpalm/ui-kit/components/common/Toast.svelte';
  import { themeService } from '$lib/theme-state.svelte.js';
  import { detectClientDisplayMode } from '$lib/client-context.js';
  import { initializeRuntimeContext } from '$lib/runtime-context.svelte.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import { voiceState } from '$lib/voice/voice-state.svelte.js';

  interface Props {
    data: import('./$types').LayoutData;
    children?: import('svelte').Snippet;
  }

  let { children, data }: Props = $props();

  // Components read capabilities via hasCapability()/runtimeContext only
  // (plan §8.6) — the legacy admin feature-flag alias survives solely in
  // server code (hooks.server.ts / +layout.server.ts) pending Phase 4.

  onMount(() => {
    themeService.init();
    // Runtime context (plan ui-runtime-modes-plan.md Phase 1, #509): the
    // client display mode is browser-detected — never server-computed — so it
    // is initialized in onMount (client-only; also avoids mutating the
    // module-level store during SSR, which is shared across requests). Like
    // `features`, the server context is env-derived and constant at runtime,
    // so a one-time init is correct; effectiveCapabilities is (re)derived
    // inside initializeRuntimeContext.
    initializeRuntimeContext(data.serverRuntimeContext, {
      displayMode: detectClientDisplayMode(),
    });
  });

  // Mirror voice errors into the toast queue so the voice subsystem's
  // error surface renders through the single <Toast /> outlet below. This
  // lives in APP code — not in ui-kit's Toast — because voice-state depends
  // on $lib/api (POST /api/transcribe), a server assumption ui-kit source
  // must never carry (plan ui-runtime-modes-plan.md §6.11; enforced by
  // packages/ui-kit/tests/no-app-coupling.test.ts). Consecutive errors
  // reuse the same toast id so they update in place instead of stacking.
  let voiceErrorToastId: string | null = null;
  $effect(() => {
    const msg = voiceState.errorMessage;
    if (!msg) return;
    voiceErrorToastId = notifications.push('error', msg, {
      replaceId: voiceErrorToastId ?? undefined,
    });
    voiceState.errorMessage = '';
  });
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
