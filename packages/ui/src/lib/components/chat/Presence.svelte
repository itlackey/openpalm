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
      const ripple1 = ensoPath(60, 62, 46);
      const ripple2 = ensoPath(60, 62, 50);
      ensoRippleL1?.setAttribute('d', ripple1);
      ensoRippleL2?.setAttribute('d', ripple2);
      ensoRippleS1?.setAttribute('d', ripple1);
      ensoRippleS2?.setAttribute('d', ripple2);
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
    <path class="s-ripple s-ripple-speak s-r1" bind:this={ensoRippleS1}></path>
    <path class="s-ripple s-ripple-speak s-r2" bind:this={ensoRippleS2}></path>
    <path class="s-ripple s-ripple-listen s-l1" bind:this={ensoRippleL1}></path>
    <path class="s-ripple s-ripple-listen s-l2" bind:this={ensoRippleL2}></path>
    <path class="s-wet" bind:this={ensoWet}></path>
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

  /* Tap ring — appears on hover and while listening */
  .s-presence--mic::before {
    content: '';
    position: absolute;
    inset: -10px;
    border-radius: 50%;
    border: 1px solid transparent;
    transition: border-color 0.4s var(--s-ease);
    pointer-events: none;
  }

  .s-presence--mic {
    cursor: pointer;
  }

  .s-presence--mic:hover::before,
  .s-presence.listening::before {
    border-color: color-mix(in srgb, var(--s-seal) 22%, transparent);
  }

  .s-presence--mic:hover .s-dry {
    stroke: color-mix(in srgb, var(--s-ink) 75%, var(--s-seal));
    transition: stroke 0.3s var(--s-ease);
  }

  /* Processing — faster breath + seal tint while assistant is thinking */
  .s-presence.processing {
    animation: s-breathe-quick 1.8s ease-in-out infinite;
  }

  .s-presence.processing .s-dry {
    stroke: color-mix(in srgb, var(--s-ink) 55%, var(--s-seal));
    transition: stroke 0.6s var(--s-ease);
  }

  .s-presence.processing .s-wet {
    opacity: 0.28;
    transition: opacity 0.6s var(--s-ease);
  }

  @keyframes s-breathe-quick {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.08); }
  }

  .s-presence.breathing {
    animation: s-breathe var(--s-breathe-dur) ease-in-out infinite;
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

  @keyframes s-listen-in {
    0%   { opacity: 0;   transform: scale(1.32) rotate(-6deg); }
    50%  { opacity: .32; }
    100% { opacity: 0;   transform: scale(.96) rotate(3deg); }
  }

  .s-presence.speaking .s-ripple-speak {
    animation: s-speak-out 4s var(--s-ease) infinite;
  }

  .s-presence.speaking .s-ripple-speak.s-r2 {
    animation-delay: 2s;
  }

  @keyframes s-speak-out {
    0%   { opacity: .3; transform: scale(.9) rotate(-3deg); }
    100% { opacity: 0;  transform: scale(1.34) rotate(6deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .s-presence { animation: none !important; }
    .s-ripple { animation: none !important; }
    .s-presence.listening .s-ripple-listen { opacity: 0.22; }
    .s-presence.speaking  .s-ripple-speak  { opacity: 0.22; }
  }
</style>
