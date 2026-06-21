// CI assertion: the UI build's `minHarnessContract` must be <= the Electron
// harness's `HARNESS_CONTRACT_VERSION`. A mismatch only manifests at runtime
// (users see a "please re-download" prompt) so this test catches it in CI.
//
// `minHarnessContract` lives in packages/ui/package.json (not a source
// constant) because it travels with the published @openpalm/ui build. We read
// it from the source package.json here so the assertion fires on every commit.
//
// Run via vitest (Node): bun run --cwd packages/electron test
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_CONTRACT_VERSION } from '../src/harness-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiPkgPath = resolve(__dirname, '../../ui/package.json');
const uiPkg = JSON.parse(readFileSync(uiPkgPath, 'utf-8')) as {
  minHarnessContract?: number;
  version?: string;
};

describe('harness contract compatibility', () => {
  it('packages/ui/package.json declares minHarnessContract', () => {
    expect(typeof uiPkg.minHarnessContract).toBe('number');
  });

  it('UI minHarnessContract <= Electron HARNESS_CONTRACT_VERSION', () => {
    // If this fails, either:
    //   (a) The UI added a dependency on a new IPC method / spawn env key and
    //       bumped minHarnessContract without a matching HARNESS_CONTRACT_VERSION
    //       bump in packages/electron/src/harness-contract.ts, OR
    //   (b) The Electron harness was downgraded without lowering the UI contract.
    //
    // Fix: bump HARNESS_CONTRACT_VERSION in harness-contract.ts to match, then
    // update the snapshot test in main.test.ts, and release a new Electron build.
    const minHarnessContract = uiPkg.minHarnessContract ?? 0;
    expect(minHarnessContract).toBeLessThanOrEqual(HARNESS_CONTRACT_VERSION);
  });
});
