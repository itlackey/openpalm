export type StackImpact = {
  reload: string[];
  restart: string[];
  up: string[];
  down: string[];
  fullStack?: boolean;
};

export function createEmptyImpact(): StackImpact {
  return { reload: [], restart: [], up: [], down: [] };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function diffServiceSets(existing: string[], next: string[]): { added: string[]; removed: string[] } {
  const existingSet = new Set(existing);
  const nextSet = new Set(next);
  const added = next.filter((svc) => !existingSet.has(svc));
  const removed = existing.filter((svc) => !nextSet.has(svc));
  return { added, removed };
}

export function computeImpactFromChanges(changes: {
  caddyChanged?: boolean;
  gatewaySecretsChanged?: boolean;
  channelConfigChanged?: string[];
  assistantChanged?: boolean;
  openmemoryChanged?: boolean;
  serviceConfigChanges?: string[];
  dependentRestarts?: string[];
}): StackImpact {
  const impact = createEmptyImpact();
  if (changes.caddyChanged) impact.reload.push("caddy");
  if (changes.gatewaySecretsChanged) impact.restart.push("gateway");
  for (const service of changes.channelConfigChanged ?? []) impact.restart.push(service);
  if (changes.assistantChanged) impact.restart.push("assistant");
  if (changes.openmemoryChanged) impact.restart.push("openmemory");
  for (const service of changes.serviceConfigChanges ?? []) impact.restart.push(service);
  for (const service of changes.dependentRestarts ?? []) impact.restart.push(service);
  impact.reload = unique(impact.reload);
  impact.restart = unique(impact.restart);
  return impact;
}
