import { buildChatPath } from '$lib/conversation-paths.js';

type StartRuntimeContext = {
  effectiveCapabilities: readonly string[];
};

type StartConnections = {
  endpoints: ReadonlyArray<{ id: string }>;
  activeId: string;
  error: string;
  load(force?: boolean): Promise<void>;
  localDiscoverySettled(): Promise<void>;
};

export type StartBootstrapResult =
  | { kind: 'choice' }
  | { kind: 'navigate'; href: string };

export async function bootstrapStart(
  runtimeContext: StartRuntimeContext,
  connections: StartConnections,
  force = false,
): Promise<StartBootstrapResult> {
  await connections.load(force);
  if (connections.error) throw new Error(connections.error);

  // F11: an active connection is already known — the common case (a
  // locked/config-owned default, or a connection chosen on a prior visit,
  // e.g. every "/" navigation on the container UI). Go straight to it rather
  // than waiting out localDiscoverySettled()'s up-to-~3s of loopback probe
  // timeouts below, which exists only to give a genuinely EMPTY connection
  // list a chance to find a local assistant before falling back to the
  // setup/connect choice.
  const alreadyActive = connections.endpoints.find(
    (connection) => connection.id === connections.activeId,
  );
  if (alreadyActive) {
    return { kind: 'navigate', href: buildChatPath(null, alreadyActive.id) };
  }

  await connections.localDiscoverySettled();
  if (connections.error) throw new Error(connections.error);

  const active = connections.endpoints.find((connection) => connection.id === connections.activeId);
  if (active) {
    return { kind: 'navigate', href: buildChatPath(null, active.id) };
  }

  return runtimeContext.effectiveCapabilities.includes('host:setup')
    ? { kind: 'choice' }
    : { kind: 'navigate', href: '/connections/new?onboarding=1' };
}
