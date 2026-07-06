<!--
  /connections/new is a redirect alias to /connections?new=1 (plan
  ui-runtime-modes-plan.md §6.5). The universal load in +page.ts always
  throws redirect(302), so this component never renders — the management UI
  lives at routes/connections/+page.svelte.
-->
