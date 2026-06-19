<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    voiceEnabled: boolean;
    sending: boolean;
    voiceStatus: string;
    onToggle: () => void;
  }

  const { voiceEnabled, sending, voiceStatus, onToggle }: Props = $props();

  let ensoDry = $state<SVGPathElement | undefined>();
  let ensoWet = $state<SVGPathElement | undefined>();
  let ensoProc = $state<SVGPathElement | undefined>();
  let ensoEcho = $state<SVGPathElement | undefined>();
  let ensoRippleL1 = $state<SVGPathElement | undefined>();
  let ensoRippleL2 = $state<SVGPathElement | undefined>();
  let ensoRippleS1 = $state<SVGPathElement | undefined>();
  let ensoRippleS2 = $state<SVGPathElement | undefined>();
  let presenceEl = $state<HTMLDivElement | undefined>();
  let drawLen = 0;
  let ensoReady = false;

  function ensoPath(cx: number, cy: number, r: number): string {
    const start = -0.62 * Math.PI;
    const end = 1.30 * Math.PI;
    const steps = 130;
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = start + (end - start) * t;
      const wobble = Math.sin(a * 3.1 + 1) * 1.4 + Math.sin(a * 7.3) * 0.7;
      const taper = Math.sin(t * Math.PI);
      const rr = r + wobble + taper * 2.2;
      const x = cx + rr * Math.cos(a);
      const y = cy + rr * Math.sin(a);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
    }
    return d;
  }

  function drawEnso(): void {
    if (!ensoDry || !ensoWet || !presenceEl) return;
    presenceEl.classList.remove('breathing');
    [ensoDry, ensoWet].forEach(p => {
      p.style.transition = 'none';
      p.style.strokeDasharray = String(drawLen);
      p.style.strokeDashoffset = String(drawLen);
    });
    void ensoDry.getBoundingClientRect();
    [ensoDry, ensoWet].forEach(p => {
      p.style.transition = 'stroke-dashoffset var(--s-t-draw) var(--s-ease-draw)';
      p.style.strokeDashoffset = '0';
    });
  }

  function restEnso(): void {
    if (!ensoDry || !ensoWet || !presenceEl) return;
    [ensoDry, ensoWet].forEach(p => {
      p.style.transition = 'opacity 0.6s ease';
      p.style.strokeDasharray = 'none';
    });
    presenceEl.classList.add('breathing');
  }

  $effect(() => {
    if (!ensoReady) return;
    if (sending) {
      drawEnso();
    } else {
      restEnso();
    }
  });

  onMount(() => {
    if (ensoDry && ensoWet) {
      const path = ensoPath(60, 62, 44);
      ensoDry.setAttribute('d', path);
      ensoWet.setAttribute('d', path);
      ensoProc?.setAttribute('d', path);
      ensoEcho?.setAttribute('d', ensoPath(60, 62, 50));
      const rippleA = ensoPath(60, 62, 44);
      const rippleB = ensoPath(60, 62, 43.4);
      ensoRippleL1?.setAttribute('d', rippleA);
      ensoRippleL2?.setAttribute('d', rippleB);
      ensoRippleS1?.setAttribute('d', rippleA);
      ensoRippleS2?.setAttribute('d', rippleB);
      try { drawLen = ensoDry.getTotalLength(); } catch { drawLen = 360; }
      drawEnso();
      setTimeout(() => {
        restEnso();
        ensoReady = true;
      }, 2400);
    }
  });
</script>

<!-- SVG filter defs: ink brush + bloom -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <filter id="s-brush" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.026" numOctaves="2" seed="7" result="t"/>
      <feDisplacementMap in="SourceGraphic" in2="t" scale="3.4" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="s-bloom" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="2.4"/>
    </filter>
  </defs>
</svg>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="s-presence breathing"
  id="s-presence"
  bind:this={presenceEl}
  class:listening={voiceStatus === 'recording'}
  class:speaking={voiceStatus === 'speaking'}
  class:s-presence--mic={voiceEnabled}
  class:processing={sending}
  role={voiceEnabled ? 'button' : undefined}
  tabindex={voiceEnabled ? 0 : undefined}
  aria-label={voiceEnabled ? (voiceStatus === 'recording' ? 'Stop listening' : 'Speak to the agent') : undefined}
  aria-pressed={voiceEnabled ? voiceStatus === 'recording' : undefined}
  onclick={voiceEnabled ? onToggle : undefined}
  onkeydown={voiceEnabled ? (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } } : undefined}
>
  <svg class="s-enso" viewBox="0 0 120 120" id="s-enso" aria-hidden="true">
    <path class="s-echo" bind:this={ensoEcho}></path>
    <path class="s-ripple s-ripple-speak s-r1" bind:this={ensoRippleS1}></path>
    <path class="s-ripple s-ripple-speak s-r2" bind:this={ensoRippleS2}></path>
    <path class="s-ripple s-ripple-listen s-l1" bind:this={ensoRippleL1}></path>
    <path class="s-ripple s-ripple-listen s-l2" bind:this={ensoRippleL2}></path>
    <path class="s-wet" bind:this={ensoWet}></path>
    <path class="s-dry" bind:this={ensoDry}></path>
    <path class="s-proc" bind:this={ensoProc}></path>
  </svg>
</div>

<style>
  .s-presence {
    width: var(--s-enso-size);
    height: var(--s-enso-size);
    margin-bottom: 0.5rem;
    position: relative;
  }

  .s-presence--mic {
    cursor: pointer;
  }

  /* At rest — gentle breath on the whole presence */
  .s-presence.breathing {
    animation: s-breathe var(--s-breathe-dur) ease-in-out infinite;
  }

  @keyframes s-breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.04); }
  }

  /* Pointer over — sway animation on the SVG, ink tinted toward seal */
  .s-presence--mic:hover .s-enso {
    animation: s-over-sway 3.2s var(--s-ease) infinite;
    transform-box: fill-box;
    transform-origin: center;
  }

  .s-presence--mic:hover .s-dry {
    stroke: color-mix(in srgb, var(--s-ink) 80%, var(--s-seal));
    transition: stroke 0.3s var(--s-ease);
  }

  @keyframes s-over-sway {
    0%, 100% { transform: rotate(-2.6deg) scale(1.05); }
    50%       { transform: rotate(2.6deg)  scale(1.05); }
  }

  /* Processing — seal comet orbits the ring; dry stroke recedes toward paper */
  .s-proc {
    fill: none;
    stroke: var(--s-seal);
    stroke-width: 3.2;
    stroke-linecap: round;
    filter: url(#s-brush);
    opacity: 0;
  }

  .s-presence.processing .s-proc {
    opacity: 1;
    stroke-dasharray: 46 232;
    animation: s-proc-orbit 1.5s linear infinite;
  }

  @keyframes s-proc-orbit {
    to { stroke-dashoffset: -278; }
  }

  .s-presence.processing .s-dry {
    stroke: color-mix(in srgb, var(--s-ink) 50%, var(--s-paper));
    transition: stroke 0.6s var(--s-ease);
  }

  .s-presence.processing .s-wet {
    opacity: 0.28;
    transition: opacity 0.6s var(--s-ease);
  }

  /* Mic affordance — brushed echo ring at r=50, visible only when voice is enabled */
  .s-echo {
    fill: none;
    stroke: var(--s-ink);
    opacity: 0;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: url(#s-brush);
  }

  .s-presence--mic .s-echo {
    opacity: 0.13;
  }

  .s-enso {
    overflow: visible;
  }

  .s-dry {
    fill: none;
    stroke: var(--s-ink);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: url(#s-brush);
    transition: stroke var(--s-t-theme) var(--s-ease);
  }

  .s-wet {
    fill: none;
    stroke: var(--s-ink);
    opacity: 0.16;
    stroke-width: 6.5;
    filter: url(#s-bloom);
  }

  /* ── Enso ripple states (voice listening / speaking) ─────────────── */

  .s-ripple {
    fill: none;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0;
    filter: url(#s-brush);
    transform-box: fill-box;
    transform-origin: center;
    pointer-events: none;
  }

  .s-ripple-listen { stroke: var(--s-seal); }
  .s-ripple-speak  { stroke: var(--s-ink); }

  .s-presence.listening .s-dry {
    stroke: color-mix(in srgb, var(--s-ink) 74%, var(--s-seal));
  }

  .s-presence.listening .s-ripple-listen {
    animation: s-listen-in 4s var(--s-ease) infinite;
  }

  .s-presence.listening .s-ripple-listen.s-l2 {
    animation-delay: 2s;
  }

  /* Ripples gather INWARD — they shrink toward the center */
  @keyframes s-listen-in {
    0%   { opacity: 0;   transform: scale(.92) rotate(-6deg); }
    45%  { opacity: .34; }
    100% { opacity: 0;   transform: scale(.58) rotate(4deg); }
  }

  .s-presence.speaking .s-ripple-speak {
    animation: s-speak-out 4s var(--s-ease) infinite;
  }

  .s-presence.speaking .s-ripple-speak.s-r2 {
    animation-delay: 2s;
  }

  @keyframes s-speak-out {
    0%   { opacity: .3; transform: scale(.9)  rotate(-3deg); }
    100% { opacity: 0;  transform: scale(1.34) rotate(6deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .s-presence { animation: none !important; }
    .s-enso { animation: none !important; }
    .s-ripple { animation: none !important; }
    .s-proc { animation: none !important; }
    .s-presence.listening .s-ripple-listen { opacity: 0.22; }
    .s-presence.speaking  .s-ripple-speak  { opacity: 0.22; }
  }
</style>
