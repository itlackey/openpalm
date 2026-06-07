<script lang="ts">
  import { resolveSessionTitle } from '$lib/session-title.js';

  // Renders a session's display title: OpenCode's default "New session - <ISO>"
  // (assigned when it couldn't auto-name the session) is parsed and shown as a
  // formatted date/time; any real title passes through. See $lib/session-title.
  interface Props {
    title: string | null | undefined;
  }
  let { title }: Props = $props();

  const display = $derived(resolveSessionTitle(title));
</script>

{display}
