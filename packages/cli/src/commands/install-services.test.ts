import { describe, expect, it } from 'bun:test';
import { buildDeployStatusEntries } from './install-services.ts';

describe('install service helpers', () => {
  it('builds deploy status entries for the install service list', () => {
    const services = ['memory', 'assistant'];

    expect(buildDeployStatusEntries(services, 'pending', 'Waiting...')).toEqual([
      { service: 'memory', status: 'pending', label: 'Waiting...' },
      { service: 'assistant', status: 'pending', label: 'Waiting...' },
    ]);
  });
});
