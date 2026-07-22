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
