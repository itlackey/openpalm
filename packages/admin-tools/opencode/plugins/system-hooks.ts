/**
 * System-level session hooks for admin-tools.
 * Context injection and idle processing for scheduler-triggered sessions
 * and admin tool guidance retrieval from stack-scoped memory.
 */
import type { Plugin } from '@opencode-ai/plugin';

type HookIO = Record<string, unknown>;

const ADMIN_URL = process.env.OP_ADMIN_API_URL || 'http://admin:8100';
const ADMIN_TOKEN = process.env.OP_ASSISTANT_TOKEN || process.env.OP_ADMIN_TOKEN || '';
const MEMORY_URL = process.env.MEMORY_API_URL || 'http://memory:8765';
const STACK_USER_ID = 'openpalm';

const ADMIN_HEADERS = { 'x-admin-token': ADMIN_TOKEN, 'x-requested-by': 'assistant', 'content-type': 'application/json' };

type AdminSessionState = {
  sessionId: string;
  isSchedulerTriggered: boolean;
  adminToolOutcomes: Array<{ toolName: string; ok: boolean }>;
};

const adminSessions = new Map<string, AdminSessionState>();

export const SystemHooksPlugin: Plugin = async () => {
  return {
    'session.created': async (input, output) => {
      const inp = asRecord(input);
      const out = asRecord(output);
      const sessionId = getSessionId(inp);
      const agentName = (inp?.agent as HookIO)?.name as string ?? '';
      const isSchedulerTriggered = agentName === 'scheduler' || sessionId.startsWith('sched-');

      adminSessions.set(sessionId, { sessionId, isSchedulerTriggered, adminToolOutcomes: [] });

      if (isSchedulerTriggered) {
        const ctx = await buildSystemContext();
        if (ctx) ensureContext(out).push(ctx);
      }
    },

    'tool.execute.before': async (input, output) => {
      const inp = asRecord(input);
      const toolName = (inp?.tool as HookIO)?.name as string | undefined;
      if (!toolName || !isAdminTool(toolName)) return;
      if (!adminSessions.has(getSessionId(inp))) return;

      const guidance = await retrieveAdminToolGuidance(toolName);
      if (guidance) ensureContext(asRecord(output)).push(guidance);
    },

    'tool.execute.after': async (input, output) => {
      const inp = asRecord(input);
      const out = asRecord(output);
      const toolName = (inp?.tool as HookIO)?.name as string | undefined;
      if (!toolName || !isAdminTool(toolName)) return;

      const state = adminSessions.get(getSessionId(inp));
      if (!state) return;

      const failed = !!(inp?.error || out?.error) || isBadResult(out?.result ?? inp?.result);
      state.adminToolOutcomes.push({ toolName, ok: !failed });
    },

    'session.idle': async (input) => {
      const state = adminSessions.get(getSessionId(asRecord(input)));
      if (!state?.isSchedulerTriggered || state.adminToolOutcomes.length === 0) return;
      await consolidateAdminOutcomes(state);
    },

    'session.deleted': async (input) => {
      adminSessions.delete(getSessionId(asRecord(input)));
    },
  };
};

async function adminFetch(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${ADMIN_URL}${path}`, { headers: ADMIN_HEADERS, signal: AbortSignal.timeout(5_000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function buildSystemContext(): Promise<string | null> {
  const lines: string[] = ['## System Session Context'];

  const automations = await adminFetch('/admin/automations');
  if (automations) {
    lines.push('', '### Active Automations', `Automations data available: ${JSON.stringify(automations).slice(0, 200)}...`);
  } else {
    lines.push('', '### Automations: unavailable (admin API unreachable)');
  }

  const containers = await adminFetch('/admin/containers/list') as unknown[] | null;
  if (Array.isArray(containers)) {
    const running = containers.filter((c) => (c as HookIO).state === 'running').length;
    lines.push('', '### Stack Health', `Containers: ${running}/${containers.length} running`);
  } else {
    lines.push('', '### Stack Health: unavailable');
  }

  lines.push('', '### Session Type',
    '- This is a scheduler-triggered session.',
    '- Focus on the scheduled task. Use admin tools as needed.',
    '- Store any findings as procedural memory for future reference.');

  return lines.join('\n');
}

async function retrieveAdminToolGuidance(toolName: string): Promise<string | null> {
  try {
    const query = `openpalm procedure for ${toolName.replace(/_/g, ' ')} operations`;
    const res = await fetch(`${MEMORY_URL}/api/v2/memories/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: STACK_USER_ID, query, search_query: query, filters: { category: 'procedural' }, page: 1, size: 5 }),
      signal: AbortSignal.timeout(1_200),
    });
    if (!res.ok) return null;
    const data = await res.json() as HookIO;
    const items = (data.items ?? data.results) as Array<HookIO> | undefined;
    if (!items?.length) return null;

    const lines = [`### Learned Procedures For ${toolName}`];
    for (const item of items) {
      const content = item.content ?? item.memory;
      if (typeof content !== 'string') continue;
      const meta = item.metadata as HookIO | undefined;
      const tag = typeof meta?.category === 'string' ? `[${meta.category}]` : '';
      lines.push(`- ${tag} ${content}`.trim());
    }
    return lines.join('\n');
  } catch { return null; }
}

async function consolidateAdminOutcomes(state: AdminSessionState): Promise<void> {
  const grouped = new Map<string, { ok: number; total: number }>();
  for (const o of state.adminToolOutcomes) {
    const c = grouped.get(o.toolName) ?? { ok: 0, total: 0 };
    if (o.ok) c.ok++;
    c.total++;
    grouped.set(o.toolName, c);
  }

  for (const [toolName, c] of grouped.entries()) {
    if (c.ok >= 2 && c.ok / c.total >= 0.8) {
      try {
        await fetch(`${MEMORY_URL}/api/v1/memories/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            user_id: STACK_USER_ID, agent_id: 'openpalm', app_id: 'openpalm',
            text: `${toolName} is reliable in scheduler context; ${c.ok}/${c.total} recent executions succeeded.`,
            app: 'openpalm-admin-tools',
            metadata: { category: 'procedural', source: 'consolidation', confidence: 0.65, scope: 'stack' },
            infer: true,
          }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch { /* best-effort */ }
    }
  }
}

function isAdminTool(name: string): boolean {
  return name.startsWith('admin-') || name === 'stack-diagnostics' || name === 'message-trace';
}

function isBadResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as HookIO;
  return Boolean(r.error) || r.ok === false || r.success === false;
}

function getSessionId(input: HookIO): string {
  return ((input?.session as HookIO)?.id ?? (input?.properties as HookIO)?.sessionId ?? 'unknown') as string;
}

function ensureContext(output: HookIO): string[] {
  if (!output.context) output.context = [];
  return output.context as string[];
}

function asRecord(value: unknown): HookIO {
  return (value && typeof value === 'object') ? value as HookIO : {};
}
