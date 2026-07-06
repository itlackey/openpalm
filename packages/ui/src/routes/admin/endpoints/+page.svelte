<!--
  /admin/endpoints is a redirect alias to /connections (plan
  ui-runtime-modes-plan.md Phase 2 step 5, issue #486). The universal load in
  +page.ts always throws redirect(302, '/connections'), so this component
  never renders — the management UI lives at routes/connections/+page.svelte.
-->
