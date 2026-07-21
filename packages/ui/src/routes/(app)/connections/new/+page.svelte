<!--
  /connections/new is a redirect alias to /connections?new=1. The universal load in +page.ts
  always throws redirect(302), so this component never renders — the
  management UI lives at the grouped /connections route.
-->
