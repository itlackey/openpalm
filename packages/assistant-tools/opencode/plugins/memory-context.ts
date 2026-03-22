import type { Plugin } from '@opencode-ai/plugin';
import {
  MEMORY_URL,
  USER_ID,
  addMemoryIfNovel,
  formatMemoriesForContext,
  isMemoryAvailable,
  searchMemories,
  sendMemoryFeedback,
} from './memory-lib.ts';
import { buildHygieneContextNote, runAutomatedHygiene } from './memory-hygiene.ts';
import { isVikingConfigured, vikingFetch, vikingResponseHasError } from '../tools/viking-lib.ts';
import {
  type HookIO,
  type SessionState,
  asRecord,
  deriveAppId,
  didToolFail,
  ensureContext,
  extractPreferenceSignal,
  getExecutionId,
  getIdentity,
  getSessionId,
  initViking,
  isProjectCodeTool,
  log,
  maybeSynthesizeCrossSessions,
  persistSessionEpisode,
  persistSessionLearnings,
  readCommandText,
  rememberOutcome,
  retrieveAndBuildSessionContext,
  retrieveToolGuidance,
} from './memory-context-helpers.ts';

const sessions = new Map<string, SessionState>();
const pendingToolFeedback = new Map<string, { memoryIds: string[]; identity: { scope?: string; appId?: string }; startedAt: number }[]>();

let lastHygieneRunAt = 0;
let sessionsSinceSynthesis = 0;

const HYGIENE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LEARNING_COOLDOWN_MS = 75_000;
const MIN_IDLE_COUNT_FOR_LEARNING = 2;
const SYNTHESIS_SESSION_INTERVAL = 8;
const SYNTHESIS_MIN_EPISODES = 10;
const INCLUDE_STACK_MEMORY = (process.env.MEMORY_INCLUDE_STACK_MEMORY ?? 'true').toLowerCase() !== 'false';
const INCLUDE_GLOBAL_PROCEDURAL = (process.env.MEMORY_INCLUDE_GLOBAL_PROCEDURAL ?? '').toLowerCase() === 'true';

export const MemoryContextPlugin: Plugin = async (ctx) => {
  await log(ctx.client, 'info', 'Memory lifecycle plugin initialized', { memoryUrl: MEMORY_URL });

  return {
    'session.created': async (input, output) => {
      const inp = asRecord(input);
      const out = asRecord(output);
      const sessionId = getSessionId(inp);
      const project = (inp?.project as Record<string, unknown>)?.name as string ?? ctx.directory ?? 'unknown';

      const state: SessionState = {
        sessionId, project, appId: deriveAppId(project),
        startedAtIso: new Date().toISOString(), idleCount: 0, lastLearningAtMs: 0,
        contextInjected: false, commandSignals: new Set<string>(), outcomes: [],
        vikingSessionId: null, vikingAvailable: false, vikingSessionCommitted: false,
      };
      sessions.set(sessionId, state);

      if (!(await isMemoryAvailable(2_500, getIdentity(state, 'personal')))) {
        await log(ctx.client, 'warn', 'Memory API unavailable during session.created', { sessionId, project });
        return;
      }

      ensureContext(out).push(await retrieveAndBuildSessionContext(state, INCLUDE_STACK_MEMORY, INCLUDE_GLOBAL_PROCEDURAL));
      state.contextInjected = true;

      const vikingCtx = await initViking(state, sessionId, ctx.client);
      if (vikingCtx.length > 0) ensureContext(out).push('## Viking Knowledge Context\n' + vikingCtx.join('\n\n'));

      await maybeRunHygiene(state, out);
      sessionsSinceSynthesis++;
      const syn = await maybeSynthesizeCrossSessions(state, sessionsSinceSynthesis, SYNTHESIS_SESSION_INTERVAL, SYNTHESIS_MIN_EPISODES);
      if (syn.reset) sessionsSinceSynthesis = 0;
    },

    'command.executed': async (input) => {
      const inp = asRecord(input);
      const state = sessions.get(getSessionId(inp));
      if (!state) return;
      const preference = extractPreferenceSignal(readCommandText(inp?.command));
      if (!preference || state.commandSignals.has(preference)) return;
      state.commandSignals.add(preference);
      await addMemoryIfNovel(preference, {
        category: 'semantic', source: 'auto-extract', confidence: 0.65,
        keywords: ['preference', state.appId], project: state.project,
        session_id: state.sessionId, created_by_hook: 'command.executed',
      }, getIdentity(state, 'personal'));
    },

    'session.idle': async (input) => {
      const state = sessions.get(getSessionId(asRecord(input)));
      if (!state) return;
      state.idleCount++;
      if (state.idleCount < MIN_IDLE_COUNT_FOR_LEARNING) return;
      const now = Date.now();
      if (now - state.lastLearningAtMs < LEARNING_COOLDOWN_MS) return;
      state.lastLearningAtMs = now;
      await persistSessionLearnings(state, false);
    },

    'tool.execute.before': async (input, output) => {
      const inp = asRecord(input);
      const toolName = (inp?.tool as Record<string, unknown>)?.name as string | undefined;
      if (!toolName || toolName.startsWith('memory-') || !isProjectCodeTool(toolName)) return;
      const state = sessions.get(getSessionId(inp));
      if (!state) return;
      const memories = await retrieveToolGuidance(state, toolName);
      if (memories.length === 0) return;
      ensureContext(asRecord(output)).push(formatMemoriesForContext(memories, `### Learned Procedures For ${toolName}`));
      const eid = getExecutionId(inp, toolName, state.sessionId);
      const queue = pendingToolFeedback.get(eid) ?? [];
      queue.push({ memoryIds: memories.map((m) => m.id), identity: getIdentity(state, 'personal'), startedAt: Date.now() });
      pendingToolFeedback.set(eid, queue);
    },

    'tool.execute.after': async (input, output) => {
      const inp = asRecord(input);
      const toolName = (inp?.tool as Record<string, unknown>)?.name as string | undefined;
      if (!toolName) return;
      const sessionId = getSessionId(inp);
      const state = sessions.get(sessionId);
      if (!state) return;

      const eid = getExecutionId(inp, toolName, sessionId);
      const queue = pendingToolFeedback.get(eid) ?? [];
      const pending = queue.shift();
      const failed = didToolFail(inp, asRecord(output));

      if (pending && pending.memoryIds.length > 0) {
        await Promise.all(pending.memoryIds.map((id) =>
          sendMemoryFeedback(id, !failed, `Tool ${toolName} ${failed ? 'failed' : 'succeeded'} with procedural memory injection`, { ...pending.identity, runId: sessionId })));
      }

      const t0 = pending?.startedAt ?? Date.now();
      const t1 = Date.now();
      rememberOutcome(state, { toolName, ok: !failed, startedAt: t0, finishedAt: t1, durationMs: t1 - t0, executionId: eid });

      if (state.vikingAvailable && state.vikingSessionId) {
        vikingFetch(`/sessions/${state.vikingSessionId}/messages`, {
          method: 'POST', body: JSON.stringify({ role: 'assistant', content: `Tool ${toolName} ${!failed ? 'succeeded' : 'failed'} (${t1 - t0}ms)` }),
        }).catch(() => {});
      }

      if (queue.length === 0) pendingToolFeedback.delete(eid);
      else pendingToolFeedback.set(eid, queue);
    },

    'session.deleted': async (input) => {
      const sessionId = getSessionId(asRecord(input));
      const state = sessions.get(sessionId);
      if (!state) return;

      if (state.vikingAvailable && state.vikingSessionId && !state.vikingSessionCommitted) {
        state.vikingSessionCommitted = !vikingResponseHasError(
          await vikingFetch(`/sessions/${state.vikingSessionId}/commit`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(60_000) }));
      }

      await persistSessionLearnings(state, true);
      await persistSessionEpisode(state, MIN_IDLE_COUNT_FOR_LEARNING);
      sessions.delete(sessionId);
      for (const [eid] of pendingToolFeedback.entries()) {
        if (eid.startsWith(`${sessionId}::`)) pendingToolFeedback.delete(eid);
      }
    },

    'experimental.session.compacting': async (input, output) => {
      const state = sessions.get(getSessionId(asRecord(input)));
      const out = asRecord(output);
      if (!state) return;

      const identity = getIdentity(state, 'personal');
      const [semantic, procedural] = await Promise.all([
        searchMemories('user preferences project context important decisions', { size: 8, category: 'semantic', timeoutMs: 1_200, highSignalOnly: true, ...identity }),
        searchMemories('procedures workflows patterns', { size: 6, category: 'procedural', timeoutMs: 1_200, highSignalOnly: true, ...identity }),
      ]);

      const lines: string[] = ['## Memory Context (Compaction)'];
      if (semantic.length > 0) lines.push('', '### Facts And Preferences', formatMemoriesForContext(semantic));
      if (procedural.length > 0) lines.push('', '### Learned Procedures', formatMemoriesForContext(procedural));

      if (state.vikingAvailable) {
        try {
          const r = await vikingFetch('/content/overview?uri=' + encodeURIComponent('viking://agent/memories/'), { signal: AbortSignal.timeout(5_000) });
          if (!vikingResponseHasError(r)) {
            const p = JSON.parse(r);
            if (p?.result) lines.push('', '### Viking Knowledge Overview', p.result);
          }
        } catch { /* compaction must not fail */ }
      }

      lines.push('', '### Session State', `- Project: ${state.project}`, `- Tool outcomes tracked: ${state.outcomes.length}`);
      ensureContext(out).push(lines.join('\n'));
    },

    'shell.env': async (_input, output) => {
      const out = asRecord(output);
      if (!out.env) out.env = {};
      const env = out.env as Record<string, string>;
      env.MEMORY_API_URL = MEMORY_URL;
      env.MEMORY_USER_ID = USER_ID;
      if (isVikingConfigured()) env.OPENVIKING_URL = process.env.OPENVIKING_URL ?? '';
    },
  };
};

async function maybeRunHygiene(state: SessionState, output: HookIO): Promise<void> {
  const now = Date.now();
  if (now - lastHygieneRunAt < HYGIENE_INTERVAL_MS) return;
  lastHygieneRunAt = now;
  const report = await runAutomatedHygiene(getIdentity(state, 'personal'));
  const note = buildHygieneContextNote(report);
  if (note) ensureContext(output).push(note);
}
