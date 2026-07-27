import { describe, expect, test } from 'bun:test';
import type { ControlPlaneState } from '@openpalm/lib';
import { runDoctorAction, type DoctorDeps } from './doctor.ts';

// This file deliberately never calls `mock.module('@openpalm/lib', ...)`.
// `doctor.ts` takes an injectable `deps` object (mirroring the
// `ProjectRenameDeps` pattern already used in `project-rename.ts`) precisely
// so this test never touches process-global module state — a whole-module
// mock of `@openpalm/lib` was observed to leak into unrelated test files
// elsewhere in the suite once enough files did it, breaking tests with no
// relation to doctor at all. Dependency injection sidesteps that class of
// problem entirely.

const fakeState = { homeDir: '/tmp/fake-home' } as unknown as ControlPlaneState;

const okDockerResult = { ok: true, stdout: '24.0.0', stderr: '', code: 0 };
const okStorageReport = {
  homeDir: '/tmp/fake-home',
  filesystem: { path: '/tmp/fake-home', freeBytes: 10_000_000_000, totalBytes: 100_000_000_000, measurementFailed: false },
  caches: [],
  totalCacheBytes: 0,
  toolTrees: [],
  totalToolTreeBytes: 0,
  openCodeStore: [],
  totalOpenCodeStoreBytes: 0,
  backups: { relativePath: 'data/backups', path: '/tmp/fake-home/data/backups', exists: false, bytes: 0 },
  docker: { reliable: true, images: [], supersededImages: [], volumes: [], orphanVolumes: [] },
};
const okDiskHeadroom = {
  path: '/tmp/fake-home',
  status: 'ok' as const,
  freeBytes: 10_000_000_000,
  totalBytes: 100_000_000_000,
  measurementFailed: false,
  lowThresholdBytes: 1,
  criticalThresholdBytes: 1,
};

function baseDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    resolveServeState: () => fakeState,
    checkDocker: async () => okDockerResult,
    checkDockerCompose: async () => okDockerResult,
    detectRuntime: async () => ({ dockerPresent: true, composeAvailable: true }),
    detectGpu: async () => null,
    detectLocalProviders: async () => [],
    probeInstallPorts: async () => [],
    checkDiskHeadroom: () => okDiskHeadroom,
    describeDiskHeadroom: () => null,
    buildStorageReport: async () => okStorageReport,
    formatStorageReport: () => 'Storage report: (stub)',
    reportImagesAndVolumes: async () => ({ reliable: true, images: [], supersededImages: [], volumes: [], orphanVolumes: [] }),
    resolveComposeProjectName: () => 'openpalm',
    readStackEnv: () => ({}),
    cleanCaches: () => ({ removed: [], freedBytes: 0, dryRun: false }),
    cleanupImagesAndVolumes: async () => ({ removedImages: [], removedVolumes: [], errors: [] }),
    promptYesNo: async () => false,
    ...overrides,
  } as DoctorDeps;
}

const silentConsole = { log: () => {}, warn: () => {} };

describe('openpalm doctor — registration', () => {
  test('registers the doctor subcommand in the main command map, exposing meta.name "doctor"', async () => {
    const { mainCommand } = await import('../main.ts');
    const sub = (mainCommand.subCommands as Record<string, () => Promise<unknown>>).doctor;
    expect(typeof sub).toBe('function');
    const cmd = (await sub()) as { meta?: { name?: string } };
    expect(cmd.meta?.name).toBe('doctor');
  });
});

describe('openpalm doctor — composes checks without throwing', () => {
  test('Docker absent (ENOENT) is handled — report reflects the failure instead of throwing', async () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = silentConsole.log;
    console.warn = silentConsole.warn;
    try {
      const deps = baseDeps({
        checkDocker: async () => ({ ok: false, stdout: '', stderr: '', code: 1, errorCode: 'ENOENT' }),
        checkDockerCompose: async () => ({ ok: false, stdout: '', stderr: '', code: 1, errorCode: 'ENOENT' }),
        detectRuntime: async () => ({ dockerPresent: false, composeAvailable: false }),
        probeInstallPorts: async () => [
          { port: 3880, service: 'admin', blocking: true, available: false, ownership: 'unreachable' },
        ],
      });

      const report = await runDoctorAction({ json: true }, deps);

      expect(report.docker.ok).toBe(false);
      // reportImagesAndVolumes is never even reached when docker.ok is false — the
      // doctor-level default is used instead of calling out to the (unreachable) docker daemon.
      expect(report.dockerArtifacts.reliable).toBe(false);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
  });

  test('a fully healthy Docker composes a full report with no cleanup actions requested', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    try {
      const deps = baseDeps({
        probeInstallPorts: async () => [
          { port: 3880, service: 'admin', blocking: true, available: true },
          { port: 3800, service: 'ui', blocking: true, available: true },
          { port: 3810, service: 'assistant', blocking: true, available: true },
        ],
      });

      const report = await runDoctorAction({}, deps);

      expect(report.docker.ok).toBe(true);
      expect(report.ports).toHaveLength(3);
      expect(report.cleanCachesResult).toBeUndefined();
      expect(report.cleanDockerResult).toBeUndefined();
    } finally {
      console.log = originalLog;
    }
  });

  test('--clean-caches with --yes calls cleanCaches with confirm:true and reports what was freed', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    try {
      let cleanCachesCalledWith: unknown;
      const deps = baseDeps({
        buildStorageReport: async () => ({
          ...okStorageReport,
          totalCacheBytes: 512,
          caches: [{ relativePath: 'data/assistant/.cache', path: '/tmp/fake-home/data/assistant/.cache', exists: true, bytes: 512 }],
        }),
        cleanCaches: (dir: string, opts: unknown) => {
          cleanCachesCalledWith = { dir, opts };
          return { removed: ['data/assistant/.cache'], freedBytes: 512, dryRun: false };
        },
      });

      const report = await runDoctorAction({ cleanCaches: true, yes: true }, deps);

      expect(cleanCachesCalledWith).toEqual({ dir: '/tmp/fake-home', opts: { confirm: true } });
      expect(report.cleanCachesResult?.removed).toEqual(['data/assistant/.cache']);
      expect(report.cleanCachesResult?.freedBytes).toBe(512);
    } finally {
      console.log = originalLog;
    }
  });

  test('--clean-docker without --yes and a declined prompt skips the destructive action', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    try {
      let cleanupCalled = false;
      const deps = baseDeps({
        reportImagesAndVolumes: async () => ({
          reliable: true,
          images: [{ repository: 'openpalm/assistant', tag: '0.12.0', id: 'abc', createdAt: '2024-01-01', size: '1GB' }],
          supersededImages: [{ repository: 'openpalm/assistant', tag: '0.12.0', id: 'abc', createdAt: '2024-01-01', size: '1GB' }],
          volumes: [],
          orphanVolumes: [],
        }),
        cleanupImagesAndVolumes: async () => {
          cleanupCalled = true;
          return { removedImages: [], removedVolumes: [], errors: [] };
        },
        promptYesNo: async () => false, // operator declines the confirmation
      });

      const report = await runDoctorAction({ cleanDocker: true, yes: false }, deps);

      expect(cleanupCalled).toBe(false);
      expect(report.cleanDockerResult?.skipped).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test('--clean-docker with --yes calls cleanupImagesAndVolumes with confirm:true', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    try {
      let cleanupCalledWith: unknown;
      const dockerReport = {
        reliable: true,
        images: [],
        supersededImages: [{ repository: 'openpalm/assistant', tag: '0.12.0', id: 'abc', createdAt: '2024-01-01', size: '1GB' }],
        volumes: [],
        orphanVolumes: [{ name: 'oldname_assistant-artifacts', driver: 'local' }],
      };
      const deps = baseDeps({
        reportImagesAndVolumes: async () => dockerReport,
        cleanupImagesAndVolumes: async (report: unknown, opts: unknown) => {
          cleanupCalledWith = { report, opts };
          return { removedImages: ['abc'], removedVolumes: ['oldname_assistant-artifacts'], errors: [] };
        },
      });

      const report = await runDoctorAction({ cleanDocker: true, yes: true }, deps);

      expect(cleanupCalledWith).toEqual({ report: dockerReport, opts: { confirm: true } });
      expect(report.cleanDockerResult?.removedImages).toEqual(['abc']);
    } finally {
      console.log = originalLog;
    }
  });
});
