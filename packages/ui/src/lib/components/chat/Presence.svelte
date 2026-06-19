<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    voiceEnabled: boolean;
    sending: boolean;
    voiceStatus: string;
    onToggle: () => void;
    height?: number;
  }

  const { voiceEnabled, sending, voiceStatus, onToggle, height }: Props = $props();

  const LOGO = "M60.1244 5L62.0057 27.9635L64.4287 9.00887L79.3326 5.24671L79.9277 25.889L81.4519 17.468L95 13.7365L91.3023 74.2325L80.2203 94.5104L76.8802 92.6756L87.5529 73.1466L90.8727 18.8331L84.7715 20.5135L80.424 44.5332L76.6468 44.2474L75.6626 10.1107L67.8764 12.0762L63.4799 46.4686L59.6931 46.3822L56.7419 10.3574L47.8228 13.7251V50.3803L44.0772 50.8677L34.1996 13.3604L26.7978 17.3103C28.0204 24.0062 29.6096 35.4296 30.9221 45.4104C31.6281 50.779 32.2566 55.7505 32.7086 59.3796C32.9346 61.1942 33.1165 62.6735 33.2419 63.6994C33.4531 65.4268 33.66 67.1548 33.8682 68.8826L12.9705 58.0378L9.48426 67.1466L36.7143 92.186L34.1399 95L5 68.2044L10.9401 52.6845L29.2165 62.169C29.1313 61.4788 29.0351 60.7026 28.9293 59.8527C28.478 56.2295 27.8507 51.2671 27.1461 45.9095C25.7337 35.1688 24.0214 22.9203 22.7978 16.6515L22.5269 15.2638L36.6546 7.72465L44.0141 35.6703V11.0829L60.1244 5Z";

  let ensoDry = $state<SVGPathElement | undefined>();
  let ensoWet = $state<SVGPathElement | undefined>();
  let ensoDraw = $state<SVGPathElement | undefined>();
  let ensoEcho = $state<SVGPathElement | undefined>();
  let ensoRippleL1 = $state<SVGPathElement | undefined>();
  let ensoRippleL2 = $state<SVGPathElement | undefined>();
  let presenceEl = $state<HTMLDivElement | undefined>();
  let drawLen = 0;
  let ensoReady = false;

  // Fades logo in or out. Must go through JS because restEnso/drawEnso both set
  // inline opacity on ensoDry — inline styles always win over CSS class rules.
  function setLogoVisible(visible: boolean): void {
    if (!ensoDry) return;
    ensoDry.style.transition = 'opacity 0.45s var(--s-ease-settle)';
    ensoDry.style.opacity = visible ? '1' : '0';
  }

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
    setLogoVisible(true);
    ensoDraw.style.transition = 'opacity 0.4s ease';
    ensoDraw.style.opacity = '0';
    presenceEl.classList.add('breathing');
  }

  // Single effect owns all visual-state transitions so state transitions never race.
  $effect(() => {
    if (!ensoReady) return;
    const speaking = voiceStatus === 'speaking';

    if (sending) {
      drawEnso();
    } else if (speaking) {
      // Remove breathing pulse; hide logo with a smooth crossfade; draw overlay off.
      if (presenceEl) presenceEl.classList.remove('breathing');
      if (ensoDraw) { ensoDraw.style.transition = 'opacity 0.4s ease'; ensoDraw.style.opacity = '0'; }
      setLogoVisible(false);
    } else {
      restEnso();
    }
  });

  onMount(() => {
    [ensoDry, ensoWet, ensoEcho, ensoDraw, ensoRippleL1, ensoRippleL2].forEach(el => {
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
    <!--
      Wave-brush: matches the #ibrush icon filter pipeline exactly — two displacement
      passes merged, then grained — but uses filterUnits="userSpaceOnUse" so the filter
      region doesn't collapse to zero for vertical <line> elements (which have zero
      geometric width, making percentage-based regions invisible).
    -->
    <filter id="s-wave-brush" filterUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">
      <feTurbulence type="fractalNoise" baseFrequency="0.026 0.032" numOctaves="1" seed="3" result="nA"/>
      <feDisplacementMap in="SourceGraphic" in2="nA" scale="2.4" xChannelSelector="R" yChannelSelector="G" result="dA"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.034 0.028" numOctaves="1" seed="17" result="nB"/>
      <feDisplacementMap in="SourceGraphic" in2="nB" scale="3.0" xChannelSelector="R" yChannelSelector="G" result="dB"/>
      <feMerge result="strokes"><feMergeNode in="dA"/><feMergeNode in="dB"/></feMerge>
      <feTurbulence type="turbulence" baseFrequency="0.7 0.7" numOctaves="2" seed="7" result="g"/>
      <feComponentTransfer in="g" result="gm"><feFuncA type="linear" slope="0.55" intercept="0.52"/></feComponentTransfer>
      <feComposite in="strokes" in2="gm" operator="in"/>
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
  style={height != null ? `--s-enso-size: ${height}px` : undefined}
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
    <!-- Listening ripples: gather inward -->
    <path class="s-ripple s-ripple-listen s-l1" bind:this={ensoRippleL1}></path>
    <path class="s-ripple s-ripple-listen s-l2" bind:this={ensoRippleL2}></path>
    <!-- Wet: blurred fill bloom behind the mark -->
    <path class="s-wet" bind:this={ensoWet}></path>
    <!-- Draw: stroke-only overlay used only during the initial trace animation -->
    <path class="s-draw" bind:this={ensoDraw}></path>
    <!-- Dry: the crisp brushed filled mark -->
    <path class="s-dry" bind:this={ensoDry}></path>
    <!--
      Waveform: speaking state indicator — 5 stroked lines, bell-curve heights
      matching the design system icon recipe (stroke-linecap:round, fill:none,
      brush filter). scaleY compresses line length but not stroke-width, so bars
      stay legible at any component size. Centers at x = 18/32/46/60/74.
    -->
    <g class="s-waveform" aria-hidden="true">
      <line class="s-waveform-bar s-wb1" x1="18" y1="38" x2="18" y2="62"/>
      <line class="s-waveform-bar s-wb2" x1="32" y1="24" x2="32" y2="76"/>
      <line class="s-waveform-bar s-wb3" x1="46" y1="12" x2="46" y2="88"/>
      <line class="s-waveform-bar s-wb4" x1="60" y1="18" x2="60" y2="82"/>
      <line class="s-waveform-bar s-wb5" x1="74" y1="32" x2="74" y2="68"/>
    </g>
  </svg>
</div>

<style>
  .s-presence {
    width: var(--s-enso-size);
    height: var(--s-enso-size);
    margin-bottom: 0.5rem;
    position: relative;
    will-change: transform;
  }

  .s-presence--mic {
    cursor: pointer;
  }

  /* At rest — organic breath: scale holds at peak like a real inhale */
  .s-presence.breathing {
    animation: s-breathe var(--s-breathe-dur) ease-in-out infinite;
  }

  @keyframes s-breathe {
    0%   { transform: scale(1)     rotate(-0.4deg); }
    38%  { transform: scale(1.055) rotate(0.4deg);  }
    58%  { transform: scale(1.055) rotate(0.4deg);  }
    100% { transform: scale(1)     rotate(-0.4deg); }
  }

  .s-enso {
    overflow: visible;
    width: 100%;
    height: 100%;
    display: block;
    /* Spring transition for smooth hover enter/exit — cubic-bezier overshoots
       slightly past the target then settles, giving a natural physical feel.
       Only `transform` and `opacity` are animated (GPU composited, no reflow). */
    transition: transform 0.65s cubic-bezier(0.34, 1.56, 0.64, 1);
    will-change: transform;
  }

  /* Filled mark — the crisp brushed logo shape */
  .s-dry {
    fill: var(--s-ink);
    filter: url(#s-brush);
    /* opacity is managed entirely via JS (inline style) to avoid specificity
       conflicts with restEnso/drawEnso — no CSS opacity rule here */
    transition: fill var(--s-t-theme) var(--s-ease);
  }

  /* Blurred bloom behind the mark */
  .s-wet {
    fill: var(--s-ink);
    opacity: 0.14;
    filter: url(#s-bloom);
    /* Wet has no inline-style opacity set by JS, so CSS transitions work cleanly */
    transition: fill var(--s-t-theme) var(--s-ease), opacity 0.5s var(--s-ease-settle);
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
    transition: opacity var(--s-t-settle) var(--s-ease-settle);
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

  .s-presence.listening .s-ripple-listen {
    animation: s-listen-in 3.8s var(--s-ease) infinite;
  }

  .s-presence.listening .s-ripple-listen.s-l2 {
    animation-delay: 1.9s;
  }

  @keyframes s-listen-in {
    0%   { opacity: 0;    transform: scale(0.95) rotate(-5deg); }
    18%  { opacity: 0.28; }
    75%  { opacity: 0.16; }
    100% { opacity: 0;    transform: scale(0.50) rotate(5deg); }
  }

  /* ── Speaking — waveform crossfades over the logo ───────────────────── */

  /* Wet bloom + echo ring: CSS-managed, both fade during speaking */
  .s-presence.speaking .s-wet,
  .s-presence.speaking .s-echo {
    opacity: 0;
  }

  /*
    Waveform group: 5 stroke paths scaled to the 100×100 viewBox, following the
    design system's icon recipe — stroke 1.5 on 24×24 ≈ stroke 7 on 100×100,
    round caps, class="s"-equivalent brush displacement filter.
  */
  .s-waveform {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.4s var(--s-ease-settle);
  }

  .s-presence.speaking .s-waveform {
    opacity: 1;
  }

  .s-waveform-bar {
    /* Stroked lines match the design system icon recipe: round caps, fill:none,
       brush filter. scaleY compresses line length but not the horizontal
       stroke-width, so bars stay visible at height=32 unlike the earlier rect
       approach where fill-scaling caused sub-pixel invisibility. */
    fill: none;
    stroke: var(--s-seal);
    stroke-width: 7;
    stroke-linecap: round;
    filter: url(#s-wave-brush);
    transform-box: fill-box;
    transform-origin: 50% 50%;
    transform: scaleY(0.25);
  }

  /*
    Sine-like easing: slow at extremes (bar "hangs" at peak/trough — physical
    inertia of a speaker cone), fast through the midpoint. Each bar gets its
    own peak height so the waveform has natural amplitude variation.
  */
  @keyframes s-wave1 { from { transform: scaleY(0.22); } to { transform: scaleY(0.72); } }
  @keyframes s-wave2 { from { transform: scaleY(0.18); } to { transform: scaleY(1.00); } }
  @keyframes s-wave3 { from { transform: scaleY(0.14); } to { transform: scaleY(1.00); } }
  @keyframes s-wave4 { from { transform: scaleY(0.20); } to { transform: scaleY(0.88); } }
  @keyframes s-wave5 { from { transform: scaleY(0.24); } to { transform: scaleY(0.66); } }

  /*
    Five bars: prime-number-like durations ensure no two bars ever phase-lock.
    easeInOutSine cubic-bezier gives the speaker-cone weight at peaks/troughs.
  */
  .s-presence.speaking .s-wb1 { animation: s-wave1 0.91s cubic-bezier(0.37, 0, 0.63, 1) 0.00s infinite alternate both; }
  .s-presence.speaking .s-wb2 { animation: s-wave2 0.67s cubic-bezier(0.37, 0, 0.63, 1) 0.13s infinite alternate both; }
  .s-presence.speaking .s-wb3 { animation: s-wave3 0.79s cubic-bezier(0.37, 0, 0.63, 1) 0.05s infinite alternate both; }
  .s-presence.speaking .s-wb4 { animation: s-wave4 0.59s cubic-bezier(0.37, 0, 0.63, 1) 0.19s infinite alternate both; }
  .s-presence.speaking .s-wb5 { animation: s-wave5 0.83s cubic-bezier(0.37, 0, 0.63, 1) 0.08s infinite alternate both; }

  /* ── Pointer over — spring lift ─────────────────────────────────────
     A single stable lifted state entered/exited via the spring transition
     on .s-enso. No loop animation — loops can't enter/exit cleanly because
     CSS can't transition INTO a running animation mid-cycle. The parent's
     breathing continues independently and provides gentle oscillation while
     hovered (the transforms compose: wrapper breathes, child is lifted).
     On hover-out the spring returns it to rest with a matching overshoot. */

  .s-presence--mic:hover .s-enso {
    transform: scale(1.09) rotate(1.8deg);
  }

  /* ── Processing — mark dims, seal bloom pulses behind it ───────────── */

  .s-presence.processing .s-dry {
    fill: var(--s-ink-2);
  }

  .s-presence.processing .s-wet {
    fill: var(--s-seal);
    animation: s-proc-pulse 2.2s var(--s-ease-settle) infinite;
    transform-box: fill-box;
    transform-origin: center;
  }

  @keyframes s-proc-pulse {
    0%   { opacity: .07; transform: scale(.94); }
    45%  { opacity: .26; transform: scale(1.14); }
    100% { opacity: .07; transform: scale(.94); }
  }

  @media (prefers-reduced-motion: reduce) {
    .s-presence { animation: none !important; }
    .s-enso { animation: none !important; transition: none !important; }
    .s-ripple { animation: none !important; }
    .s-waveform-bar { animation: none !important; transform: scaleY(0.6) !important; }
    .s-presence.processing .s-wet { animation: none !important; }
    .s-presence.listening .s-ripple-listen { opacity: 0.22; }
    .s-presence.speaking .s-waveform { opacity: 1; }
    .s-presence.speaking .s-waveform-bar { transform: scaleY(0.6) !important; }
  }
</style>
