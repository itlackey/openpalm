export type StackImpact = {
  reload: string[];
  restart: string[];
  up: string[];
  down: string[];
};

export function createEmptyImpact(): StackImpact {
  return { reload: [], restart: [], up: [], down: [] };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function computeImpactFromChanges(changes: {
  caddyChanged?: boolean;
  gatewaySecretsChanged?: boolean;
  channelConfigChanged?: string[];
  opencodeChanged?: boolean;
  openmemoryChanged?: boolean;
}): StackImpact {
  const impact = createEmptyImpact();
  if (changes.caddyChanged) impact.reload.push("caddy");
  if (changes.gatewaySecretsChanged) impact.restart.push("gateway");
  for (const service of changes.channelConfigChanged ?? []) impact.restart.push(service);
  if (changes.opencodeChanged) impact.restart.push("opencode-core");
  if (changes.openmemoryChanged) impact.restart.push("openmemory");
  impact.reload = unique(impact.reload);
  impact.restart = unique(impact.restart);
  return impact;
}
