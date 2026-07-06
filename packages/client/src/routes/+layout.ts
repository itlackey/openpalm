/**
 * Pure SPA (plan ui-runtime-modes-plan.md §6.10/§6.11): no SSR, no
 * prerendered pages — adapter-static emits the index.html fallback and
 * every route renders in the browser against IndexedDB + the per-connection
 * transports. There is no server runtime in this artifact at all.
 */
export const ssr = false;
export const prerender = false;
