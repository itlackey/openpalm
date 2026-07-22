/**
 * Connection-activation event channel (issue #486).
 *
 * Breaks the endpoints-state ↔ chat-state bidirectional import: the
 * connections store EMITS through this module and the chat side SUBSCRIBES
 * from its own module — the connections store never imports chat code. This
 * keeps the module graph acyclic so the Phase 5 client extraction is file
 * relocation, not surgery.
 *
 * Three hooks:
 *  - activation guards: a subscriber may veto a switch before it starts
 *    (chat registers "not while a reply is streaming");
 *  - activation state: send admission can synchronously refuse work after a
 *    switch starts and before its transport/chat handoff completes;
 *  - activation listeners: awaited after the server accepted the switch
 *    (chat loads the new connection's sessions).
 */

type ActivationListener = (connectionId: string) => unknown | Promise<unknown>;
type ActivationGuard = () => string | null;

const listeners = new Set<ActivationListener>();
const guards = new Set<ActivationGuard>();
let activationsInProgress = 0;

/** Mark activation work active until the returned idempotent release runs. */
export function beginConnectionActivation(): () => void {
  activationsInProgress++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activationsInProgress--;
  };
}

export function connectionActivationInProgress(): boolean {
  return activationsInProgress > 0;
}

/** Subscribe to connection activation. Returns an unsubscribe function. */
export function onConnectionActivated(listener: ActivationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Register a pre-switch veto. Return a user-facing reason string to block
 * the switch, or null to allow it. Returns an unregister function.
 */
export function registerActivationGuard(guard: ActivationGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/** First non-null guard reason blocks the switch; null means proceed. */
export function activationBlockReason(): string | null {
  for (const guard of guards) {
    const reason = guard();
    if (reason) return reason;
  }
  return null;
}

/**
 * Notify subscribers that `connectionId` is now active. Awaited by the
 * emitter: activation is not complete until every subscriber's handoff
 * (e.g. the chat store loading the connection's sessions) has settled.
 */
export async function emitConnectionActivated(connectionId: string): Promise<void> {
  for (const listener of listeners) {
    if ((await listener(connectionId)) === false) {
      throw new Error('Connection activation was refused by a listener.');
    }
  }
}
