<script lang="ts">
  import { onMount } from 'svelte';
  import "../app.css";
  import UpdateBanner from '$lib/components/common/UpdateBanner.svelte';
  import Toast from '$lib/components/common/Toast.svelte';
  import { themeService } from '$lib/theme-state.svelte.js';
  import { featuresService } from '$lib/features.svelte.js';

  interface Props {
    data: import('./$types').LayoutData;
    children?: import('svelte').Snippet;
  }

  let { children, data }: Props = $props();

  // Initialize feature flags from server data on every render (SSR + CSR navigations).
  // Env vars don't change at runtime so this is idempotent.
  featuresService.init(data.features);

  onMount(() => {
    themeService.init();
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
