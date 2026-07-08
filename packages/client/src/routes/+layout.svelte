<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import IconChat from '@openpalm/ui-kit/components/icons/IconChat.svelte';
  import IconConnect from '@openpalm/ui-kit/components/icons/IconConnect.svelte';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  const path = $derived(page.url.pathname);
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

<div class="shell">
  <header class="topbar">
    <a class="brand" href="/chat">OpenPalm</a>
    <nav aria-label="Primary">
      <a href="/chat" class="nav-link" class:current={path.startsWith('/chat')} aria-current={path.startsWith('/chat') ? 'page' : undefined}>
        <IconChat size={14} />
        <span>Chat</span>
      </a>
      <a href="/connections" class="nav-link" class:current={path.startsWith('/connections')} aria-current={path.startsWith('/connections') ? 'page' : undefined}>
        <IconConnect size={14} />
        <span>Connections</span>
      </a>
    </nav>
  </header>

  <div class="content">
    {@render children?.()}
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-4);
    padding: var(--s-sp-3) var(--s-sp-5);
    border-bottom: var(--s-hair) solid var(--s-line);
  }

  .brand {
    font-family: var(--s-font-header);
    font-size: 1.05rem;
    color: var(--s-ink);
    text-decoration: none;
  }

  nav {
    display: flex;
    gap: var(--s-sp-2);
  }

  .nav-link {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.7rem;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    text-decoration: none;
    border-bottom: 2px solid transparent;
  }

  .nav-link:hover {
    color: var(--s-ink);
  }

  .nav-link.current {
    color: var(--s-ink);
    border-bottom-color: var(--s-seal);
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
</style>
