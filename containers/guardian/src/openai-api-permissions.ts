import { createLogger } from './logger.ts';
import type { PermissionAsk } from './openai-api-oc-events.ts';
import { parseIdList } from './openai-api-permissions-shared.ts';

const log = createLogger('guardian:openai-api');

export type PermissionReply = 'once' | 'reject';

export type PermissionPolicy = {
  mode: 'reject' | 'auto';
  allowlist: Set<string>;
};

export function loadPermissionPolicy(env: Record<string, string | undefined> = Bun.env): PermissionPolicy {
  const rawMode = env.OP_API_PERMISSION_MODE?.trim().toLowerCase();
  const mode: PermissionPolicy['mode'] = rawMode === 'auto' ? 'auto' : 'reject';
  const allowlist = parseIdList(env.OP_API_PERMISSION_ALLOWLIST);

  log.info('permission_policy_loaded', {
    mode,
    allowlist: mode === 'auto' ? (allowlist.size ? [...allowlist].join(',') : 'empty(=reject-all)') : 'n/a',
  });

  return { mode, allowlist };
}

export function decidePermission(policy: PermissionPolicy, ask: PermissionAsk): PermissionReply {
  if (policy.mode === 'auto' && policy.allowlist.has(ask.permission)) return 'once';
  return 'reject';
}
