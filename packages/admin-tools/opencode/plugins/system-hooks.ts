/**
 * System-level session hooks for admin-tools.
 * Context injection for scheduler-triggered sessions and lightweight
 * tracking of admin tool outcomes within the session.
 *
 * Procedural memory and learning are now handled by the akm stash
 * via the `akm-opencode` plugin (loaded separately), so this plugin
 * no longer touches a memory service.
 */
import type { Plugin } from '@opencode-ai/plugin';
import { buildAdminHeaders } from '../tools/lib.ts';

type HookIO = Record<string, unknown>;

const ADMIN_URL = process.env.OP_ADMIN_API_URL || 'http://admin:8100';

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

    'session.deleted': async (input) => {
      adminSessions.delete(getSessionId(asRecord(input)));
    },
  };
};

async function adminFetch(path: string): Promise<unknown | null> {
  const headers = buildAdminHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(`${ADMIN_URL}${path}`, { headers, signal: AbortSignal.timeout(5_000) });
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
    '- Record durable findings via the akm stash (akm_remember / akm_distill).');

  return lines.join('\n');
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
