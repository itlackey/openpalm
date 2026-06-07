<script lang="ts">
  import type { Snippet } from 'svelte';
  import IconButton from '$lib/components/common/IconButton.svelte';

  // A two-state button built on IconButton. When `pressed` it adopts the
  // selected colour (primary, or danger via `tone`) and, if provided, swaps to
  // `selectedIcon` — the pattern the speaker (on/off) and theme (sun/moon)
  // toggles use. Rendering goes through IconButton so the base style never
  // diverges from the rest of the chrome.
  interface Props {
    pressed: boolean;
    onToggle: () => void;
    /** Icon shown when off (and when on, if no selectedIcon is given). */
    icon: Snippet;
    /** Optional distinct icon shown when on. */
    selectedIcon?: Snippet;
    label?: string;
    title?: string;
    ariaLabel?: string;
    disabled?: boolean;
    /** Colour of the on state. */
    tone?: 'primary' | 'danger';
  }

  let {
    pressed,
    onToggle,
    icon,
    selectedIcon,
    label,
    title,
    ariaLabel,
    disabled = false,
    tone = 'primary',
  }: Props = $props();
</script>

<IconButton
  icon={pressed && selectedIcon ? selectedIcon : icon}
  {label}
  {title}
  {ariaLabel}
  {disabled}
  {tone}
  selected={pressed}
  ariaPressed={pressed}
  onclick={onToggle}
/>
