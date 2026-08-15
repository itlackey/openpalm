import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ControlPlaneState } from '@openpalm/lib';
import { doctorReportHasFailure, runDoctorAction, type DoctorDeps } from './doctor.ts';

// This file deliberately never calls `mock.module('@openpalm/lib', ...)`.
// `doctor.ts` takes an injectable `deps` object (mirroring the
// `ProjectRenameDeps` pattern already used in `project-rename.ts`) precisely
// so this test never touches process-global module state — a whole-module
// mock of `@openpalm/lib` was observed to leak into unrelated test files
// elsewhere in the suite once enough files did it, breaking tests with no
// relation to doctor at all. Dependency injection sidesteps that class of
// problem entirely.

const fakeState = {
  homeDir: '/tmp/fake-home',
  stackDir: '/tmp/fake-home/system/stack',
} as unknown as ControlPlaneState;

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
    // Instant no-op defaults: neither check should ever hit the network/docker
    // in a unit test unless a test overrides them to exercise the reconcile
    // logic (see the "port-probe reconciliation" describe block below).
    checkExistingUiInstance: async () => ({ status: 'absent' as const }),
    checkDiskHeadroom: () => okDiskHeadroom,
    describeDiskHeadroom: () => null,
    buildStorageReport: async () => okStorageReport,
    formatStorageReport: () => 'Storage report: (stub)',
    reportImagesAndVolumes: async () => ({ reliable: true, images: [], supersededImages: [], volumes: [], orphanVolumes: [] }),
    resolveComposeProjectName: () => 'openpalm',
    readStackEnv: () => ({}),
    cleanCaches: () => ({ removed: [], freedBytes: 0, dryRun: false }),
    cleanupImagesAndVolumes: async () => ({ removedImages: [], removedVolumes: [], errors: [] }),
    resolveOpenCodeDbPath: (homeDir: string, role: string) =>
      `${homeDir}/data/${role}/.local/share/opencode/opencode.db`,
    runOpenCodeDbMaintenance: async () => ({
      dryRun: false,
      plan: { totalSessions: 0, rootCount: 0, preservedRootIds: [], deleteSessionIds: [], preservedChildIds: [] },
      deleted: [],
      deleteFailures: [],
      checkpointed: true,
      vacuumed: true,
    }),
    buildSessionClient: () => ({
      listSessions: async () => [],
      deleteSession: async () => ({ ok: true }),
    }),
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

describe('doctorReportHasFailure (C10/B8 — exit-code semantics)', () => {
  const availableAdmin = { port: 3880, service: 'admin', blocking: true, available: true } as const;
  type FailureReport = Parameters<typeof doctorReportHasFailure>[0];

  function healthyReport(overrides: Partial<FailureReport> = {}): FailureReport {
    return {
      docker: okDockerResult,
      compose: okDockerResult,
      ports: [availableAdmin],
      diskHeadroom: okDiskHeadroom,
      storage: okStorageReport,
      dockerArtifacts: { reliable: true, images: [], supersededImages: [], volumes: [], orphanVolumes: [] },
      ...overrides,
    };
  }

  test('false for a healthy report with no optional actions', () => {
    expect(doctorReportHasFailure(healthyReport())).toBe(false);
  });

  test('true when Docker fails', () => {
    expect(doctorReportHasFailure(healthyReport({ docker: { ...okDockerResult, ok: false } }))).toBe(true);
  });

  test('true when Compose fails independently of Docker', () => {
    expect(doctorReportHasFailure(healthyReport({ compose: { ...okDockerResult, ok: false } }))).toBe(true);
  });

  test('true when a blocking port is unavailable', () => {
    expect(
      doctorReportHasFailure(healthyReport({
        ports: [{ ...availableAdmin, available: false, ownership: 'free' }],
      })),
    ).toBe(true);
  });

  test('false when only a NON-blocking port is unavailable', () => {
    expect(
      doctorReportHasFailure(healthyReport({
        ports: [{ ...availableAdmin, blocking: false, available: false }],
      })),
    ).toBe(false);
  });

  test('true for critical disk headroom but false for a measurable low warning', () => {
    expect(
      doctorReportHasFailure(healthyReport({ diskHeadroom: { ...okDiskHeadroom, status: 'critical' } })),
    ).toBe(true);
    expect(doctorReportHasFailure(healthyReport({ diskHeadroom: { ...okDiskHeadroom, status: 'low' } }))).toBe(false);
  });

  test('true when either filesystem measurement fails', () => {
    expect(
      doctorReportHasFailure(
        healthyReport({ diskHeadroom: { ...okDiskHeadroom, status: 'low', measurementFailed: true } }),
      ),
    ).toBe(true);
    expect(
      doctorReportHasFailure(
        healthyReport({
          storage: {
            ...okStorageReport,
            filesystem: { ...okStorageReport.filesystem, measurementFailed: true },
          },
        }),
      ),
    ).toBe(true);
  });

  test('true when either Docker inventory is unreliable', () => {
    const unavailable = {
      reliable: false as const,
      error: 'inventory failed',
      images: [],
      supersededImages: [],
      volumes: [],
      orphanVolumes: [],
    };
    expect(doctorReportHasFailure(healthyReport({ dockerArtifacts: unavailable }))).toBe(true);
    expect(
      doctorReportHasFailure(healthyReport({ storage: { ...okStorageReport, docker: unavailable } })),
    ).toBe(true);
  });

  test('true for explicit Docker cleanup errors; successful and skipped cleanup are not failures', () => {
    expect(
      doctorReportHasFailure(
        healthyReport({ cleanDockerResult: { removedImages: [], removedVolumes: [], errors: ['remove failed'] } }),
      ),
    ).toBe(true);
    expect(
      doctorReportHasFailure(
        healthyReport({ cleanDockerResult: { removedImages: ['old'], removedVolumes: [], errors: [] } }),
      ),
    ).toBe(false);
    expect(
      doctorReportHasFailure(
        healthyReport({ cleanDockerResult: { removedImages: [], removedVolumes: [], errors: [], skipped: true } }),
      ),
    ).toBe(false);
  });

  test('successful and skipped cache cleanup are not failures', () => {
    expect(
      doctorReportHasFailure(
        healthyReport({ cleanCachesResult: { removed: ['cache'], freedBytes: 1, dryRun: false } }),
      ),
    ).toBe(false);
    expect(
      doctorReportHasFailure(
        healthyReport({ cleanCachesResult: { removed: [], freedBytes: 0, dryRun: false, skipped: true } }),
      ),
    ).toBe(false);
  });

  test('session listing errors fail; a successful listing does not', () => {
    expect(doctorReportHasFailure(healthyReport({ sessionsResult: { error: 'offline' } }))).toBe(true);
    expect(
      doctorReportHasFailure(
        healthyReport({
          sessionsResult: {
            page: 1,
            pageSize: 100,
            totalSessions: 0,
            totalPages: 0,
            rows: [],
            summary: { rootCount: 0, maxDepth: 0, staleCount: 0 },
          },
        }),
      ),
    ).toBe(false);
  });

  test('session pruning errors and partial deletion failures fail', () => {
    expect(doctorReportHasFailure(healthyReport({ pruneSessionsResult: { error: 'list failed' } }))).toBe(true);
    expect(
      doctorReportHasFailure(
        healthyReport({
          pruneSessionsResult: {
            dryRun: false,
            plan: { totalSessions: 1, rootCount: 0, preservedRootIds: [], deleteSessionIds: ['s1'], preservedChildIds: [] },
            deleted: [],
            deleteFailures: [{ id: 's1', message: 'delete failed' }],
            checkpointed: false,
            vacuumed: false,
          },
        }),
      ),
    ).toBe(true);
  });

  test('successful, dry-run, and skipped session pruning are not failures', () => {
    const success = {
      dryRun: false,
      plan: { totalSessions: 1, rootCount: 0, preservedRootIds: [], deleteSessionIds: ['s1'], preservedChildIds: [] },
      deleted: ['s1'],
      deleteFailures: [],
      checkpointed: false,
      vacuumed: false,
    };
    expect(doctorReportHasFailure(healthyReport({ pruneSessionsResult: success }))).toBe(false);
    expect(
      doctorReportHasFailure(healthyReport({ pruneSessionsResult: { ...success, dryRun: true, deleted: [] } })),
    ).toBe(false);
    expect(doctorReportHasFailure(healthyReport({ pruneSessionsResult: { skipped: true } }))).toBe(false);
  });

  test('DB reclamation errors fail; successful, no-op, and skipped results do not', () => {
    const database = {
      role: 'assistant' as const,
      path: '/tmp/opencode.db',
      present: true,
      vacuumed: false,
      freedBytes: 0,
    };
    expect(
      doctorReportHasFailure(
        healthyReport({ reclaimDbResult: { databases: [{ ...database, error: 'database is locked' }] } }),
      ),
    ).toBe(true);
    expect(doctorReportHasFailure(healthyReport({ reclaimDbResult: { databases: [database] } }))).toBe(false);
    expect(doctorReportHasFailure(healthyReport({ reclaimDbResult: { databases: [] } }))).toBe(false);
    expect(doctorReportHasFailure(healthyReport({ reclaimDbResult: { databases: [], skipped: true } }))).toBe(false);
  });
});

describe('openpalm doctor — port-probe fixes (C10/B9)', () => {
  test('port targets are resolved from persisted stack.env, not live process.env alone', async () => {
    const savedPorts = {
      OP_HOST_UI_PORT: process.env.OP_HOST_UI_PORT,
      OP_UI_PORT: process.env.OP_UI_PORT,
      OP_ASSISTANT_PORT: process.env.OP_ASSISTANT_PORT,
    };
    delete process.env.OP_HOST_UI_PORT;
    delete process.env.OP_UI_PORT;
    delete process.env.OP_ASSISTANT_PORT;
    const originalLog = console.log;
    console.log = silentConsole.log;
    let seenTargets: Array<{ port: number; service: string }> = [];
    try {
      const deps = baseDeps({
        readStackEnv: () => ({ OP_HOST_UI_PORT: '4300', OP_UI_PORT: '4301', OP_ASSISTANT_PORT: '4302' }),
        probeInstallPorts: async (targets) => {
          seenTargets = (targets ?? []).map((t) => ({ port: t.port, service: t.service }));
          return [];
        },
      });
      await runDoctorAction({ json: true }, deps);
    } finally {
      console.log = originalLog;
      for (const [key, value] of Object.entries(savedPorts)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(seenTargets).toEqual([
      { port: 4300, service: 'admin' },
      { port: 4301, service: 'ui' },
      { port: 4302, service: 'assistant' },
      // Doctor is what an operator runs when /advanced shows no workspace, so
      // it probes that port too. Absent from stack.env here, hence the default.
      { port: 3820, service: 'workspace' },
    ]);
  });

  test('a relocated workspace port is read from persisted stack.env like its peers', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    let seenTargets: Array<{ port: number; service: string }> = [];
    try {
      const deps = baseDeps({
        readStackEnv: () => ({ OP_WORKSPACE_PORT: '4820' }),
        probeInstallPorts: async (targets) => {
          seenTargets = (targets ?? []).map((t) => ({ port: t.port, service: t.service }));
          return [];
        },
      });
      await runDoctorAction({ json: true }, deps);
    } finally {
      console.log = originalLog;
    }
    expect(seenTargets.find((t) => t.service === 'workspace')?.port).toBe(4820);
  });

  test('a workspace turned off is not probed — there is no listener to conflict with', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    let seenTargets: Array<{ port: number; service: string }> = [];
    try {
      const deps = baseDeps({
        readStackEnv: () => ({ OP_WORKSPACE_PORT: '0' }),
        probeInstallPorts: async (targets) => {
          seenTargets = (targets ?? []).map((t) => ({ port: t.port, service: t.service }));
          return [];
        },
      });
      await runDoctorAction({ json: true }, deps);
    } finally {
      console.log = originalLog;
    }
    expect(seenTargets.some((t) => t.service === 'workspace')).toBe(false);
  });

  test('passes serverPort for the admin port once an OpenPalm UI instance answers there — the host UI is never a container, so no docker check could otherwise attribute it to "us"', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    let seenServerPort: number | undefined;
    try {
      const deps = baseDeps({
        readStackEnv: () => ({ OP_HOST_UI_PORT: '4400' }),
        checkExistingUiInstance: async (port) =>
          port === 4400 ? { status: 'match' as const, admin: true } : { status: 'absent' as const },
        probeInstallPorts: async (_targets, opts) => {
          seenServerPort = opts?.serverPort;
          return [];
        },
      });
      await runDoctorAction({ json: true }, deps);
    } finally {
      console.log = originalLog;
    }
    expect(seenServerPort).toBe(4400);
  });

  test('short-circuits the admin port on a "mismatch" identity too — the canonical bare `openpalm` serve runs a NON-admin UI child on that port, which is a healthy running install, not a conflict (review finding #14)', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    try {
      const deps = baseDeps({
        readStackEnv: () => ({ OP_HOST_UI_PORT: '4400' }),
        // "mismatch" with admin:false — exactly what a bare `openpalm` serve's
        // non-admin UI child answers when probed with expectedAdmin=true. The
        // admin LAUNCHER refuses to attach to this, but doctor is diagnosing
        // health: an OpenPalm UI on the expected port IS the running install.
        checkExistingUiInstance: async (port) =>
          port === 4400 ? { status: 'mismatch' as const, admin: false } : { status: 'absent' as const },
        probeInstallPorts: async (targets, opts) =>
          (targets ?? []).map((t) => {
            // Mirrors the real probeInstallPorts: only the UI child holds a
            // socket (port 4400), so it is a conflict UNLESS the serverPort
            // short-circuit reads it as ours; the other ports bind freely.
            if (t.port !== 4400) return { ...t, available: true };
            const ours = opts?.serverPort === t.port;
            return { ...t, available: ours, ownership: ours ? ('ours' as const) : ('free' as const) };
          }),
      });
      const report = await runDoctorAction({ json: true }, deps);
      const admin = report.ports.find((p) => p.service === 'admin');
      expect(admin).toMatchObject({ available: true, ownership: 'ours' });
      expect(doctorReportHasFailure(report)).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });

  test('a non-OpenPalm process on the admin port ("absent" identity, socket held) stays a genuine blocking conflict', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    try {
      const deps = baseDeps({
        readStackEnv: () => ({ OP_HOST_UI_PORT: '4400' }),
        // "absent" — nothing answered /api/runtime, so whatever holds the
        // socket is not an OpenPalm UI. No short-circuit applies.
        checkExistingUiInstance: async () => ({ status: 'absent' as const }),
        probeInstallPorts: async (targets, opts) =>
          (targets ?? []).map((t) => {
            if (t.port !== 4400) return { ...t, available: true };
            const ours = opts?.serverPort === t.port;
            return { ...t, available: ours, ownership: ours ? ('ours' as const) : ('free' as const) };
          }),
      });
      const report = await runDoctorAction({ json: true }, deps);
      const admin = report.ports.find((p) => p.service === 'admin');
      expect(admin).toMatchObject({ available: false, ownership: 'free' });
      expect(doctorReportHasFailure(report)).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test('passes the custom project and this stack directory into the per-port ownership probe', async () => {
    const originalLog = console.log;
    console.log = silentConsole.log;
    let seenProject: { name: string; workingDir: string } | undefined;
    try {
      const deps = baseDeps({
        resolveComposeProjectName: () => 'myproj',
        probeInstallPorts: async (targets, opts) => {
          seenProject = opts?.composeProject;
          return (targets ?? []).map((t) => ({
            ...t,
            available: t.service === 'admin',
            ownership: t.service === 'admin' ? undefined : ('free' as const),
          }));
        },
      });
      const report = await runDoctorAction({ json: true }, deps);
      const ui = report.ports.find((p) => p.service === 'ui');
      expect(seenProject).toEqual({ name: 'myproj', workingDir: '/tmp/fake-home/system/stack' });
      expect(ui).toMatchObject({ available: false, ownership: 'free' });
    } finally {
      console.log = originalLog;
    }
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

describe('openpalm doctor — --reclaim-db (S3 / Codex #7)', () => {
  // performReclaimDb() calls existsSync/statSync on the resolved DB paths
  // directly (not via deps), so these tests seed real temp files and point
  // resolveOpenCodeDbPath at them.
  function seedDbHome(): { home: string; assistantDb: string; guardianDb: string; cleanup: () => void } {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-doctor-reclaim-'));
    const assistantDb = join(home, 'data', 'assistant', '.local', 'share', 'opencode', 'opencode.db');
    const guardianDb = join(home, 'data', 'guardian', '.local', 'share', 'opencode', 'opencode.db');
    for (const p of [assistantDb, guardianDb]) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'x'.repeat(4096));
    }
    return { home, assistantDb, guardianDb, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  }

  function reclaimDeps(home: string, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
    return baseDeps({
      resolveServeState: () => ({ homeDir: home } as unknown as ControlPlaneState),
      resolveOpenCodeDbPath: (h: string, role: string) =>
        join(h, 'data', role, '.local', 'share', 'opencode', 'opencode.db'),
      ...overrides,
    });
  }

  test('with --yes, VACUUMs every present OpenCode DB via runOpenCodeDbMaintenance(null, ...)', async () => {
    const { home, assistantDb, cleanup } = seedDbHome();
    const originalLog = console.log;
    console.log = silentConsole.log;
    try {
      const calls: Array<{ client: unknown; path: string; opts: unknown }> = [];
      const deps = reclaimDeps(home, {
        runOpenCodeDbMaintenance: async (client: unknown, path: string, opts: unknown) => {
          calls.push({ client, path, opts });
          // Simulate the VACUUM shrinking the file so freedBytes > 0.
          writeFileSync(path, 'x'.repeat(1024));
          return {
            dryRun: false,
            plan: { totalSessions: 0, rootCount: 0, preservedRootIds: [], deleteSessionIds: [], preservedChildIds: [] },
            deleted: [], deleteFailures: [], checkpointed: true, vacuumed: true,
          };
        },
      });

      const report = await runDoctorAction({ reclaimDb: true, yes: true }, deps);

      // Both DBs processed; the null client (file-only path) is always used.
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.client === null)).toBe(true);
      expect(calls.every((c) => (c.opts as { confirm?: boolean }).confirm === true)).toBe(true);
      expect(report.reclaimDbResult?.databases).toHaveLength(2);
      const assistant = report.reclaimDbResult?.databases.find((d) => d.role === 'assistant');
      expect(assistant?.path).toBe(assistantDb);
      expect(assistant?.vacuumed).toBe(true);
      expect(assistant?.freedBytes).toBe(4096 - 1024);
    } finally {
      console.log = originalLog;
      cleanup();
    }
  });

  test('a declined confirmation prompt skips reclamation entirely', async () => {
    const { home, cleanup } = seedDbHome();
    const originalLog = console.log;
    console.log = silentConsole.log;
    try {
      let maintenanceCalled = false;
      const deps = reclaimDeps(home, {
        promptYesNo: async () => false,
        runOpenCodeDbMaintenance: async () => {
          maintenanceCalled = true;
          throw new Error('should not be called');
        },
      });

      const report = await runDoctorAction({ reclaimDb: true, yes: false }, deps);

      expect(maintenanceCalled).toBe(false);
      expect(report.reclaimDbResult?.skipped).toBe(true);
      expect(report.reclaimDbResult?.databases).toEqual([]);
    } finally {
      console.log = originalLog;
      cleanup();
    }
  });

  test('a locked DB (maintenance throws) is surfaced as an error, not a crash', async () => {
    const { home, cleanup } = seedDbHome();
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = silentConsole.log;
    console.warn = silentConsole.warn;
    try {
      const deps = reclaimDeps(home, {
        runOpenCodeDbMaintenance: async () => {
          throw new Error('database is locked');
        },
      });

      const report = await runDoctorAction({ reclaimDb: true, yes: true }, deps);

      expect(report.reclaimDbResult?.databases).toHaveLength(2);
      for (const d of report.reclaimDbResult?.databases ?? []) {
        expect(d.vacuumed).toBe(false);
        expect(d.error).toContain('database is locked');
      }
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      cleanup();
    }
  });

  test('reports nothing to reclaim when no OpenCode DB exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-doctor-reclaim-empty-'));
    const originalLog = console.log;
    console.log = silentConsole.log;
    try {
      let maintenanceCalled = false;
      const deps = reclaimDeps(home, {
        runOpenCodeDbMaintenance: async () => {
          maintenanceCalled = true;
          throw new Error('should not be called');
        },
      });

      const report = await runDoctorAction({ reclaimDb: true, yes: true }, deps);

      expect(maintenanceCalled).toBe(false);
      expect(report.reclaimDbResult?.databases).toEqual([]);
    } finally {
      console.log = originalLog;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('openpalm doctor --prune-sessions / --sessions (S3 live wiring)', () => {
  test('refuses to prune without an explicit --max-age-days window', async () => {
    let called = false;
    const deps = baseDeps({
      runOpenCodeDbMaintenance: async () => {
        called = true;
        throw new Error('must not run');
      },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const report = await runDoctorAction({ pruneSessions: true, yes: true }, deps);
      // Deleting session history by reflex is the failure mode this guards.
      expect(called).toBe(false);
      expect(report.pruneSessionsResult).toHaveProperty('error');
    } finally {
      console.error = originalError;
    }
  });

  test('passes the retention window through and never vacuums on this path', async () => {
    let seen: { path?: string; options?: Record<string, unknown> } = {};
    const deps = baseDeps({
      runOpenCodeDbMaintenance: async (_client, path, options) => {
        seen = { path, options: options as unknown as Record<string, unknown> };
        return {
          dryRun: false,
          plan: { totalSessions: 3, rootCount: 1, preservedRootIds: ['r'], deleteSessionIds: ['a'], preservedChildIds: ['b'] },
          deleted: ['a'],
          deleteFailures: [],
          checkpointed: false,
          vacuumed: false,
        };
      },
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runDoctorAction({ pruneSessions: true, maxAgeDays: '30', yes: true }, deps);
    } finally {
      console.log = originalLog;
    }
    expect(seen.options?.confirm).toBe(true);
    // VACUUM needs the assistant stopped; this path needs it running.
    expect(seen.options?.skipVacuumStage).toBe(true);
    expect((seen.options?.retention as { maxChildAgeMs: number } | undefined)?.maxChildAgeMs).toBe(30 * 86_400_000);
    expect(seen.path).toContain('assistant');
  });

  test('a declined confirmation deletes nothing', async () => {
    let called = false;
    const deps = baseDeps({
      promptYesNo: async () => false,
      runOpenCodeDbMaintenance: async () => {
        called = true;
        throw new Error('must not run');
      },
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      const report = await runDoctorAction({ pruneSessions: true, maxAgeDays: '30' }, deps);
      expect(called).toBe(false);
      expect(report.pruneSessionsResult).toEqual({ skipped: true });
    } finally {
      console.log = originalLog;
    }
  });

  test('--sessions reports parent/depth without deleting anything', async () => {
    const deps = baseDeps({
      buildSessionClient: () => ({
        listSessions: async () => [
          { id: 'root1', time: { created: 1, updated: 2 } },
          { id: 'kid1', parentID: 'root1', time: { created: 1, updated: 2 } },
        ] as never,
        deleteSession: async () => {
          throw new Error('--sessions must never delete');
        },
      }),
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      const report = await runDoctorAction({ sessions: true }, deps);
      const page = report.sessionsResult as {
        totalSessions: number;
        summary: { rootCount: number; maxDepth: number };
      };
      expect(page.totalSessions).toBe(2);
      expect(page.summary.rootCount).toBe(1);
      expect(page.summary.maxDepth).toBe(1);
    } finally {
      console.log = originalLog;
    }
  });
});
