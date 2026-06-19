<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    voiceEnabled: boolean;
    sending: boolean;
    voiceStatus: string;
    onToggle: () => void;
  }

  const { voiceEnabled, sending, voiceStatus, onToggle }: Props = $props();

  const LOGO = "M60.1244 5L62.0057 27.9635L64.4287 9.00887L79.3326 5.24671L79.9277 25.889L81.4519 17.468L95 13.7365L91.3023 74.2325L80.2203 94.5104L76.8802 92.6756L87.5529 73.1466L90.8727 18.8331L84.7715 20.5135L80.424 44.5332L76.6468 44.2474L75.6626 10.1107L67.8764 12.0762L63.4799 46.4686L59.6931 46.3822L56.7419 10.3574L47.8228 13.7251V50.3803L44.0772 50.8677L34.1996 13.3604L26.7978 17.3103C28.0204 24.0062 29.6096 35.4296 30.9221 45.4104C31.6281 50.779 32.2566 55.7505 32.7086 59.3796C32.9346 61.1942 33.1165 62.6735 33.2419 63.6994C33.4531 65.4268 33.66 67.1548 33.8682 68.8826L12.9705 58.0378L9.48426 67.1466L36.7143 92.186L34.1399 95L5 68.2044L10.9401 52.6845L29.2165 62.169C29.1313 61.4788 29.0351 60.7026 28.9293 59.8527C28.478 56.2295 27.8507 51.2671 27.1461 45.9095C25.7337 35.1688 24.0214 22.9203 22.7978 16.6515L22.5269 15.2638L36.6546 7.72465L44.0141 35.6703V11.0829L60.1244 5Z";

  let ensoDry = $state<SVGPathElement | undefined>();
  let ensoWet = $state<SVGPathElement | undefined>();
  let ensoDraw = $state<SVGPathElement | undefined>();
  let ensoEcho = $state<SVGPathElement | undefined>();
  let ensoRippleL1 = $state<SVGPathElement | undefined>();
  let ensoRippleL2 = $state<SVGPathElement | undefined>();
  let ensoRippleS1 = $state<SVGPathElement | undefined>();
  let ensoRippleS2 = $state<SVGPathElement | undefined>();
  let presenceEl = $state<HTMLDivElement | undefined>();
  let drawLen = 0;
  let ensoReady = false;

  function drawEnso(): void {
    if (!ensoDraw || !ensoDry || !presenceEl) return;
    presenceEl.classList.remove('breathing');
    ensoDry.style.opacity = '0';
    ensoDraw.style.transition = 'none';
    ensoDraw.style.opacity = '1';
    ensoDraw.style.strokeDasharray = String(drawLen);
    ensoDraw.style.strokeDashoffset = String(drawLen);
    void ensoDraw.getBoundingClientRect();
    ensoDraw.style.transition = 'stroke-dashoffset var(--s-t-draw) var(--s-ease-draw)';
    ensoDraw.style.strokeDashoffset = '0';
  }

  function restEnso(): void {
    if (!ensoDraw || !ensoDry || !presenceEl) return;
    ensoDry.style.transition = 'opacity 0.6s ease';
    ensoDry.style.opacity = '1';
    ensoDraw.style.transition = 'opacity 0.4s ease';
    ensoDraw.style.opacity = '0';
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
    [ensoDry, ensoWet, ensoEcho, ensoDraw, ensoRippleL1, ensoRippleL2, ensoRippleS1, ensoRippleS2].forEach(el => {
      el?.setAttribute('d', LOGO);
    });
    try { drawLen = ensoDraw!.getTotalLength(); } catch { drawLen = 400; }
    drawEnso();
    setTimeout(() => {
      restEnso();
      ensoReady = true;
    }, 2400);
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
  <svg class="s-enso" viewBox="0 0 100 100" aria-hidden="true">
    <!-- Echo ring: brushed outline at scale(1.14), visible only when voice enabled -->
    <path class="s-echo" bind:this={ensoEcho}></path>
    <!-- Speaking ripples: expand outward -->
    <path class="s-ripple s-ripple-speak s-r1" bind:this={ensoRippleS1}></path>
    <path class="s-ripple s-ripple-speak s-r2" bind:this={ensoRippleS2}></path>
    <!-- Listening ripples: gather inward -->
    <path class="s-ripple s-ripple-listen s-l1" bind:this={ensoRippleL1}></path>
    <path class="s-ripple s-ripple-listen s-l2" bind:this={ensoRippleL2}></path>
    <!-- Wet: blurred fill bloom behind the mark -->
    <path class="s-wet" bind:this={ensoWet}></path>
    <!-- Draw: stroke-only overlay used only during the initial trace animation -->
    <path class="s-draw" bind:this={ensoDraw}></path>
    <!-- Dry: the crisp brushed filled mark -->
    <path class="s-dry" bind:this={ensoDry}></path>
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

  .s-enso {
    overflow: visible;
    width: 100%;
    height: 100%;
    display: block;
  }

  /* Filled mark — the crisp brushed logo shape */
  .s-dry {
    fill: var(--s-ink);
    filter: url(#s-brush);
    transition: fill var(--s-t-theme) var(--s-ease), opacity 0.6s ease;
  }

  /* Blurred bloom behind the mark */
  .s-wet {
    fill: var(--s-ink);
    opacity: 0.14;
    filter: url(#s-bloom);
    transition: fill var(--s-t-theme) var(--s-ease), opacity var(--s-t-theme) var(--s-ease);
  }

  /* Draw overlay: stroke-only, used during the initial trace animation */
  .s-draw {
    fill: none;
    stroke: var(--s-ink);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: url(#s-brush);
    opacity: 0;
    pointer-events: none;
  }

  /* Echo ring: brushed stroke at scale(1.14), signals mic interactivity */
  .s-echo {
    fill: none;
    stroke: var(--s-ink);
    opacity: 0;
    stroke-width: 1.4;
    stroke-linejoin: round;
    filter: url(#s-brush);
    transform-box: fill-box;
    transform-origin: center;
    transform: scale(1.14);
  }

  .s-presence--mic .s-echo {
    opacity: 0.13;
  }

  /* ── Listening — seal ripples gather inward ─────────────────────────── */

  .s-presence.listening .s-dry {
    fill: var(--s-seal);
  }

  .s-ripple {
    fill: var(--s-ink);
    opacity: 0;
    filter: url(#s-brush);
    transform-box: fill-box;
    transform-origin: center;
    pointer-events: none;
  }

  .s-ripple-listen { fill: var(--s-seal); }
  .s-ripple-speak  { fill: var(--s-ink); }

  .s-presence.listening .s-ripple-listen {
    animation: s-listen-in 4s var(--s-ease) infinite;
  }

  .s-presence.listening .s-ripple-listen.s-l2 {
    animation-delay: 2s;
  }

  @keyframes s-listen-in {
    0%   { opacity: 0;   transform: scale(.92) rotate(-6deg); }
    45%  { opacity: .22; }
    100% { opacity: 0;   transform: scale(.58) rotate(4deg); }
  }

  /* ── Speaking — ink ripples expand outward ──────────────────────────── */

  .s-presence.speaking .s-ripple-speak {
    animation: s-speak-out 4s var(--s-ease) infinite;
  }

  .s-presence.speaking .s-ripple-speak.s-r2 {
    animation-delay: 2s;
  }

  @keyframes s-speak-out {
    0%   { opacity: .2;  transform: scale(.9)  rotate(-3deg); }
    100% { opacity: 0;   transform: scale(1.34) rotate(6deg); }
  }

  /* ── Pointer over — awake sway (rotation + slight lift) ────────────── */

  .s-presence--mic:hover .s-enso {
    animation: s-over-sway 3.2s var(--s-ease) infinite;
    transform-box: fill-box;
    transform-origin: center;
  }

  @keyframes s-over-sway {
    0%, 100% { transform: rotate(-2.6deg) scale(1.05); }
    50%       { transform: rotate(2.6deg)  scale(1.05); }
  }

  /* ── Processing — mark dims, seal bloom pulses behind it ───────────── */

  .s-presence.processing .s-dry {
    fill: var(--s-ink-2);
  }

  .s-presence.processing .s-wet {
    fill: var(--s-seal);
    animation: s-proc-pulse 1.8s var(--s-ease) infinite;
    transform-box: fill-box;
    transform-origin: center;
  }

  @keyframes s-proc-pulse {
    0%, 100% { opacity: .10; transform: scale(.97); }
    50%       { opacity: .30; transform: scale(1.13); }
  }

  @media (prefers-reduced-motion: reduce) {
    .s-presence { animation: none !important; }
    .s-enso { animation: none !important; }
    .s-ripple { animation: none !important; }
    .s-presence.processing .s-wet { animation: none !important; }
    .s-presence.listening .s-ripple-listen { opacity: 0.22; }
    .s-presence.speaking  .s-ripple-speak  { opacity: 0.22; }
  }
</style>
