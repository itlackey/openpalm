export type DeployStatusState = 'pending' | 'pulling';

export function buildInstallServiceNames(managedServices: string[]): string[] {
  return [...managedServices];
}

export function buildDeployStatusEntries(
  services: string[],
  status: DeployStatusState,
  label: string,
): Array<{ service: string; status: DeployStatusState; label: string }> {
  return services.map(service => ({ service, status, label }));
}
