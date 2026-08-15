/**
 * The bundle contract: these constants and encodings must match what
 * scripts/opencode-web/build.sh bakes into the app, or /advanced frames a
 * shell that talks to the wrong place (or deep-links into the project list).
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPENCODE_WEB_PREFIX,
  OPENCODE_WEB_SERVER_PATH,
  opencodeWebSessionUrl,
  opencodeWebShellUrl,
} from './opencode-web.js';

const buildScript = readFileSync(
  join(__dirname, '../../../../scripts/opencode-web/build.sh'),
  'utf8',
);

describe('opencode-web constants pin the build script', () => {
  test('the served prefix matches --base', () => {
    expect(buildScript).toContain(`--base=${OPENCODE_WEB_PREFIX}/`);
  });

  test('the server path matches VITE_OPENCODE_SERVER_URL', () => {
    expect(buildScript).toContain(`VITE_OPENCODE_SERVER_URL=${OPENCODE_WEB_SERVER_PATH}`);
  });

  test('the bundle output lands where the static server serves this prefix', () => {
    expect(buildScript).toContain(`packages/ui/static${OPENCODE_WEB_PREFIX}`);
  });
});

describe('opencodeWebSessionUrl', () => {
  test('builds the app’s server-scoped session route', () => {
    // Their route is /server/<base64url(server key)>/session/<id>, where the
    // server key is `<origin>/oc` — the URL the bundle is built to talk to.
    const url = opencodeWebSessionUrl('http://192.168.0.201:3800', 'ses_123');
    const key = Buffer.from('http://192.168.0.201:3800/oc')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    expect(url).toBe(`${OPENCODE_WEB_PREFIX}/server/${key}/session/ses_123`);
  });

  test('uses URL-safe base64 without padding — their encoder, byte for byte', () => {
    // An origin whose key encodes to something containing '+' or '/' in plain
    // base64 must be translated, and padding stripped, exactly as OpenCode's
    // base64Encode does — or the route segment fails their round-trip check.
    const url = opencodeWebSessionUrl('https://a.example:8443', 's');
    const segment = url.split('/server/')[1].split('/session/')[0];
    expect(segment).not.toMatch(/[+/=]/);
  });

  test('the shell URL is the prefix with a trailing slash', () => {
    expect(opencodeWebShellUrl()).toBe(`${OPENCODE_WEB_PREFIX}/`);
  });
});
