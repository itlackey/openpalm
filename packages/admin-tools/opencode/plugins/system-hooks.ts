/**
 * System-level session hooks for admin-tools.
 *
 * Provides context injection and idle processing for scheduler-triggered
 * sessions and admin tool guidance retrieval from stack-scoped memory.
 */
import type { Plugin } from '@opencode-ai/plugin';

type HookInput = {
  session?: { id?: string };
  properties?: { sessionId?: string };
  project?: { name?: string };
  agent?: { name?: string };
  tool?: { name?: string };
  args?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  execution?: { id?: string };
  toolCall?: { id?: string };
  call?: { id?: string };
};

type HookOutput = {
  context?: string[];
  env?: Record<string, string>;
  result?: unknown;
  error?: unknown;
};

const ADMIN_URL = process.env.OPENPALM_ADMIN_API_URL || 'http://admin:8100';
const ADMIN_TOKEN = process.env.OPENPALM_ADMIN_TOKEN || '';
const MEMORY_URL = process.env.MEMORY_API_URL || 'http://memory:8765';
const MEMORY_USER_ID = process.env.MEMORY_USER_ID || 'default_user';
const STACK_USER_ID = 'openpalm';

type AdminSessionState = {
  sessionId: string;
  isSchedulerTriggered: boolean;
  adminToolOutcomes: Array<{ toolName: string; ok: boolean; durationMs: number }>;
};

const adminSessions = new Map<string, AdminSessionState>();

export const SystemHooksPlugin: Plugin = async () => {
  return {
    'session.created': async (input, output) => {
      const hookInput = asHookInput(input);
      const hookOutput = asHookOutput(output);
      const sessionId = getSessionId(hookInput);

      // Detect if this is a scheduler-triggered session
      const isSchedulerTriggered = detectSchedulerSession(hookInput);

      adminSessions.set(sessionId, {
        sessionId,
        isSchedulerTriggered,
        adminToolOutcomes: [],
      });

      if (isSchedulerTriggered) {
        const systemContext = await buildSystemContext();
        if (systemContext) {
          ensureContext(hookOutput).push(systemContext);
        }
      }
    },

    'tool.execute.before': async (input, output) => {
      const hookInput = asHookInput(input);
      const hookOutput = asHookOutput(output);
      const toolName = hookInput.tool?.name;
      if (!toolName) return;

      // Only handle admin tools (tools from this package)
      if (!isAdminTool(toolName)) return;

      const sessionId = getSessionId(hookInput);
      const state = adminSessions.get(sessionId);
      if (!state) return;

      // Retrieve stack-scoped procedural memory for admin tools
      const guidance = await retrieveAdminToolGuidance(toolName);
      if (guidance) {
        ensureContext(hookOutput).push(guidance);
      }
    },

    'tool.execute.after': async (input, output) => {
      const hookInput = asHookInput(input);
      const hookOutput = asHookOutput(output);
      const toolName = hookInput.tool?.name;
      if (!toolName) return;

      if (!isAdminTool(toolName)) return;

      const sessionId = getSessionId(hookInput);
      const state = adminSessions.get(sessionId);
      if (!state) return;

      const failed = didToolFail(hookInput, hookOutput);
      state.adminToolOutcomes.push({
        toolName,
        ok: !failed,
        durationMs: 0,
      });
    },

    'session.idle': async (input) => {
      const hookInput = asHookInput(input);
      const sessionId = getSessionId(hookInput);
      const state = adminSessions.get(sessionId);
      if (!state) return;

      // For scheduler-triggered sessions, trigger memory consolidation
      // of admin tool outcomes into stack-scoped procedural memory
      if (state.isSchedulerTriggered && state.adminToolOutcomes.length > 0) {
        await consolidateAdminOutcomes(state);
      }
    },

    'session.deleted': async (input) => {
      const hookInput = asHookInput(input);
      const sessionId = getSessionId(hookInput);
      adminSessions.delete(sessionId);
    },
  };
};

function detectSchedulerSession(input: HookInput): boolean {
  const agentName = input.agent?.name ?? '';
  const sessionId = input.session?.id ?? input.properties?.sessionId ?? '';
  // Scheduler sessions are typically identified by agent name or session prefix
  return agentName === 'scheduler' || sessionId.startsWith('sched-');
}

async function buildSystemContext(): Promise<string | null> {
  const lines: string[] = ['## System Session Context'];

  // Fetch automations status
  try {
    const res = await fetch(`${ADMIN_URL}/admin/automations`, {
      headers: {
        'x-admin-token': ADMIN_TOKEN,
        'x-requested-by': 'assistant',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      lines.push('', '### Active Automations');
      lines.push(`Automations data available: ${JSON.stringify(data).slice(0, 200)}...`);
    }
  } catch {
    lines.push('', '### Automations: unavailable (admin API unreachable)');
  }

  // Fetch stack health summary
  try {
    const res = await fetch(`${ADMIN_URL}/admin/containers/list`, {
      headers: {
        'x-admin-token': ADMIN_TOKEN,
        'x-requested-by': 'assistant',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const containers = await res.json() as unknown[];
      const running = Array.isArray(containers)
        ? containers.filter((c) => (c as Record<string, unknown>).state === 'running').length
        : 0;
      const total = Array.isArray(containers) ? containers.length : 0;
      lines.push('', '### Stack Health');
      lines.push(`Containers: ${running}/${total} running`);
    }
  } catch {
    lines.push('', '### Stack Health: unavailable');
  }

  lines.push(
    '',
    '### Session Type',
    '- This is a scheduler-triggered session.',
    '- Focus on the scheduled task. Use admin tools as needed.',
    '- Store any findings as procedural memory for future reference.',
  );

  return lines.length > 1 ? lines.join('\n') : null;
}

async function retrieveAdminToolGuidance(toolName: string): Promise<string | null> {
  try {
    const query = `openpalm procedure for ${toolName.replace(/_/g, ' ')} operations`;
    const res = await fetch(`${MEMORY_URL}/api/v2/memories/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: STACK_USER_ID,
        query,
        search_query: query,
        filters: { category: 'procedural' },
        page: 1,
        size: 5,
      }),
      signal: AbortSignal.timeout(1_200),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const items = (data.items ?? data.results) as Array<Record<string, unknown>> | undefined;
    if (!items || items.length === 0) return null;

    const lines = [`### Learned Procedures For ${toolName}`];
    for (const item of items) {
      const content = item.content ?? item.memory;
      if (typeof content === 'string') {
        const category = typeof item.metadata === 'object' && item.metadata
          ? (item.metadata as Record<string, unknown>).category
          : '';
        const tag = typeof category === 'string' ? `[${category}]` : '';
        lines.push(`- ${tag} ${content}`.trim());
      }
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

async function consolidateAdminOutcomes(state: AdminSessionState): Promise<void> {
  // Group outcomes by tool
  const grouped = new Map<string, { ok: number; fail: number }>();
  for (const outcome of state.adminToolOutcomes) {
    const current = grouped.get(outcome.toolName) ?? { ok: 0, fail: 0 };
    if (outcome.ok) current.ok++;
    else current.fail++;
    grouped.set(outcome.toolName, current);
  }

  for (const [toolName, counts] of grouped.entries()) {
    const total = counts.ok + counts.fail;
    const successRate = total > 0 ? counts.ok / total : 0;
    if (counts.ok >= 2 && successRate >= 0.8) {
      const text = `${toolName} is reliable in scheduler context; ${counts.ok}/${total} recent executions succeeded.`;
      await addStackMemory(text, 'procedural', 'consolidation');
    }
  }
}

async function addStackMemory(text: string, category: string, source: string): Promise<void> {
  try {
    await fetch(`${MEMORY_URL}/api/v1/memories/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: STACK_USER_ID,
        agent_id: 'openpalm',
        app_id: 'openpalm',
        text,
        app: 'openpalm-admin-tools',
        metadata: {
          category,
          source,
          confidence: 0.65,
          scope: 'stack',
        },
        infer: true,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best-effort — don't break plugin behavior
  }
}

function isAdminTool(toolName: string): boolean {
  return toolName.startsWith('admin-') ||
    toolName === 'stack-diagnostics' ||
    toolName === 'message-trace';
}

function didToolFail(input: HookInput, output: HookOutput): boolean {
  if (input.error || output.error) return true;
  const result = output.result ?? input.result;
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  if ('error' in record && Boolean(record.error)) return true;
  if ('ok' in record && record.ok === false) return true;
  if ('success' in record && record.success === false) return true;
  return false;
}

function getSessionId(input: HookInput): string {
  return input.session?.id ?? input.properties?.sessionId ?? 'unknown';
}

function ensureContext(output: HookOutput): string[] {
  if (!output.context) output.context = [];
  return output.context;
}

function asHookInput(value: unknown): HookInput {
  if (!value || typeof value !== 'object') return {};
  return value as HookInput;
}

function asHookOutput(value: unknown): HookOutput {
  if (!value || typeof value !== 'object') return {};
  return value as HookOutput;
}
