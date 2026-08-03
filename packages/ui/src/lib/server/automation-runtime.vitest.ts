import { afterEach, describe, expect, test, vi } from 'vitest';
import { AutomationRuntimeError, type AutomationRuntimeErrorCode } from '@openpalm/lib';
import { automationRuntimeErrorResponse } from './automation-runtime.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('automationRuntimeErrorResponse', () => {
  test.each([
    ['conflict', 409, 'safe runtime message'],
    ['not_found', 404, 'safe runtime message'],
    ['too_large', 413, 'safe runtime message'],
    ['invalid_name', 400, 'safe runtime message'],
    ['invalid_request', 400, 'safe runtime message'],
    ['invalid_task_id', 400, 'safe runtime message'],
    ['unavailable', 503, 'Automation runtime is unavailable'],
    ['busy', 503, 'Automation runtime is busy'],
    ['io_error', 503, 'Automation runtime I/O failed'],
    ['invalid_response', 502, 'Automation runtime returned an invalid response'],
  ] satisfies Array<[AutomationRuntimeErrorCode, number, string]>)('maps %s to %i', async (code, status, message) => {
    const response = automationRuntimeErrorResponse(
      new AutomationRuntimeError(code, 'safe runtime message'),
      'req-error-map',
    );

    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({
      error: code,
      message,
      requestId: 'req-error-map',
    });
  });

  test('maps unsafe on-disk state to a generic 500', async () => {
    const response = automationRuntimeErrorResponse(
      new AutomationRuntimeError('unsafe_file', 'raw filesystem detail'),
      'req-unsafe',
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'internal_error',
      message: 'Automation operation failed',
      requestId: 'req-unsafe',
    });
  });

  test('returns and audits a generic 500 without exposing unknown exception details', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = automationRuntimeErrorResponse(
      new Error('raw exception detail must stay private'),
      'req-unknown',
      {
        fileName: 'daily.yml',
        operation: 'update',
      },
    );
    const body = await response.json();
    const logOutput = errorLog.mock.calls.flat().map(String).join('\n');

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: 'internal_error',
      message: 'Automation operation failed',
      requestId: 'req-unknown',
    });
    expect(JSON.stringify(body)).not.toContain('raw exception detail');
    expect(logOutput).toContain('"requestId":"req-unknown"');
    expect(logOutput).toContain('"fileName":"daily.yml"');
    expect(logOutput).toContain('"operation":"update"');
    expect(logOutput).not.toContain('expectedRevision');
    expect(logOutput).toContain('"outcome":"failure"');
    expect(logOutput).toContain('"errorCode":"internal_error"');
    expect(logOutput).toContain('"errorMessage":"Automation operation failed"');
    expect(logOutput).not.toContain('raw exception detail');
  });

  test('does not copy a runtime error message into the audit log', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    automationRuntimeErrorResponse(
      new AutomationRuntimeError('conflict', 'private runtime detail'),
      'req-known',
      { fileName: 'daily.yml', operation: 'update' },
    );
    const logOutput = errorLog.mock.calls.flat().map(String).join('\n');

    expect(logOutput).toContain('"errorCode":"conflict"');
    expect(logOutput).not.toContain('private runtime detail');
  });
});
