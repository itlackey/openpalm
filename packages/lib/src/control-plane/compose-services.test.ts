import { describe, expect, test } from 'bun:test';
import { parseComposeServices } from './compose-services.js';

// parseComposeServices is the docker-free discovery parser (catalog/addon
// listing). Volume/bind-mount resolution lives in discoverHomeBindMountSources
// via `compose config --format json` and is covered in discover-bind-mounts.test.ts.

describe('parseComposeServices', () => {
  test('parses service names, profiles, and labels', () => {
    const yaml = [
      'services:',
      '  api:',
      '    profiles: ["addon.api.cpu"]',
      '    labels:',
      '      openpalm.profile.label: API',
      '    volumes:',
      '      - /op/home/knowledge/secrets/auth.json:/app/auth.json:ro',
      '  named:',
      '    volumes:',
      '      - modelcache:/models',
    ].join('\n');

    const services = parseComposeServices(yaml);
    expect(services.map((s) => s.name).sort()).toEqual(['api', 'named']);

    const api = services.find((s) => s.name === 'api');
    expect(api?.profiles).toEqual(['addon.api.cpu']);
    expect(api?.labels['openpalm.profile.label']).toBe('API');
  });

  test('returns [] when there is no services map', () => {
    expect(parseComposeServices('version: "3"')).toEqual([]);
  });
});
