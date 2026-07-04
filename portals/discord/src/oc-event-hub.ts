/**
 * The per-principal shared /event hub now lives in the shared SDK
 * (`@openpalm/portal-sdk`) so BOTH portals and the buffered path route through
 * the same implementation. Re-exported here to preserve the existing local
 * import site.
 */
export { OcEventHub, type EventSubscription } from '@openpalm/portal-sdk';
