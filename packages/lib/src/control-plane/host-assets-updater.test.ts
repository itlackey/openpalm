import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar } from 'tar';
import { hostAssetsChannel, resolveHostAssetsRelease, stageHostAssetsRelease } from './host-assets-updater.js';
import { declaredUiChannel, uiUpdateChannel } from './ui-assets.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('host-assets channel selection', () => {
  test('maps stable and prerelease platform versions to GitHub channels', () => {
    expect(hostAssetsChannel('0.13.0')).toBe('stable');
    expect(hostAssetsChannel('0.13.0-beta.1')).toBe('prerelease');
  });

  test('explicit channel selection is shared by UI callers', () => {
    expect(uiUpdateChannel('0.13.0', 'prerelease')).toBe('prerelease');
    expect(uiUpdateChannel('0.13.0-beta.1', 'stable')).toBe('stable');
  });

  test('automatic UI and skeleton checks discover the newest channel release', () => {
    const source = readFileSync(new URL('./ui-assets.ts', import.meta.url), 'utf8');
    expect(source).toContain("? 'next' : 'latest'");
    expect(source).not.toContain('resolveHostAssetsRelease(platformVersion');
  });

  test('invalid environment channel does not alter resolution', () => {
    const previous = process.env.OP_UI_CHANNEL;
    process.env.OP_UI_CHANNEL = 'npm';
    expect(declaredUiChannel()).toBeNull();
    if (previous === undefined) delete process.env.OP_UI_CHANNEL;
    else process.env.OP_UI_CHANNEL = previous;
  });

  test('skips malformed release tags while selecting a channel release', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { tag_name: 'release-candidate', prerelease: false, draft: false, assets: [] },
      {
        tag_name: '0.13.1',
        prerelease: false,
        draft: false,
        assets: [
          { name: 'openpalm-host-assets-0.13.1.tar.gz', browser_download_url: 'https://example.test/assets' },
          { name: 'openpalm-host-assets-0.13.1.tar.gz.sha256', browser_download_url: 'https://example.test/checksum' },
        ],
      },
    ]), { status: 200 })) as typeof fetch;

    await expect(resolveHostAssetsRelease('latest')).resolves.toMatchObject({ version: '0.13.1' });
  });

  test('concurrent staging operations use independent directories and archives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-assets-stage-'));
    try {
      const source = join(root, 'source');
      const archive = join(root, 'assets.tar.gz');
      mkdirSync(join(source, 'ui'), { recursive: true });
      mkdirSync(join(source, 'skeleton', 'system', 'stack'), { recursive: true });
      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ platformVersion: '0.13.1', minHarnessContract: 1 }));
      writeFileSync(join(source, 'ui', 'index.js'), 'export {};\n');
      writeFileSync(join(source, 'skeleton', 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
      await createTar({ gzip: true, file: archive, cwd: source }, ['manifest.json', 'ui', 'skeleton']);
      const bytes = Bun.file(archive);
      const archiveBytes = new Uint8Array(await bytes.arrayBuffer());
      const checksum = createHash('sha256').update(archiveBytes).digest('hex');
      globalThis.fetch = (async (input) => String(input).endsWith('.sha256')
        ? new Response(checksum, { status: 200 })
        : new Response(archiveBytes.slice(), { status: 200 })) as typeof fetch;
      const release = {
        version: '0.13.1',
        assetUrl: 'https://example.test/assets.tar.gz',
        checksumUrl: 'https://example.test/assets.tar.gz.sha256',
        manifest: { platformVersion: '0.13.1', minHarnessContract: 1 },
      };

      const [first, second] = await Promise.all([
        stageHostAssetsRelease({ ...release }, root),
        stageHostAssetsRelease({ ...release }, root),
      ]);

      expect(first).not.toBe(second);
      expect(existsSync(join(first, 'ui', 'index.js'))).toBe(true);
      expect(existsSync(join(second, 'ui', 'index.js'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
