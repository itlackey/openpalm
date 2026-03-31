export type DeployStatusState = 'pending' | 'pulling' | 'error';

export function buildDeployStatusEntries(
  services: string[],
  status: DeployStatusState,
  label: string,
): Array<{ service: string; status: DeployStatusState; label: string }> {
  return services.map(service => ({ service, status, label }));
}
