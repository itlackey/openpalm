import { describe, expect, it } from 'bun:test';
import { decidePermission, loadPermissionPolicy } from './openai-api-permissions.ts';

describe('loadPermissionPolicy — defaults fail-closed', () => {
  it('no env → reject mode', () => {
    const policy = loadPermissionPolicy({});
    expect(policy.mode).toBe('reject');
    expect(policy.allowlist.size).toBe(0);
  });

  it('unknown mode value → reject (not auto)', () => {
    expect(loadPermissionPolicy({ OP_API_PERMISSION_MODE: 'yes please' }).mode).toBe('reject');
  });

  it('auto mode parses an allowlist', () => {
    const policy = loadPermissionPolicy({ OP_API_PERMISSION_MODE: 'auto', OP_API_PERMISSION_ALLOWLIST: 'bash, edit' });
    expect(policy.mode).toBe('auto');
    expect(policy.allowlist.has('bash')).toBe(true);
    expect(policy.allowlist.has('edit')).toBe(true);
  });

  it('mode is case/space tolerant', () => {
    expect(loadPermissionPolicy({ OP_API_PERMISSION_MODE: '  AuTo  ' }).mode).toBe('auto');
  });
});

describe('decidePermission — default reject', () => {
  const ask = { requestID: 'per_1', permission: 'bash', patterns: ['echo hi'] };

  it('reject mode denies every request', () => {
    expect(decidePermission({ mode: 'reject', allowlist: new Set(['bash']) }, ask)).toBe('reject');
  });

  it('auto mode with EMPTY allowlist still rejects', () => {
    expect(decidePermission({ mode: 'auto', allowlist: new Set() }, ask)).toBe('reject');
  });

  it('auto mode approves ONLY allowlisted tools', () => {
    const policy = { mode: 'auto', allowlist: new Set(['bash']) } as const;
    expect(decidePermission(policy, ask)).toBe('once');
    expect(decidePermission(policy, { ...ask, permission: 'edit' })).toBe('reject');
  });
});
