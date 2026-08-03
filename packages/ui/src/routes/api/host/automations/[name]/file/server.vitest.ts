import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  AUTOMATION_RUNTIME_MAX_STDIN_BYTES,
  AutomationRuntimeError,
  TASK_CONTENT_MAX_BYTES,
  deleteAutomationTaskFile,
  readAutomationTaskFile,
  writeAutomationTaskFile,
} from '@openpalm/lib';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';
import { DELETE, GET, PUT } from './+server.js';

vi.mock('@openpalm/lib', async () => {
  const actual = await vi.importActual<typeof import('@openpalm/lib')>('@openpalm/lib');
  return {
    ...actual,
    deleteAutomationTaskFile: vi.fn(),
    readAutomationTaskFile: vi.fn(),
    writeAutomationTaskFile: vi.fn(),
  };
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-task-file-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeEvent(
  method: 'GET' | 'PUT' | 'DELETE',
  name: string,
  body?: Record<string, unknown>,
  token = 'admin-token',
): Parameters<typeof GET>[0] {
  return {
    request: new Request(
      `http://localhost/api/host/automations/${encodeURIComponent(name)}/file`,
      {
        method,
        headers: {
          cookie: `op_session=${token}`,
          'content-type': 'application/json',
          'x-request-id': 'req-task-file-test',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ),
    params: { name },
  } as unknown as Parameters<typeof GET>[0];
}

let originalHome: string | undefined;

beforeEach(() => {
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = makeTempDir();
  resetState('admin-token');
  vi.clearAllMocks();
  vi.mocked(readAutomationTaskFile).mockResolvedValue({
    content: 'opaque',
    revision: `sha256:${'0'.repeat(64)}`,
  });
  vi.mocked(writeAutomationTaskFile).mockResolvedValue(`sha256:${'1'.repeat(64)}`);
  vi.mocked(deleteAutomationTaskFile).mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  cleanupTempDirs();
  vi.restoreAllMocks();
});

describe('/api/host/automations/:name/file', () => {
  test('authenticates every handler before disclosing an absent host capability', async () => {
    const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.OP_ENABLE_ADMIN;
    expect((await GET(makeEvent('GET', 'daily.yml', undefined, 'bad-token'))).status).toBe(401);
    expect(
      (
        await PUT(
          makeEvent(
            'PUT',
            'daily.yml',
            { content: 'opaque', expectedRevision: null },
            'bad-token',
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await DELETE(
          makeEvent(
            'DELETE',
            'daily.yml',
            { expectedRevision: `sha256:${'0'.repeat(64)}` },
            'bad-token',
          ),
        )
      ).status,
    ).toBe(401);
    expect(readAutomationTaskFile).not.toHaveBeenCalled();
    expect(writeAutomationTaskFile).not.toHaveBeenCalled();
    expect(deleteAutomationTaskFile).not.toHaveBeenCalled();
    expect([...infoLog.mock.calls, ...errorLog.mock.calls].flat().join('\n')).not.toContain(
      'admin.automations',
    );
  });

  test('rejects traversal, non-portable names, and Windows device forms', async () => {
    for (const name of [
      '../escape.yml',
      'a/b.yml',
      'CON.yml',
      'COM¹.yml',
      'LPT³.yml',
      'legacy.yaml',
      'uppercase.YML',
    ]) {
      expect((await GET(makeEvent('GET', name))).status).toBe(400);
    }
  });

  test('requires explicit create/update and delete preconditions', async () => {
    expect((await PUT(makeEvent('PUT', 'daily.yml', { content: 'opaque' }))).status).toBe(400);
    expect((await DELETE(makeEvent('DELETE', 'daily.yml'))).status).toBe(400);
  });

  test('reads and writes opaque content through the container runtime', async () => {
    const get = await GET(makeEvent('GET', 'daily.yml'));
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      fileName: 'daily.yml',
      content: 'opaque',
      revision: `sha256:${'0'.repeat(64)}`,
    });

    const put = await PUT(
      makeEvent('PUT', 'daily.yml', {
        content: 'not: [valid YAML',
        expectedRevision: `sha256:${'0'.repeat(64)}`,
      }),
    );
    expect(put.status).toBe(200);
    expect(writeAutomationTaskFile).toHaveBeenCalledWith(
      expect.any(Object),
      'daily.yml',
      'not: [valid YAML',
      `sha256:${'0'.repeat(64)}`,
    );
  });

  test('accepts a 256 KiB task after worst-case JSON string escaping', async () => {
    const content = '\0'.repeat(TASK_CONTENT_MAX_BYTES);
    const body = { content, expectedRevision: null };
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(
      AUTOMATION_RUNTIME_MAX_STDIN_BYTES,
    );

    expect((await PUT(makeEvent('PUT', 'daily.yml', body))).status).toBe(200);
    expect(writeAutomationTaskFile).toHaveBeenCalledWith(
      expect.any(Object),
      'daily.yml',
      content,
      null,
    );
  });

  test('rejects an automation PUT body larger than the 2 MiB runtime envelope', async () => {
    const content = 'x'.repeat(AUTOMATION_RUNTIME_MAX_STDIN_BYTES);
    expect(
      (
        await PUT(
          makeEvent('PUT', 'daily.yml', { content, expectedRevision: null }),
        )
      ).status,
    ).toBe(413);
    expect(writeAutomationTaskFile).not.toHaveBeenCalled();
  });

  test('allows portable unschedulable existing files to be repaired or deleted', async () => {
    const revision = `sha256:${'0'.repeat(64)}`;
    expect((await GET(makeEvent('GET', 'foo .yml'))).status).toBe(200);
    expect(
      (
        await PUT(
          makeEvent('PUT', 'foo .yml', { content: 'repair', expectedRevision: revision }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await DELETE(makeEvent('DELETE', 'foo .yml', { expectedRevision: revision }))).status,
    ).toBe(200);
  });

  test('maps helper conflicts and not-found responses', async () => {
    vi.mocked(writeAutomationTaskFile).mockRejectedValueOnce(
      new AutomationRuntimeError('conflict', 'newer content exists'),
    );
    expect(
      (
        await PUT(
          makeEvent('PUT', 'daily.yml', {
            content: 'stale',
            expectedRevision: `sha256:${'0'.repeat(64)}`,
          }),
        )
      ).status,
    ).toBe(409);

    vi.mocked(readAutomationTaskFile).mockRejectedValueOnce(
      new AutomationRuntimeError('not_found', 'Task file not found'),
    );
    expect((await GET(makeEvent('GET', 'missing.yml'))).status).toBe(404);
  });

  test('maps an unschedulable create to 400 and oversized content to 413', async () => {
    vi.mocked(writeAutomationTaskFile)
      .mockRejectedValueOnce(new AutomationRuntimeError('invalid_task_id', 'invalid task id'))
      .mockRejectedValueOnce(new AutomationRuntimeError('too_large', 'task is too large'));
    expect(
      (
        await PUT(
          makeEvent('PUT', 'foo .yml', { content: 'opaque', expectedRevision: null }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PUT(
          makeEvent('PUT', 'daily.yml', { content: 'opaque', expectedRevision: null }),
        )
      ).status,
    ).toBe(413);
  });

  test('audits create, update, and delete without logging task content', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const content = 'private task content that must not enter the audit log';
    const oldRevision = `sha256:${'0'.repeat(64)}`;

    await PUT(makeEvent('PUT', 'daily.yml', { content, expectedRevision: null }));
    await PUT(makeEvent('PUT', 'daily.yml', { content, expectedRevision: oldRevision }));
    await DELETE(makeEvent('DELETE', 'daily.yml', { expectedRevision: oldRevision }));

    const entries = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { service?: string; extra?: Record<string, unknown> })
      .filter((entry) => entry.service === 'admin.automations');
    expect(entries.map((entry) => entry.extra)).toEqual([
      expect.objectContaining({
        requestId: 'req-task-file-test',
        fileName: 'daily.yml',
        operation: 'create',
        newRevision: `sha256:${'1'.repeat(64)}`,
        outcome: 'success',
      }),
      expect.objectContaining({
        requestId: 'req-task-file-test',
        fileName: 'daily.yml',
        operation: 'update',
        newRevision: `sha256:${'1'.repeat(64)}`,
        outcome: 'success',
      }),
      expect.objectContaining({
        requestId: 'req-task-file-test',
        fileName: 'daily.yml',
        operation: 'delete',
        outcome: 'success',
      }),
    ]);
    expect(log.mock.calls.flat().map(String).join('\n')).not.toContain(content);
  });

  test('audits a failed update without logging content or runtime details', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const content = 'private failed update content';
    const revision = `sha256:${'0'.repeat(64)}`;
    vi.mocked(writeAutomationTaskFile).mockRejectedValueOnce(
      new AutomationRuntimeError('conflict', 'private runtime detail'),
    );

    await PUT(makeEvent('PUT', 'daily.yml', { content, expectedRevision: revision }));
    const output = errorLog.mock.calls.flat().map(String).join('\n');

    expect(output).toContain('"operation":"update"');
    expect(output).toContain('"outcome":"failure"');
    expect(output).toContain('"errorCode":"conflict"');
    expect(output).toContain('"errorMessage":"Automation task revision conflict"');
    expect(output).not.toContain(content);
    expect(output).not.toContain(revision);
    expect(output).not.toContain('private runtime detail');
  });
});
