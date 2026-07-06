/**
 * Landing resolver for the client app (plan ui-runtime-modes-plan.md §6.5
 * pwa-static branch; P5b item 3, #555).
 *
 * The client app has no host capabilities, no LaunchState, no migration
 * gate — its resolver is the §6.5 client branch only, keyed off the stored
 * connection list. Pure and synchronous: the boot code awaits the store's
 * list() and hands the array in; resolution is data-in, path-out (same
 * discipline as packages/ui/src/lib/resolve-landing.ts).
 */
export function resolveLanding(connections: ReadonlyArray<{ id: string }>): string {
  return connections.length === 0 ? '/connections/new' : '/chat';
}
