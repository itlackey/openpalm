import { describe, expect, it } from 'bun:test';
import {
  classifyOpenPalmVolume,
  cleanupImagesAndVolumes,
  findOrphanVolumes,
  findSupersededImages,
  parseDockerImagesOutput,
  parseDockerVolumeLsOutput,
  reapRetiredVolumes,
  reportImagesAndVolumes,
  RETIRED_VOLUME_NAMES,
  type DockerImageInfo,
  type DockerVolumeInfo,
  type ImageVolumeReport,
} from './image-volume-retention.js';
import type { DockerClient, DockerResult } from './docker.js';

function fakeClient(handlers: Record<string, DockerResult>): DockerClient {
  return {
    run: async (args: string[]) => {
      const key = args[0] ?? '';
      const result = handlers[key];
      if (!result) throw new Error(`unexpected docker invocation: ${args.join(' ')}`);
      return result;
    },
  };
}

const okResult = (stdout: string): DockerResult => ({ ok: true, stdout, stderr: '', code: 0 });
const failResult = (stderr: string): DockerResult => ({ ok: false, stdout: '', stderr, code: 1 });

describe('parseDockerImagesOutput / parseDockerVolumeLsOutput', () => {
  it('parses tab-separated docker images output', () => {
    const parsed = parseDockerImagesOutput(
      'openpalm/assistant\t0.12.0\tabc123\t2024-01-01 00:00:00 +0000 UTC\t1.2GB\n' +
        'openpalm/assistant\t0.13.0\tdef456\t2024-06-01 00:00:00 +0000 UTC\t1.3GB\n',
    );
    expect(parsed).toEqual([
      { repository: 'openpalm/assistant', tag: '0.12.0', id: 'abc123', createdAt: '2024-01-01 00:00:00 +0000 UTC', size: '1.2GB' },
      { repository: 'openpalm/assistant', tag: '0.13.0', id: 'def456', createdAt: '2024-06-01 00:00:00 +0000 UTC', size: '1.3GB' },
    ]);
  });

  it('skips blank lines', () => {
    expect(parseDockerImagesOutput('\n\n')).toEqual([]);
  });

  it('parses tab-separated docker volume ls output', () => {
    const parsed = parseDockerVolumeLsOutput('openpalm_assistant-artifacts\tlocal\nopenpalm_assistant-persistent\tlocal\n');
    expect(parsed).toEqual([
      { name: 'openpalm_assistant-artifacts', driver: 'local' },
      { name: 'openpalm_assistant-persistent', driver: 'local' },
    ]);
  });
});

describe('findSupersededImages', () => {
  it('flags every image but the newest-created one within a repository', () => {
    const images: DockerImageInfo[] = [
      { repository: 'openpalm/assistant', tag: '0.11.0', id: 'a', createdAt: '2024-01-01 00:00:00 +0000 UTC', size: '1GB' },
      { repository: 'openpalm/assistant', tag: '0.12.0', id: 'b', createdAt: '2024-06-01 00:00:00 +0000 UTC', size: '1GB' },
      { repository: 'openpalm/assistant', tag: '0.13.0', id: 'c', createdAt: '2024-09-01 00:00:00 +0000 UTC', size: '1GB' },
    ];
    const superseded = findSupersededImages(images);
    expect(superseded.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('flags nothing when a repository has only one tagged image', () => {
    const images: DockerImageInfo[] = [
      { repository: 'openpalm/assistant', tag: 'latest', id: 'a', createdAt: '2024-01-01 00:00:00 +0000 UTC', size: '1GB' },
    ];
    expect(findSupersededImages(images)).toEqual([]);
  });

  it('never attributes a dangling (<none>) image to OpenPalm', () => {
    const images: DockerImageInfo[] = [
      { repository: '<none>', tag: '<none>', id: 'x', createdAt: '2024-01-01 00:00:00 +0000 UTC', size: '1GB' },
      { repository: '<none>', tag: '<none>', id: 'y', createdAt: '2024-02-01 00:00:00 +0000 UTC', size: '1GB' },
    ];
    expect(findSupersededImages(images)).toEqual([]);
  });

  it('keeps repositories independent — a superseded tag in one repo does not affect another', () => {
    const images: DockerImageInfo[] = [
      { repository: 'openpalm/assistant', tag: '0.12.0', id: 'a', createdAt: '2024-01-01 00:00:00 +0000 UTC', size: '1GB' },
      { repository: 'openpalm/assistant', tag: '0.13.0', id: 'b', createdAt: '2024-06-01 00:00:00 +0000 UTC', size: '1GB' },
      { repository: 'openpalm/guardian', tag: 'latest', id: 'c', createdAt: '2024-06-01 00:00:00 +0000 UTC', size: '1GB' },
    ];
    const superseded = findSupersededImages(images);
    expect(superseded.map((i) => i.id)).toEqual(['a']);
  });
});

describe('classifyOpenPalmVolume / findOrphanVolumes', () => {
  it('matches a bare (unscoped) known volume name with no project prefix', () => {
    expect(classifyOpenPalmVolume('assistant-artifacts')).toEqual({ matches: true, suffix: 'assistant-artifacts' });
  });

  it('matches a project-scoped known volume name and extracts the project prefix', () => {
    expect(classifyOpenPalmVolume('openpalm_assistant-artifacts')).toEqual({
      matches: true,
      suffix: 'assistant-artifacts',
      projectPrefix: 'openpalm',
    });
  });

  it('does not match an unrelated volume name', () => {
    expect(classifyOpenPalmVolume('some-other-volume').matches).toBe(false);
    // A name that merely ENDS with the suffix text but has no separating "_" boundary must not match.
    expect(classifyOpenPalmVolume('xassistant-artifacts').matches).toBe(false);
  });

  it('flags a project-scoped volume as orphan only when its project prefix differs from the current project', () => {
    const volumes: DockerVolumeInfo[] = [
      { name: 'openpalm_assistant-artifacts', driver: 'local' },
      { name: 'oldname_assistant-artifacts', driver: 'local' },
      { name: 'unrelated-volume', driver: 'local' },
      { name: 'assistant-artifacts', driver: 'local' }, // bare match, no project prefix — never orphan
    ];
    const orphans = findOrphanVolumes(volumes, 'openpalm');
    expect(orphans.map((v) => v.name)).toEqual(['oldname_assistant-artifacts']);
  });

  // Reviewer concern (round 2): reapRetiredVolumes only ever targets the
  // CURRENT project name, so a retired volume stranded under an OLD project
  // prefix (from a project rename, before the volume was retired) can only
  // be reclaimed via findOrphanVolumes/doctor's orphan detector — which
  // requires guardian-cache/portal-cache to also be in OPENPALM_VOLUME_SUFFIXES.
  it('flags a renamed-project-scoped retired volume (guardian-cache, portal-cache) as orphan too', () => {
    const volumes: DockerVolumeInfo[] = [
      { name: 'oldname_guardian-cache', driver: 'local' },
      { name: 'oldname_portal-cache', driver: 'local' },
      { name: 'openpalm_guardian-cache', driver: 'local' }, // current project — never orphan
    ];
    const orphans = findOrphanVolumes(volumes, 'openpalm');
    expect(orphans.map((v) => v.name).sort()).toEqual(['oldname_guardian-cache', 'oldname_portal-cache']);
  });
});

describe('reportImagesAndVolumes', () => {
  it('composes a reliable report from parsed docker output', async () => {
    const client = fakeClient({
      images: okResult(
        'openpalm/assistant\t0.12.0\ta\t2024-01-01 00:00:00 +0000 UTC\t1GB\n' +
          'openpalm/assistant\t0.13.0\tb\t2024-06-01 00:00:00 +0000 UTC\t1GB\n',
      ),
      volume: okResult('openpalm_assistant-artifacts\tlocal\noldname_assistant-artifacts\tlocal\n'),
    });

    const report = await reportImagesAndVolumes({ client, projectName: 'openpalm' });
    expect(report.reliable).toBe(true);
    expect(report.images).toHaveLength(2);
    expect(report.supersededImages.map((i) => i.id)).toEqual(['a']);
    expect(report.orphanVolumes.map((v) => v.name)).toEqual(['oldname_assistant-artifacts']);
  });

  it('is unreliable (not silently empty-and-confirmed) when the docker images query fails', async () => {
    const client = fakeClient({
      images: failResult('docker: command not found'),
      volume: okResult(''),
    });
    const report = await reportImagesAndVolumes({ client, projectName: 'openpalm' });
    expect(report.reliable).toBe(false);
    expect(report.error).toContain('command not found');
    expect(report.images).toEqual([]);
  });

  it('is unreliable when the docker volume ls query fails', async () => {
    const client = fakeClient({
      images: okResult(''),
      volume: failResult('permission denied'),
    });
    const report = await reportImagesAndVolumes({ client, projectName: 'openpalm' });
    expect(report.reliable).toBe(false);
    expect(report.error).toContain('permission denied');
  });
});

describe('cleanupImagesAndVolumes (S7 — confirm-gated)', () => {
  const report: ImageVolumeReport = {
    reliable: true,
    images: [],
    supersededImages: [
      { repository: 'openpalm/assistant', tag: '0.12.0', id: 'abc', createdAt: '2024-01-01 00:00:00 +0000 UTC', size: '1GB' },
    ],
    volumes: [],
    orphanVolumes: [{ name: 'oldname_assistant-artifacts', driver: 'local' }],
  };

  it('refuses to run without confirm: true', async () => {
    await expect(cleanupImagesAndVolumes(report, { confirm: false })).rejects.toThrow(/confirm/i);
  });

  it('removes only the images/volumes already present in the report, nothing else', async () => {
    const rmiCalls: string[] = [];
    const volumeRmCalls: string[] = [];
    const client: DockerClient = {
      run: async (args: string[]) => {
        if (args[0] === 'rmi') {
          rmiCalls.push(args[1] ?? '');
          return okResult('');
        }
        if (args[0] === 'volume' && args[1] === 'rm') {
          volumeRmCalls.push(args[2] ?? '');
          return okResult('');
        }
        throw new Error(`unexpected: ${args.join(' ')}`);
      },
    };

    const result = await cleanupImagesAndVolumes(report, { confirm: true, client });
    expect(rmiCalls).toEqual(['abc']);
    expect(volumeRmCalls).toEqual(['oldname_assistant-artifacts']);
    expect(result.removedImages).toEqual(['abc']);
    expect(result.removedVolumes).toEqual(['oldname_assistant-artifacts']);
    expect(result.errors).toEqual([]);
  });

  it('collects per-item errors instead of throwing when a removal fails', async () => {
    const client: DockerClient = {
      run: async (args: string[]) => (args[0] === 'rmi' ? failResult('image is in use') : okResult('')),
    };
    const result = await cleanupImagesAndVolumes(report, { confirm: true, client });
    expect(result.removedImages).toEqual([]);
    expect(result.errors[0]).toContain('image is in use');
    // Volume removal still proceeds independently of the image failure.
    expect(result.removedVolumes).toEqual(['oldname_assistant-artifacts']);
  });
});

describe('reapRetiredVolumes (#585 decision 585-B — auto-reap on upgrade)', () => {
  it('has a closed list of exactly the three retired /opt/openpalm volumes, and never assistant-persistent', () => {
    expect(RETIRED_VOLUME_NAMES).toEqual(['assistant-artifacts', 'guardian-cache', 'portal-cache']);
    expect(RETIRED_VOLUME_NAMES).not.toContain('assistant-persistent');
  });

  it('attempts removal of only the closed list, scoped to the given project, nothing else', async () => {
    const rmCalls: string[] = [];
    const client: DockerClient = {
      run: async (args: string[]) => {
        if (args[0] === 'volume' && args[1] === 'rm') {
          rmCalls.push(args[2] ?? '');
          return okResult('');
        }
        throw new Error(`unexpected: ${args.join(' ')}`);
      },
    };

    const result = await reapRetiredVolumes('openpalm', { client });

    expect(rmCalls.sort()).toEqual([
      'openpalm_assistant-artifacts',
      'openpalm_guardian-cache',
      'openpalm_portal-cache',
    ]);
    expect(result.reclaimed.sort()).toEqual(rmCalls.sort());
    expect(result.errors).toEqual([]);
  });

  it('treats "no such volume" as a silent skip — not reclaimed, not an error', async () => {
    const client: DockerClient = {
      run: async () => failResult('Error: no such volume'),
    };
    const result = await reapRetiredVolumes('openpalm', { client });
    expect(result.reclaimed).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('collects a real removal failure as an error but keeps trying the rest (never throws)', async () => {
    const client: DockerClient = {
      run: async (args: string[]) => {
        const name = args[2] ?? '';
        if (name === 'openpalm_guardian-cache') return failResult('volume is in use');
        return okResult('');
      },
    };
    const result = await reapRetiredVolumes('openpalm', { client });
    expect(result.reclaimed.sort()).toEqual(['openpalm_assistant-artifacts', 'openpalm_portal-cache']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('guardian-cache');
    expect(result.errors[0]).toContain('volume is in use');
  });

  it('NEGATIVE PIN: no project name can make the reaper target assistant-persistent or anything outside the closed list', async () => {
    const trickyProjectNames = [
      'openpalm',
      '',
      'assistant-persistent',
      'assistant',
      'openpalm_assistant',
      '_',
    ];
    for (const projectName of trickyProjectNames) {
      const rmCalls: string[] = [];
      const client: DockerClient = {
        run: async (args: string[]) => {
          if (args[0] === 'volume' && args[1] === 'rm') {
            rmCalls.push(args[2] ?? '');
            return okResult('');
          }
          throw new Error(`unexpected: ${args.join(' ')}`);
        },
      };
      await reapRetiredVolumes(projectName, { client });
      for (const name of rmCalls) {
        // The only two shapes that would ever address the REAL protected
        // volume: the bare name, or `<project>_assistant-persistent`. Neither
        // can occur — RETIRED_VOLUME_NAMES never contains "assistant-persistent".
        expect(name).not.toBe('assistant-persistent');
        expect(name.endsWith('_assistant-persistent')).toBe(false);
      }
      // Exactly the three closed-list volumes, scoped by this project name, every time.
      expect(rmCalls.sort()).toEqual(
        RETIRED_VOLUME_NAMES.map((n) => `${projectName}_${n}`).sort(),
      );
    }
  });
});
