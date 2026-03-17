import { basename } from 'node:path';
import type { Plugin } from '@opencode-ai/plugin';
import {
  type MemoryIdentity,
  type MemoryItem,
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  MEMORY_URL,
  USER_ID,
  addMemoryIfNovel,
  formatMemoriesForContext,
  isMemoryAvailable,
  searchMemories,
  sendMemoryFeedback,
} from './memory-lib.ts';
import { buildHygieneContextNote, runAutomatedHygiene } from './memory-hygiene.ts';

type ToolOutcome = {
  toolName: string;
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  executionId: string;
};

type PendingFeedback = {
  memoryIds: string[];
  identity: MemoryIdentity;
  startedAt: number;
};

type SessionState = {
  sessionId: string;
  project: string;
  agentId: string;
  appId: string;
  startedAtIso: string;
  idleCount: number;
  lastLearningAtMs: number;
  contextInjected: boolean;
  commandSignals: Set<string>;
  outcomes: ToolOutcome[];
};

type HookInput = {
  session?: { id?: string };
  properties?: { sessionId?: string };
  project?: { name?: string };
  agent?: { name?: string };
  tool?: { name?: string };
  args?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  command?: unknown;
  execution?: { id?: string };
  toolCall?: { id?: string };
  call?: { id?: string };
  client?: unknown;
};

type HookOutput = {
  context?: string[];
  env?: Record<string, string>;
  result?: unknown;
  error?: unknown;
};

type LogClient = {
  app?: {
    log?: (args: {
      body: {
        service: string;
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<unknown>;
  };
};

const sessions = new Map<string, SessionState>();
const pendingToolFeedback = new Map<string, PendingFeedback[]>();

let lastHygieneRunAt = 0;
let sessionsSinceSynthesis = 0;

const HYGIENE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LEARNING_COOLDOWN_MS = 75_000;
const MIN_IDLE_COUNT_FOR_LEARNING = 2;
const SYNTHESIS_SESSION_INTERVAL = 8;
const SYNTHESIS_MIN_EPISODES = 10;
const MAX_SESSION_OUTCOMES = 100;
const INCLUDE_STACK_MEMORY =
  (process.env.MEMORY_INCLUDE_STACK_MEMORY ?? 'true').toLowerCase() !== 'false';
const INCLUDE_GLOBAL_PROCEDURAL =
  (process.env.MEMORY_INCLUDE_GLOBAL_PROCEDURAL ?? '').toLowerCase() === 'true';

export const MemoryContextPlugin: Plugin = async (ctx) => {
  await log(ctx.client, 'info', 'Memory lifecycle plugin initialized', {
    memoryUrl: MEMORY_URL,
  });

  return {
    'session.created': async (input, output) => {
      const hookInput = asHookInput(input);
      const hookOutput = asHookOutput(output);
      const sessionId = getSessionId(hookInput);
      const project = getProjectName(hookInput, ctx.directory);
      const agentId = getAgentName(hookInput);
      const appId = deriveAppId(project);

      sessions.set(sessionId, {
        sessionId,
        project,
        agentId,
        appId,
        startedAtIso: new Date().toISOString(),
        idleCount: 0,
        lastLearningAtMs: 0,
        contextInjected: false,
        commandSignals: new Set<string>(),
        outcomes: [],
      });
      const state = sessions.get(sessionId);
      if (!state) return;

      const personalIdentity = getSessionIdentity(state, 'personal');
      const memoryReady = await isMemoryAvailable(2_500, personalIdentity);
      if (!memoryReady) {
        await log(ctx.client, 'warn', 'Memory API unavailable during session.created', {
          sessionId,
          project,
        });
        return;
      }

      const retrieval = await retrieveSessionContext(state);
      const contextBlock = buildSessionContextBlock(state, retrieval);
      ensureContext(hookOutput).push(contextBlock);
      state.contextInjected = true;

      await maybeRunHygiene(state, hookOutput);
      sessionsSinceSynthesis++;
      await maybeRunCrossSessionSynthesis(state);
    },

    'command.executed': async (input) => {
      const hookInput = asHookInput(input);
      const sessionId = getSessionId(hookInput);
      const state = sessions.get(sessionId);
      if (!state) return;

      const commandText = readCommandText(hookInput.command);
      const preference = extractPreferenceSignal(commandText);
      if (!preference) return;

      if (state.commandSignals.has(preference)) return;
      state.commandSignals.add(preference);

      await addMemoryIfNovel(
        preference,
        {
          category: 'semantic',
          source: 'auto-extract',
          confidence: 0.65,
          keywords: ['preference', state.appId],
          project: state.project,
          session_id: sessionId,
          created_by_hook: 'command.executed',
        },
        getSessionIdentity(state, 'personal'),
      );
    },

    'session.idle': async (input) => {
      const hookInput = asHookInput(input);
      const sessionId = getSessionId(hookInput);
      const state = sessions.get(sessionId);
      if (!state) return;

      state.idleCount++;
      if (state.idleCount < MIN_IDLE_COUNT_FOR_LEARNING) return;

      const now = Date.now();
      if (now - state.lastLearningAtMs < LEARNING_COOLDOWN_MS) return;
      state.lastLearningAtMs = now;

      await persistSessionLearnings(state, { finalFlush: false });
    },

    'tool.execute.before': async (input, output) => {
      const hookInput = asHookInput(input);
      const hookOutput = asHookOutput(output);
      const toolName = hookInput.tool?.name;
      if (!toolName || toolName.startsWith('memory-')) return;

      const sessionId = getSessionId(hookInput);
      const state = sessions.get(sessionId);
      if (!state) return;

      if (!isProjectCodeTool(toolName)) return;

      const scopedMemories = await retrieveToolGuidance(state, toolName);
      if (scopedMemories.length === 0) return;

      const guidance = formatMemoriesForContext(
        scopedMemories,
        `### Learned Procedures For ${toolName}`,
      );
      ensureContext(hookOutput).push(guidance);

      const executionId = getExecutionId(hookInput, toolName, sessionId);
      const queue = pendingToolFeedback.get(executionId) ?? [];
      queue.push({
        memoryIds: scopedMemories.map((memory) => memory.id),
        identity: getSessionIdentity(state, 'personal'),
        startedAt: Date.now(),
      });
      pendingToolFeedback.set(executionId, queue);
    },

    'tool.execute.after': async (input, output) => {
      const hookInput = asHookInput(input);
      const hookOutput = asHookOutput(output);
      const toolName = hookInput.tool?.name;
      if (!toolName) return;

      const sessionId = getSessionId(hookInput);
      const state = sessions.get(sessionId);
      if (!state) return;

      const executionId = getExecutionId(hookInput, toolName, sessionId);
      const queue = pendingToolFeedback.get(executionId) ?? [];
      const pending = queue.shift();

      const failed = didToolFail(hookInput, hookOutput);
      if (pending && pending.memoryIds.length > 0) {
        const reason = failed
          ? `Tool ${toolName} failed after procedural memory injection`
          : `Tool ${toolName} succeeded with procedural memory injection`;
        await Promise.all(
          pending.memoryIds.map((memoryId) =>
            sendMemoryFeedback(memoryId, !failed, reason, {
              ...pending.identity,
              runId: sessionId,
            }),
          ),
        );
      }

      const startedAt = pending?.startedAt ?? Date.now();
      const finishedAt = Date.now();
      rememberOutcome(state, {
        toolName,
        ok: !failed,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        executionId,
      });
      if (queue.length === 0) {
        pendingToolFeedback.delete(executionId);
      } else {
        pendingToolFeedback.set(executionId, queue);
      }
    },

    'session.deleted': async (input) => {
      const hookInput = asHookInput(input);
      const sessionId = getSessionId(hookInput);
      const state = sessions.get(sessionId);
      if (!state) return;

      await persistSessionLearnings(state, { finalFlush: true });
      await persistSessionEpisode(state);

      sessions.delete(sessionId);
      for (const [executionId] of pendingToolFeedback.entries()) {
        if (executionId.startsWith(`${sessionId}::`)) {
          pendingToolFeedback.delete(executionId);
        }
      }
    },

    'experimental.session.compacting': async (input, output) => {
      const hookInput = asHookInput(input);
      const hookOutput = asHookOutput(output);
      const sessionId = getSessionId(hookInput);
      const state = sessions.get(sessionId);
      if (!state) return;

      const [semanticMemories, proceduralMemories] = await Promise.all([
        searchMemories('user preferences project context important decisions', {
          size: 8,
          category: 'semantic',
          timeoutMs: 1_200,
          highSignalOnly: true,
          ...getSessionIdentity(state, 'personal'),
        }),
        searchMemories('procedures workflows patterns', {
          size: 6,
          category: 'procedural',
          timeoutMs: 1_200,
          highSignalOnly: true,
          ...getSessionIdentity(state, 'personal'),
        }),
      ]);

      const lines: string[] = ['## Memory Context (Compaction)'];
      if (semanticMemories.length > 0) {
        lines.push('', '### Facts And Preferences', formatMemoriesForContext(semanticMemories));
      }
      if (proceduralMemories.length > 0) {
        lines.push('', '### Learned Procedures', formatMemoriesForContext(proceduralMemories));
      }
      lines.push('', '### Session State', `- Project: ${state.project}`, `- Tool outcomes tracked: ${state.outcomes.length}`);

      ensureContext(hookOutput).push(lines.join('\n'));
    },

    'shell.env': async (_input, output) => {
      const hookOutput = asHookOutput(output);
      if (!hookOutput.env) hookOutput.env = {};
      hookOutput.env.MEMORY_API_URL = MEMORY_URL;
      hookOutput.env.MEMORY_USER_ID = USER_ID;
    },
  };
};

async function retrieveSessionContext(state: SessionState): Promise<{
  personalSemantic: MemoryItem[];
  personalProcedural: MemoryItem[];
  projectScoped: MemoryItem[];
  stackProcedural: MemoryItem[];
  globalProcedural: MemoryItem[];
  episodic: MemoryItem[];
}> {
  const personalIdentity = getSessionIdentity(state, 'personal');
  const stackIdentity = getSessionIdentity(state, 'stack');
  const globalIdentity = getSessionIdentity(state, 'global');

  const [
    personalSemantic,
    personalProcedural,
    projectScoped,
    stackProcedural,
    globalProcedural,
    episodic,
  ] = await Promise.all([
    searchMemories('preferences conventions technical decisions', {
      size: 10,
      category: 'semantic',
      ...personalIdentity,
    }),
    searchMemories('procedures workflows patterns how to', {
      size: 7,
      category: 'procedural',
      ...personalIdentity,
    }),
    searchMemories(`${state.appId} project conventions coding patterns`, {
      size: 6,
      ...personalIdentity,
    }),
    INCLUDE_STACK_MEMORY
      ? searchMemories('openpalm operations procedures workflow', {
        size: 5,
        category: 'procedural',
        ...stackIdentity,
      })
      : Promise.resolve([] as MemoryItem[]),
    INCLUDE_GLOBAL_PROCEDURAL
      ? searchMemories('global procedural rules', {
        size: 4,
        category: 'procedural',
        ...globalIdentity,
      })
      : Promise.resolve([] as MemoryItem[]),
    searchMemories(`${state.appId} recent outcomes failures results`, {
      size: 8,
      category: 'episodic',
      ...personalIdentity,
    }),
  ]);

  return {
    personalSemantic: uniqueById(personalSemantic),
    personalProcedural: uniqueById(personalProcedural),
    projectScoped: uniqueById(projectScoped),
    stackProcedural: uniqueById(stackProcedural),
    globalProcedural: uniqueById(globalProcedural),
    episodic: uniqueById(episodic),
  };
}

function buildSessionContextBlock(
  state: SessionState,
  retrieval: {
    personalSemantic: MemoryItem[];
    personalProcedural: MemoryItem[];
    projectScoped: MemoryItem[];
    stackProcedural: MemoryItem[];
    globalProcedural: MemoryItem[];
    episodic: MemoryItem[];
  },
): string {
  const lines: string[] = ['## Memory - Session Context'];

  if (retrieval.personalSemantic.length > 0) {
    lines.push('', '### Personal Facts And Preferences', formatMemoriesForContext(retrieval.personalSemantic));
  }
  if (retrieval.personalProcedural.length > 0) {
    lines.push('', '### Personal Procedures', formatMemoriesForContext(retrieval.personalProcedural));
  }
  if (retrieval.projectScoped.length > 0) {
    lines.push('', `### Project Context (${state.appId})`, formatMemoriesForContext(retrieval.projectScoped));
  }
  if (retrieval.stackProcedural.length > 0) {
    lines.push('', '### OpenPalm Stack Procedures', formatMemoriesForContext(retrieval.stackProcedural));
  }
  if (retrieval.globalProcedural.length > 0) {
    lines.push('', '### Global Procedures', formatMemoriesForContext(retrieval.globalProcedural));
  }
  if (retrieval.episodic.length > 0) {
    lines.push('', '### Recent Episodic Notes', formatMemoriesForContext(retrieval.episodic));
  }

  lines.push(
    '',
    '### Memory Lifecycle',
    '- Context retrieval is automatic at session start.',
    '- Tool outcomes automatically reinforce or downrank injected memories.',
    '- Session learnings and episodic summaries are curated automatically.',
    '- Use `memory-search` and `memory-add` for explicit memory control.',
  );
  return lines.join('\n');
}

async function retrieveToolGuidance(
  state: SessionState,
  toolName: string,
): Promise<MemoryItem[]> {
  const [personalProcedural, projectPatterns] = await Promise.all([
    searchMemories(`preferred workflow for ${toolName.replace(/_/g, ' ')}`, {
      size: 4,
      category: 'procedural',
      timeoutMs: 1_200,
      highSignalOnly: true,
      ...getSessionIdentity(state, 'personal'),
    }),
    searchMemories(`${state.appId} project patterns for ${toolName.replace(/_/g, ' ')}`, {
      size: 4,
      timeoutMs: 1_200,
      ...getSessionIdentity(state, 'personal'),
    }),
  ]);

  return uniqueById([...personalProcedural, ...projectPatterns]);
}

async function persistSessionLearnings(
  state: SessionState,
  options: { finalFlush: boolean },
): Promise<void> {
  if (state.outcomes.length === 0) return;

  const grouped = groupOutcomesByTool(state.outcomes);
  const personalIdentity = getSessionIdentity(state, 'personal');
  const additions: Promise<string | null>[] = [];

  for (const [toolName, outcomes] of grouped.entries()) {
    const attempts = outcomes.length;
    const successes = outcomes.filter((o) => o.ok).length;
    const failureCount = attempts - successes;
    const successRate = attempts > 0 ? successes / attempts : 0;

    if (successes >= 2 && successRate >= 0.8) {
      additions.push(
        addMemoryIfNovel(
          `${toolName} is a reliable workflow in ${state.appId}; ${successes}/${attempts} recent executions succeeded.`,
          {
            category: 'procedural',
            source: 'consolidation',
            confidence: clamp(0.55 + successRate * 0.35, 0.55, 0.95),
            keywords: [toolName, 'workflow', 'success', state.appId],
            project: state.project,
            session_id: state.sessionId,
            created_by_hook: options.finalFlush ? 'session.deleted' : 'session.idle',
          },
          personalIdentity,
        ),
      );
    }

    if (failureCount >= 2 && successRate <= 0.35) {
      additions.push(
        addMemoryIfNovel(
          `${toolName} has low reliability in ${state.appId}; validate prerequisites before using it.`,
          {
            category: 'procedural',
            source: 'consolidation',
            confidence: 0.55,
            expiration_days: 45,
            keywords: [toolName, 'failure', 'prerequisite', state.appId],
            project: state.project,
            session_id: state.sessionId,
            created_by_hook: options.finalFlush ? 'session.deleted' : 'session.idle',
          },
          personalIdentity,
        ),
      );
    }
  }

  await Promise.all(additions);
}

async function persistSessionEpisode(state: SessionState): Promise<void> {
  if (state.idleCount < MIN_IDLE_COUNT_FOR_LEARNING) return;
  if (!(await isMemoryAvailable(1_800, getSessionIdentity(state, 'personal')))) return;

  const grouped = groupOutcomesByTool(state.outcomes);
  const fragments: string[] = [];
  for (const [toolName, outcomes] of grouped.entries()) {
    const successCount = outcomes.filter((outcome) => outcome.ok).length;
    fragments.push(`${toolName} ${successCount}/${outcomes.length} succeeded`);
  }

  const episode =
    `Session ${state.sessionId} in ${state.appId} ran ${state.outcomes.length} tracked tool executions. ` +
    `Outcome snapshot: ${fragments.slice(0, 6).join('; ') || 'no tool outcomes recorded'}.`;

  await addMemoryIfNovel(
    episode,
    {
      category: 'episodic',
      source: 'auto-extract',
      confidence: 0.78,
      session_id: state.sessionId,
      project: state.project,
      keywords: ['session-summary', state.appId],
      created_by_hook: 'session.deleted',
    },
    getSessionIdentity(state, 'personal'),
  );
}

async function maybeRunCrossSessionSynthesis(state: SessionState): Promise<void> {
  if (sessionsSinceSynthesis < SYNTHESIS_SESSION_INTERVAL) return;

  const episodes = await searchMemories(`${state.appId} session outcomes failures successes`, {
    size: 30,
    category: 'episodic',
    timeoutMs: 2_500,
    ...getSessionIdentity(state, 'personal'),
  });
  if (episodes.length < SYNTHESIS_MIN_EPISODES) return;

  sessionsSinceSynthesis = 0;
  const recurring = extractRecurringOutcomeSignals(episodes, state.appId);
  if (recurring.length === 0) return;

  await Promise.all(
    recurring.map((signal) =>
      addMemoryIfNovel(
        signal,
        {
          category: 'procedural',
          source: 'consolidation',
          confidence: 0.6,
          keywords: ['cross-session', 'synthesis', state.appId],
          project: state.project,
          created_by_hook: 'session.created',
        },
        getSessionIdentity(state, 'personal'),
      ),
    ),
  );
}

async function maybeRunHygiene(state: SessionState, output: HookOutput): Promise<void> {
  const now = Date.now();
  if (now - lastHygieneRunAt < HYGIENE_INTERVAL_MS) return;
  lastHygieneRunAt = now;

  const report = await runAutomatedHygiene(getSessionIdentity(state, 'personal'));
  const note = buildHygieneContextNote(report);
  if (note) ensureContext(output).push(note);
}

function getSessionIdentity(
  state: SessionState,
  scope: 'personal' | 'stack' | 'global',
): MemoryIdentity {
  return {
    scope,
    appId: state.appId || DEFAULT_APP_ID,
  };
}

function rememberOutcome(state: SessionState, outcome: ToolOutcome): void {
  state.outcomes.push(outcome);
  if (state.outcomes.length > MAX_SESSION_OUTCOMES) {
    state.outcomes.splice(0, state.outcomes.length - MAX_SESSION_OUTCOMES);
  }
}

function extractRecurringOutcomeSignals(episodes: MemoryItem[], appId: string): string[] {
  const counts = new Map<string, number>();
  for (const episode of episodes) {
    const text = episode.content.toLowerCase();
    for (const token of text.split(/[^a-z0-9_-]+/g)) {
      if (!token || token.length < 4) continue;
      if (!token.includes('memory-') && !token.includes('bash')) {
        continue;
      }
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const recurring: string[] = [];
  for (const [token, count] of counts.entries()) {
    if (count < 3) continue;
    recurring.push(`Across recent ${appId} sessions, ${token} appears repeatedly; prefer validating context before and after using it.`);
  }
  return recurring.slice(0, 4);
}

function groupOutcomesByTool(outcomes: ToolOutcome[]): Map<string, ToolOutcome[]> {
  const grouped = new Map<string, ToolOutcome[]>();
  for (const outcome of outcomes) {
    const list = grouped.get(outcome.toolName) ?? [];
    list.push(outcome);
    grouped.set(outcome.toolName, list);
  }
  return grouped;
}

function isProjectCodeTool(toolName: string): boolean {
  const codePrefixes = [
    'bash',
    'view',
    'rg',
    'glob',
    'task',
    'search_code_subagent',
    'apply_patch',
    'read_bash',
    'write_bash',
    'code_review',
  ];
  return codePrefixes.some((prefix) => toolName.startsWith(prefix));
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

function getProjectName(input: HookInput, directory: string): string {
  return input.project?.name ?? directory ?? 'unknown';
}

function getAgentName(input: HookInput): string {
  return input.agent?.name ?? DEFAULT_AGENT_ID;
}

function readCommandText(command: unknown): string | null {
  if (typeof command === 'string' && command.trim()) return command.trim();
  if (!command || typeof command !== 'object') return null;

  const record = command as Record<string, unknown>;
  const direct = record.text ?? record.command ?? record.raw;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const parts = record.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const partRecord = part as Record<string, unknown>;
      if (typeof partRecord.text === 'string' && partRecord.text.trim()) {
        return partRecord.text.trim();
      }
    }
  }
  return null;
}

function extractPreferenceSignal(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length < 24 || trimmed.length > 240) return null;

  const preferencePatterns = [
    /\b(i|we)\s+(prefer|like)\b/i,
    /\b(always|never|avoid|please use|do not)\b/i,
    /\bconvention\b/i,
  ];
  const hasSignal = preferencePatterns.some((pattern) => pattern.test(trimmed));
  if (!hasSignal) return null;

  const redacted = redactSecrets(trimmed);
  if (!redacted) return null;
  return `Preference: ${redacted}`;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(sk-[a-zA-Z0-9]{8,})\b/g, '[redacted-token]')
    .replace(/\b([a-zA-Z0-9_]{24,}\.[a-zA-Z0-9_\-]{6,}\.[a-zA-Z0-9_\-]{20,})\b/g, '[redacted-jwt]')
    .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .trim();
}

function getExecutionId(input: HookInput, toolName: string, sessionId: string): string {
  const explicitId =
    input.execution?.id ?? input.toolCall?.id ?? input.call?.id;
  if (explicitId) return `${sessionId}::${explicitId}`;

  const argsSignature = hashArgs(input.args);
  return `${sessionId}::${toolName}::${argsSignature}`;
}

function hashArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return 'noargs';
  try {
    const asJson = JSON.stringify(args);
    if (!asJson) return 'noargs';
    let hash = 0;
    for (let index = 0; index < asJson.length; index++) {
      hash = (hash * 31 + asJson.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  } catch {
    return 'noargs';
  }
}

function deriveAppId(project: string): string {
  if (!project || project === 'unknown') return DEFAULT_APP_ID;
  const projectName = basename(project);
  if (!projectName || projectName === '.' || projectName === '/') {
    return DEFAULT_APP_ID;
  }
  return normaliseIdValue(projectName);
}

function normaliseIdValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
}

function uniqueById(items: MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  const unique: MemoryItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function ensureContext(output: HookOutput): string[] {
  if (!output.context) output.context = [];
  return output.context;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function asHookInput(value: unknown): HookInput {
  if (!value || typeof value !== 'object') return {};
  return value as HookInput;
}

function asHookOutput(value: unknown): HookOutput {
  if (!value || typeof value !== 'object') return {};
  return value as HookOutput;
}

async function log(
  client: unknown,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const logger = (client as LogClient | undefined)?.app?.log;
  if (!logger) return;
  try {
    await logger({
      body: {
        service: 'assistant-memory-lifecycle',
        level,
        message,
        extra,
      },
    });
  } catch {
    // Logging must not break plugin behavior.
  }
}
