import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_LOCKED_CONNECTION_ID,
  ASSISTANT_LOCKED_CONNECTION_LABEL,
  ASSISTANT_SAME_ORIGIN_PATH,
  buildEmptyUiRuntimeConfig,
  buildLockedAssistantRuntimeConfig,
  buildServedUiRuntimeConfig,
  seedLegacyServedUiRuntimeConfig,
  uiBuildSupportsProcessRuntimeConfig,
  UI_RUNTIME_CONFIG_ENDPOINT_MARKER,
  writeLegacyServedUiRuntimeConfig,
} from './ui-runtime-config.js';
import { parseUiRuntimeConfigJson, serializeUiRuntimeConfig } from './ui-runtime-config-schema.js';

describe('ui runtime config', () => {
  test('builds one locked default connection in the UI store shape (baseUrl, no kind)', () => {
    expect(buildLockedAssistantRuntimeConfig('http://127.0.0.1:3800')).toEqual({
      connections: [
        {
          id: 'openpalm-assistant-opencode',
          label: 'Local assistant',
          baseUrl: 'http://127.0.0.1:3800',
          auth: { mode: 'none' },
          isDefault: true,
          locked: true,
        },
      ],
    });
  });

  test('uses the detected project name as the connection label', () => {
    expect(buildLockedAssistantRuntimeConfig('http://127.0.0.1:3810', 'splinter').connections[0]?.label).toBe(
      'splinter',
    );
  });

  test('strips URL userinfo before a runtime connection can be served', () => {
    const config = buildLockedAssistantRuntimeConfig('https://user:password@assistant.example');
    expect(config.connections[0]?.baseUrl).toBe('https://assistant.example/');
    expect(JSON.stringify(config)).not.toContain('password');
  });

  test('builds an explicit empty config for a stack-less client process', () => {
    expect(buildEmptyUiRuntimeConfig()).toEqual({ connections: [] });
  });

  test('accepts the root-relative same-origin path as a baseUrl', () => {
    expect(buildLockedAssistantRuntimeConfig(ASSISTANT_SAME_ORIGIN_PATH).connections[0]?.baseUrl)
      .toBe('/oc');
  });

  test('rejects a path that could resolve off this origin', () => {
    // A protocol-relative "//host" is an ORIGIN, not a path, and a path
    // carrying userinfo/query/fragment can redirect the concatenated API calls.
    for (const bad of ['//evil.example/oc', '/oc?to=evil', '/oc#x', '/u@evil.example']) {
      expect(() => buildLockedAssistantRuntimeConfig(bad)).toThrow();
    }
  });

  test('seeds the same-origin proxy path for an installed home, not an absolute URL', () => {
    // The host-served UI (openpalm ui serve / admin / Electron) runs the same
    // /oc route as the container. An absolute URL here would keep those
    // clients calling OpenCode cross-origin, which grants no CORS origin.
    const home = mkdtempSync(join(tmpdir(), 'ui-runtime-config-installed-'));
    try {
      mkdirSync(join(home, 'system', 'stack'), { recursive: true });
      writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
      mkdirSync(join(home, 'state'), { recursive: true });
      writeFileSync(join(home, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');

      expect(buildServedUiRuntimeConfig(home, { OP_PROJECT_NAME: 'splinter' }))
        .toEqual(buildLockedAssistantRuntimeConfig('/oc', 'splinter'));

      // The server-side upstream must NOT leak into the browser's seed — it
      // names an address only this process can reach.
      expect(buildServedUiRuntimeConfig(home, {
        OP_OPENCODE_URL: 'http://localhost:4096',
        OP_ASSISTANT_PORT: '3810',
      }).connections[0]?.baseUrl).toBe('/oc');

      // OP_UI_DEFAULT_ASSISTANT_URL is the one browser-facing override, and
      // still wins — same precedence as the container entrypoint.
      expect(buildServedUiRuntimeConfig(home, {
        OP_UI_DEFAULT_ASSISTANT_URL: 'https://assistant.example',
        OP_PROJECT_NAME: 'splinter',
      })).toEqual(buildLockedAssistantRuntimeConfig('https://assistant.example', 'splinter'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('does not seed a fake locked local connection for an uninstalled home', () => {
    const home = mkdtempSync(join(tmpdir(), 'ui-runtime-config-uninstalled-'));
    try {
      expect(buildServedUiRuntimeConfig(home, {
        OP_UI_DEFAULT_ASSISTANT_URL: 'http://127.0.0.1:3810',
      })).toEqual({ connections: [] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('degrades an invalid assistant URL to no default connection', () => {
    expect(buildServedUiRuntimeConfig('/missing', {
      OP_UI_DEFAULT_ASSISTANT_URL: 'not a URL',
    })).toEqual({ connections: [] });
  });

  // The lib writer and the container entrypoint's inline JS writer must agree on
  // the locked-connection id/label. Exporting them as named constants lets the
  // container lane pin entrypoint.sh's literal against this value.
  test('exports the locked connection id/label as named constants matching the built connection', () => {
    expect(ASSISTANT_LOCKED_CONNECTION_ID).toBe('openpalm-assistant-opencode');
    expect(ASSISTANT_LOCKED_CONNECTION_LABEL).toBe('Local assistant');
    const built = buildLockedAssistantRuntimeConfig('http://127.0.0.1:3800').connections[0];
    expect(built.id).toBe(ASSISTANT_LOCKED_CONNECTION_ID);
    expect(built.label).toBe(ASSISTANT_LOCKED_CONNECTION_LABEL);
  });

  describe('process runtime config JSON', () => {
    test('serializes and validates a typed config', () => {
      const config = buildLockedAssistantRuntimeConfig('http://127.0.0.1:3810');
      expect(parseUiRuntimeConfigJson(serializeUiRuntimeConfig(config))).toEqual({
        status: 'valid',
        config,
      });
    });

    test('distinguishes an absent value from malformed or unsafe values', () => {
      expect(parseUiRuntimeConfigJson(undefined)).toEqual({ status: 'absent' });
      expect(parseUiRuntimeConfigJson('{')).toEqual({ status: 'invalid' });
      expect(parseUiRuntimeConfigJson('{"connections":[{"id":7}]}')).toEqual({ status: 'invalid' });
      expect(parseUiRuntimeConfigJson(JSON.stringify({
        connections: [
          { id: 'unsafe', label: 'Unsafe', baseUrl: 'javascript:alert(1)', auth: { mode: 'none' } },
        ],
      }))).toEqual({ status: 'invalid' });
      expect(parseUiRuntimeConfigJson(JSON.stringify({
        connections: [
          { id: 'secret', label: 'Secret', baseUrl: 'https://user:password@example.test', auth: { mode: 'none' } },
        ],
      }))).toEqual({ status: 'invalid' });
      expect(parseUiRuntimeConfigJson(JSON.stringify({
        connections: [
          { id: 'same', label: 'One', baseUrl: 'http://localhost:1', auth: { mode: 'none' } },
          { id: 'same', label: 'Two', baseUrl: 'http://localhost:2', auth: { mode: 'none' } },
        ],
      }))).toEqual({ status: 'invalid' });
    });
  });

  test('writes static config only for legacy UI artifacts without the endpoint marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-runtime-config-capability-'));
    try {
      mkdirSync(join(dir, 'system', 'stack'), { recursive: true });
      writeFileSync(join(dir, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
      mkdirSync(join(dir, 'state'), { recursive: true });
      writeFileSync(join(dir, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
      expect(uiBuildSupportsProcessRuntimeConfig(dir)).toBe(false);
      seedLegacyServedUiRuntimeConfig(dir, dir, {
        OP_UI_DEFAULT_ASSISTANT_URL: 'https://assistant.example',
      });
      expect(JSON.parse(readFileSync(join(dir, 'client', 'runtime-config.json'), 'utf8'))).toEqual(
        buildLockedAssistantRuntimeConfig('https://assistant.example'),
      );

      writeFileSync(join(dir, UI_RUNTIME_CONFIG_ENDPOINT_MARKER), '1\n');
      mkdirSync(join(dir, 'client'), { recursive: true });
      writeFileSync(join(dir, 'client', 'runtime-config.json'), '{"sentinel":true}\n');
      expect(uiBuildSupportsProcessRuntimeConfig(dir)).toBe(true);
      seedLegacyServedUiRuntimeConfig(dir, dir, {
        OP_UI_DEFAULT_ASSISTANT_URL: 'https://changed.example',
      });
      expect(JSON.parse(readFileSync(join(dir, 'client', 'runtime-config.json'), 'utf8'))).toEqual({ sentinel: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('legacy compatibility seeding stays empty before local installation', () => {
    const home = mkdtempSync(join(tmpdir(), 'ui-runtime-config-legacy-uninstalled-'));
    const uiDir = mkdtempSync(join(tmpdir(), 'ui-runtime-config-legacy-build-'));
    try {
      seedLegacyServedUiRuntimeConfig(uiDir, home, {
        OP_UI_DEFAULT_ASSISTANT_URL: 'http://127.0.0.1:3810',
      });
      expect(JSON.parse(readFileSync(join(uiDir, 'client', 'runtime-config.json'), 'utf8'))).toEqual({
        connections: [],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(uiDir, { recursive: true, force: true });
    }
  });

  test('legacy compatibility seeding is best-effort', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-runtime-config-readonly-'));
    try {
      writeFileSync(join(dir, 'client'), 'not a directory');
      expect(() => writeLegacyServedUiRuntimeConfig(dir, buildEmptyUiRuntimeConfig())).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the assistant static fallback strips URL userinfo before writing public config', () => {
    const entrypoint = readFileSync(
      new URL('../../../../containers/assistant/entrypoint.sh', import.meta.url),
      'utf8',
    );
    expect(entrypoint).toContain('parsedUrl.username = ""');
    expect(entrypoint).toContain('parsedUrl.password = ""');
  });

  test('the container entrypoint seeds the SAME same-origin path as this writer', () => {
    const entrypoint = readFileSync(
      new URL('../../../../containers/assistant/entrypoint.sh', import.meta.url),
      'utf8',
    );
    expect(entrypoint).toContain(`\${OP_UI_DEFAULT_ASSISTANT_URL:-${ASSISTANT_SAME_ORIGIN_PATH}}`);
  });
});
