import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(fileURLToPath(new URL('./DeployStep.svelte', import.meta.url)), 'utf-8');

describe('DeployStep optional-service warning copy', () => {
  test('says failed optional addons remain enabled without claiming model readiness', () => {
    expect(SOURCE).toContain('Optional services with startup warnings:');
    expect(SOURCE).toContain('optional services did not start');
    expect(SOURCE).toContain('These addons remain enabled');
    expect(SOURCE).toContain('Features that depend on them may be unavailable');
    expect(SOURCE).toContain('{#if deployData.imageWarning && !deployHasWarnings}');
    expect(SOURCE).not.toContain('Optional services skipped:');
    expect(SOURCE).not.toContain('The core assistant is ready');
    expect(SOURCE).not.toContain('Still warming up:');
    expect(SOURCE).not.toContain('these will be ready shortly');
  });
});
