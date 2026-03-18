import { describe, expect, it } from 'bun:test';
import { buildDeployStatusEntries, buildInstallServiceNames } from './install-services.ts';

describe('install service helpers', () => {
  it('passes managed services through unchanged', () => {
    expect(buildInstallServiceNames(['memory', 'assistant'])).toEqual([
      'memory',
      'assistant',
    ]);
  });

  it('includes admin services when they are in managed list', () => {
    expect(buildInstallServiceNames(['memory', 'caddy', 'admin', 'docker-socket-proxy'])).toEqual([
      'memory',
      'caddy',
      'admin',
      'docker-socket-proxy',
    ]);
  });

  it('builds deploy status entries for the full install service list', () => {
    const services = buildInstallServiceNames(['memory', 'assistant']);

    expect(buildDeployStatusEntries(services, 'pending', 'Waiting...')).toEqual([
      { service: 'memory', status: 'pending', label: 'Waiting...' },
      { service: 'assistant', status: 'pending', label: 'Waiting...' },
    ]);
  });
});
