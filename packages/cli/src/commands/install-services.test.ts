import { describe, expect, it } from 'bun:test';
import { buildDeployStatusEntries, buildInstallServiceNames } from './install-services.ts';

describe('install service helpers', () => {
  it('appends admin services to managed services', () => {
    expect(buildInstallServiceNames(['caddy', 'memory'])).toEqual([
      'caddy',
      'memory',
      'admin',
      'docker-socket-proxy',
    ]);
  });

  it('builds deploy status entries for the full install service list', () => {
    const services = buildInstallServiceNames(['caddy', 'memory']);

    expect(buildDeployStatusEntries(services, 'pending', 'Waiting...')).toEqual([
      { service: 'caddy', status: 'pending', label: 'Waiting...' },
      { service: 'memory', status: 'pending', label: 'Waiting...' },
      { service: 'admin', status: 'pending', label: 'Waiting...' },
      { service: 'docker-socket-proxy', status: 'pending', label: 'Waiting...' },
    ]);
  });
});
