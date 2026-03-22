/**
 * Pure helper functions for memory-context plugin.
 * Extracted to keep the main plugin file under FTA complexity thresholds.
 */
import { basename } from 'node:path';
import type { MemoryIdentity, MemoryItem } from './memory-lib.ts';
import {
  DEFAULT_APP_ID,
  addMemoryIfNovel,
  formatMemoriesForContext,
  isMemoryAvailable,
  searchMemories,
} from './memory-lib.ts';
import { isVikingConfigured, vikingFetch, vikingResponseHasError } from '../tools/viking-lib.ts';

export type HookIO = Record<string, unknown>;

export type ToolOutcome = {
  toolName: string;
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  executionId: string;
};

export type PendingFeedback = {
  memoryIds: string[];
  identity: MemoryIdentity;
  startedAt: number;
};

export type SessionState = {
  sessionId: string;
  project: string;
  appId: string;
  startedAtIso: string;
  idleCount: number;
  lastLearningAtMs: number;
  contextInjected: boolean;
  commandSignals: Set<string>;
  outcomes: ToolOutcome[];
  vikingSessionId: string | null;
  vikingAvailable: boolean;
  vikingSessionCommitted: boolean;
};

const CODE_TOOL_PREFIXES = ['bash', 'view', 'rg', 'glob', 'task', 'search_code_subagent', 'apply_patch', 'read_bash', 'write_bash', 'code_review'];
const PREFERENCE_PATTERNS = [/\b(i|we)\s+(prefer|like)\b/i, /\b(always|never|avoid|please use|do not)\b/i, /\bconvention\b/i];
const SECRET_REDACTIONS: [RegExp, string][] = [
  [/\b(sk-[a-zA-Z0-9]{8,})\b/g, '[redacted-token]'],
  [/\b([a-zA-Z0-9_]{24,}\.[a-zA-Z0-9_\-]{6,}\.[a-zA-Z0-9_\-]{20,})\b/g, '[redacted-jwt]'],
  [/\b(password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]'],
];

export function getIdentity(state: SessionState, scope: 'personal' | 'stack' | 'global'): MemoryIdentity {
  return { scope, appId: state.appId || DEFAULT_APP_ID };
}

export function getSessionId(input: HookIO | undefined): string {
  const session = input?.session as Record<string, unknown> | undefined;
  const props = input?.properties as Record<string, unknown> | undefined;
  return (session?.id ?? props?.sessionId ?? 'unknown') as string;
}

export function deriveAppId(project: string): string {
  if (!project || project === 'unknown') return DEFAULT_APP_ID;
  const name = basename(project);
  if (!name || name === '.' || name === '/') return DEFAULT_APP_ID;
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
}

export function isProjectCodeTool(toolName: string): boolean {
  return CODE_TOOL_PREFIXES.some((p) => toolName.startsWith(p));
}

export function didToolFail(input: HookIO, output: HookIO): boolean {
  if (input?.error || output?.error) return true;
  const r = (output?.result ?? input?.result) as Record<string, unknown> | null;
  return !!r && typeof r === 'object' && (Boolean(r.error) || r.ok === false || r.success === false);
}

export function readCommandText(command: unknown): string | null {
  if (typeof command === 'string') return command.trim() || null;
  const rec = command as Record<string, unknown> | null;
  if (!rec || typeof rec !== 'object') return null;
  for (const key of ['text', 'command', 'raw'] as const) {
    if (typeof rec[key] === 'string' && (rec[key] as string).trim()) return (rec[key] as string).trim();
  }
  return null;
}

export function extractPreferenceSignal(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length < 24 || trimmed.length > 240) return null;
  if (!PREFERENCE_PATTERNS.some((p) => p.test(trimmed))) return null;
  let redacted = trimmed;
  for (const [pattern, replacement] of SECRET_REDACTIONS) redacted = redacted.replace(pattern, replacement);
  redacted = redacted.trim();
  return redacted ? `Preference: ${redacted}` : null;
}

export function getExecutionId(input: HookIO, toolName: string, sessionId: string): string {
  const explicitId = (input?.execution as Record<string, unknown>)?.id
    ?? (input?.toolCall as Record<string, unknown>)?.id
    ?? (input?.call as Record<string, unknown>)?.id;
  if (explicitId) return `${sessionId}::${explicitId}`;
  try {
    const json = JSON.stringify(input?.args) || '';
    let h = 0;
    for (let i = 0; i < json.length; i++) h = (h * 31 + json.charCodeAt(i)) | 0;
    return `${sessionId}::${toolName}::${Math.abs(h).toString(36)}`;
  } catch { return `${sessionId}::${toolName}::noargs`; }
}

export function uniqueById(items: MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function ensureContext(output: HookIO): string[] {
  if (!output.context) output.context = [];
  return output.context as string[];
}

export function asRecord(value: unknown): HookIO {
  if (value && typeof value === 'object') return value as HookIO;
  return {};
}

export function groupOutcomesByTool(outcomes: ToolOutcome[]): Map<string, ToolOutcome[]> {
  const grouped = new Map<string, ToolOutcome[]>();
  for (const o of outcomes) {
    const list = grouped.get(o.toolName) ?? [];
    list.push(o);
    grouped.set(o.toolName, list);
  }
  return grouped;
}

export function extractRecurringOutcomeSignals(episodes: MemoryItem[], appId: string): string[] {
  const counts = new Map<string, number>();
  const text = episodes.map((e) => e.content.toLowerCase()).join(' ');
  for (const token of text.split(/[^a-z0-9_-]+/g)) {
    if (token.length >= 4 && (token.includes('memory-') || token.includes('bash'))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 3)
    .slice(0, 4)
    .map(([t]) => `Across recent ${appId} sessions, ${t} appears repeatedly; prefer validating context before and after using it.`);
}

export function rememberOutcome(state: SessionState, outcome: ToolOutcome): void {
  state.outcomes.push(outcome);
  if (state.outcomes.length > 100) {
    state.outcomes.splice(0, state.outcomes.length - 100);
  }
}

export async function log(
  client: unknown,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const logger = (client as Record<string, unknown> | undefined)?.app as Record<string, unknown> | undefined;
  const logFn = logger?.log as ((args: unknown) => Promise<unknown>) | undefined;
  if (!logFn) return;
  try {
    await logFn({ body: { service: 'assistant-memory-lifecycle', level, message, extra } });
  } catch { /* logging must not break plugin behavior */ }
}

// ── Learning Persistence ────────────────────────────────────────────────

export async function persistSessionLearnings(state: SessionState, finalFlush: boolean): Promise<void> {
  if (state.outcomes.length === 0) return;
  const identity = getIdentity(state, 'personal');
  const hookName = finalFlush ? 'session.deleted' : 'session.idle';
  const additions: Promise<string | null>[] = [];

  for (const [toolName, outcomes] of groupOutcomesByTool(state.outcomes).entries()) {
    const successes = outcomes.filter((o) => o.ok).length;
    const rate = successes / outcomes.length;
    if (successes >= 2 && rate >= 0.8) {
      additions.push(addMemoryIfNovel(
        `${toolName} is a reliable workflow in ${state.appId}; ${successes}/${outcomes.length} recent executions succeeded.`,
        { category: 'procedural', source: 'consolidation', confidence: Math.min(0.95, 0.55 + rate * 0.35),
          keywords: [toolName, 'workflow', state.appId], project: state.project, session_id: state.sessionId, created_by_hook: hookName },
        identity));
    } else if (outcomes.length - successes >= 2 && rate <= 0.35) {
      additions.push(addMemoryIfNovel(
        `${toolName} has low reliability in ${state.appId}; validate prerequisites before using it.`,
        { category: 'procedural', source: 'consolidation', confidence: 0.55, expiration_days: 45,
          keywords: [toolName, 'failure', state.appId], project: state.project, session_id: state.sessionId, created_by_hook: hookName },
        identity));
    }
  }
  await Promise.all(additions);
}

export async function persistSessionEpisode(state: SessionState, minIdleCount: number): Promise<void> {
  if (state.idleCount < minIdleCount) return;
  if (!(await isMemoryAvailable(1_800, getIdentity(state, 'personal')))) return;

  const fragments: string[] = [];
  for (const [tool, outs] of groupOutcomesByTool(state.outcomes).entries()) {
    fragments.push(`${tool} ${outs.filter((o) => o.ok).length}/${outs.length} succeeded`);
  }
  await addMemoryIfNovel(
    `Session ${state.sessionId} in ${state.appId} ran ${state.outcomes.length} tracked tool executions. Outcome snapshot: ${fragments.slice(0, 6).join('; ') || 'no tool outcomes recorded'}.`,
    { category: 'episodic', source: 'auto-extract', confidence: 0.78, session_id: state.sessionId, project: state.project, keywords: ['session-summary', state.appId], created_by_hook: 'session.deleted' },
    getIdentity(state, 'personal'));
}

export async function maybeSynthesizeCrossSessions(
  state: SessionState,
  sessionsSinceSynthesis: number,
  interval: number,
  minEpisodes: number,
): Promise<{ reset: boolean }> {
  if (sessionsSinceSynthesis < interval) return { reset: false };
  const episodes = await searchMemories(`${state.appId} session outcomes failures successes`, { size: 30, category: 'episodic', timeoutMs: 2_500, ...getIdentity(state, 'personal') });
  if (episodes.length < minEpisodes) return { reset: false };
  const recurring = extractRecurringOutcomeSignals(episodes, state.appId);
  await Promise.all(recurring.map((signal) =>
    addMemoryIfNovel(signal, { category: 'procedural', source: 'consolidation', confidence: 0.6, keywords: ['cross-session', 'synthesis', state.appId], project: state.project, created_by_hook: 'session.created' }, getIdentity(state, 'personal'))));
  return { reset: true };
}

// ── Viking ──────────────────────────────────────────────────────────────

export async function initViking(state: SessionState, sessionId: string, client: unknown): Promise<string[]> {
  if (!isVikingConfigured()) return [];
  state.vikingAvailable = true;
  const context: string[] = [];
  try {
    const [sessionResult, memoriesAbstract, resourcesAbstract] = await Promise.all([
      vikingFetch('/sessions', { method: 'POST', body: '{}' }),
      vikingFetch('/content/abstract?uri=' + encodeURIComponent('viking://agent/memories/')),
      vikingFetch('/content/abstract?uri=' + encodeURIComponent('viking://resources/')),
    ]);
    if (!vikingResponseHasError(sessionResult)) {
      state.vikingSessionId = JSON.parse(sessionResult)?.result?.session_id ?? null;
    }
    for (const [label, raw] of [['Viking Agent Memories', memoriesAbstract], ['Viking Resources', resourcesAbstract]] as const) {
      if (!vikingResponseHasError(raw)) {
        const parsed = JSON.parse(raw);
        if (parsed?.result) context.push(`### ${label}\n${parsed.result}`);
      }
    }
  } catch (err) {
    await log(client, 'warn', 'Viking initialization failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    state.vikingAvailable = false;
  }
  if (state.vikingAvailable && !state.vikingSessionId) state.vikingAvailable = false;
  return context;
}

// ── Session Context Retrieval ───────────────────────────────────────────

export async function retrieveAndBuildSessionContext(
  state: SessionState,
  includeStack: boolean,
  includeGlobal: boolean,
): Promise<string> {
  const personal = getIdentity(state, 'personal');
  const searches: [string, Promise<MemoryItem[]>][] = [
    ['Personal Facts And Preferences', searchMemories('preferences conventions technical decisions', { size: 10, category: 'semantic', ...personal })],
    ['Personal Procedures', searchMemories('procedures workflows patterns how to', { size: 7, category: 'procedural', ...personal })],
    [`Project Context (${state.appId})`, searchMemories(`${state.appId} project conventions coding patterns`, { size: 6, ...personal })],
    ['OpenPalm Stack Procedures', includeStack ? searchMemories('openpalm operations procedures workflow', { size: 5, category: 'procedural', ...getIdentity(state, 'stack') }) : Promise.resolve([])],
    ['Global Procedures', includeGlobal ? searchMemories('global procedural rules', { size: 4, category: 'procedural', ...getIdentity(state, 'global') }) : Promise.resolve([])],
    ['Recent Episodic Notes', searchMemories(`${state.appId} recent outcomes failures results`, { size: 8, category: 'episodic', ...personal })],
  ];
  const results = await Promise.all(searches.map(([, p]) => p));
  const lines: string[] = ['## Memory - Session Context'];
  for (let i = 0; i < searches.length; i++) {
    const items = uniqueById(results[i]);
    if (items.length > 0) lines.push('', `### ${searches[i][0]}`, formatMemoriesForContext(items));
  }
  lines.push('', '### Memory Lifecycle',
    '- Context retrieval is automatic at session start.',
    '- Tool outcomes automatically reinforce or downrank injected memories.',
    '- Session learnings and episodic summaries are curated automatically.',
    '- Use `memory-search` and `memory-add` for explicit memory control.');
  return lines.join('\n');
}

export async function retrieveToolGuidance(state: SessionState, toolName: string): Promise<MemoryItem[]> {
  const name = toolName.replace(/_/g, ' ');
  const identity = getIdentity(state, 'personal');
  const [a, b] = await Promise.all([
    searchMemories(`preferred workflow for ${name}`, { size: 4, category: 'procedural', timeoutMs: 1_200, highSignalOnly: true, ...identity }),
    searchMemories(`${state.appId} project patterns for ${name}`, { size: 4, timeoutMs: 1_200, ...identity }),
  ]);
  return uniqueById([...a, ...b]);
}
