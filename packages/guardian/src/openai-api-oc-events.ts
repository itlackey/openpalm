export interface RawEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export function asRaw(ev: unknown): RawEvent {
  const event = ev as RawEvent;
  return {
    type: typeof event?.type === 'string' ? event.type : '',
    properties: (event?.properties ?? {}) as Record<string, unknown>,
  };
}

function propStr(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function partSnapshotType(e: RawEvent): { partID: string; type: string } | null {
  if (e.type !== 'message.part.updated') return null;
  const part = e.properties?.part as { id?: unknown; type?: unknown } | undefined;
  if (part && typeof part.id === 'string' && typeof part.type === 'string') {
    return { partID: part.id, type: part.type };
  }
  return null;
}

export function extractTextDelta(e: RawEvent, sessionId: string, reasoningPartIds?: ReadonlySet<string>): string | null {
  const props = e.properties ?? {};
  if (propStr(props, 'sessionID') !== sessionId) return null;

  if (e.type === 'session.next.text.delta') {
    return propStr(props, 'delta') ?? propStr(props, 'text') ?? null;
  }
  if (e.type === 'message.part.delta') {
    if (propStr(props, 'field') && propStr(props, 'field') !== 'text') return null;
    const partID = propStr(props, 'partID');
    if (partID && reasoningPartIds?.has(partID)) return null;
    return propStr(props, 'delta') ?? null;
  }
  return null;
}

export const TURN_IDLE_STATUSES: ReadonlySet<string> = new Set(['idle']);

export function statusName(status: unknown): string | undefined {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && typeof (status as { type?: unknown }).type === 'string') {
    return (status as { type: string }).type;
  }
  return undefined;
}

export function isTurnEnd(e: RawEvent, sessionId: string): boolean {
  if (propStr(e.properties, 'sessionID') !== sessionId) return false;
  if (e.type === 'session.idle') return true;
  if (e.type === 'session.status') {
    const name = statusName(e.properties?.status);
    return name !== undefined && TURN_IDLE_STATUSES.has(name);
  }
  return false;
}

export interface PermissionAsk {
  requestID: string;
  permission: string;
  patterns: string[];
}

export function extractPermissionAsk(e: RawEvent, sessionId: string): PermissionAsk | null {
  if (e.type !== 'permission.asked') return null;
  if (propStr(e.properties, 'sessionID') !== sessionId) return null;
  const id = propStr(e.properties, 'id');
  if (!id) return null;
  const patterns = Array.isArray(e.properties?.patterns)
    ? (e.properties.patterns as unknown[]).filter((pattern): pattern is string => typeof pattern === 'string')
    : [];
  return { requestID: id, permission: propStr(e.properties, 'permission') ?? 'tool', patterns };
}

export function isSessionError(e: RawEvent, sessionId: string): boolean {
  return e.type === 'session.error' && propStr(e.properties, 'sessionID') === sessionId;
}

/** Outcome of a per-event handler within {@link runTurn}. */
export type TurnEventAction = 'pass' | 'continue' | 'break';

export interface RunTurnHandlers {
  /**
   * Checked at the top of every iteration, before the pending event is
   * inspected. Return true to end the turn WITHOUT processing that event. Only
   * the streaming path supplies this (to enforce the render-timeout deadline);
   * the non-streaming path omits it and therefore never times out.
   */
  shouldStop?: () => boolean;
  /** Invoked for each text delta belonging to this turn's session. */
  onDelta: (delta: string) => void;
  /**
   * Invoked for every NON-delta event, before the shared turn-end check. Only
   * the streaming path supplies this — it is where the permission policy is
   * applied, interactive questions are rejected, and session errors end the
   * turn. The non-streaming path omits it entirely and so is provably a pure
   * text accumulator that applies no policy of any kind.
   *
   * Return 'continue' to advance to the next event, 'break' to end the turn, or
   * 'pass' to fall through to the shared turn-end check.
   */
  onNonDelta?: (raw: RawEvent) => Promise<TurnEventAction> | TurnEventAction;
}

/**
 * Shared turn-execution skeleton for both OpenAI-compatible endpoints. It owns
 * ONLY the logic both paths perform identically and in the same relative order:
 * reasoning-part bookkeeping, text-delta extraction, and the turn-end check.
 * Everything security-relevant (permission policy, question rejection, session
 * errors, render timeout) is injected via {@link RunTurnHandlers}, so the
 * non-streaming caller — which supplies none of those handlers — cannot apply
 * any of it.
 *
 * Note on ordering: the streaming path historically checked session errors
 * AFTER the turn-end check. Folding that check into {@link
 * RunTurnHandlers.onNonDelta} (which runs BEFORE the turn-end check) is
 * behavior-identical because permission, question, and session-error events are
 * disjoint from both delta events and turn-end events — no single event is ever
 * matched by two of these predicates.
 */
export async function runTurn(events: AsyncIterable<Record<string, unknown>>, sessionId: string, handlers: RunTurnHandlers): Promise<void> {
  const reasoningPartIds = new Set<string>();
  for await (const event of events) {
    if (handlers.shouldStop?.()) break;
    const raw = asRaw(event);
    const snapshot = partSnapshotType(raw);
    if (snapshot?.type === 'reasoning') reasoningPartIds.add(snapshot.partID);
    const delta = extractTextDelta(raw, sessionId, reasoningPartIds);
    if (delta) {
      handlers.onDelta(delta);
      continue;
    }
    if (handlers.onNonDelta) {
      const action = await handlers.onNonDelta(raw);
      if (action === 'break') break;
      if (action === 'continue') continue;
    }
    if (isTurnEnd(raw, sessionId)) break;
  }
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
}

export interface QuestionAsk {
  requestID: string;
  questions: QuestionInfo[];
}

export function extractQuestionAsk(e: RawEvent, sessionId: string): QuestionAsk | null {
  if (e.type !== 'question.asked') return null;
  if (propStr(e.properties, 'sessionID') !== sessionId) return null;
  const id = propStr(e.properties, 'id');
  if (!id) return null;
  const rawQuestions = Array.isArray(e.properties?.questions) ? (e.properties.questions as unknown[]) : [];
  const questions: QuestionInfo[] = [];
  for (const rawQuestion of rawQuestions) {
    const questionData = rawQuestion as { question?: unknown; header?: unknown; options?: unknown };
    const question = typeof questionData.question === 'string' ? questionData.question : '';
    const header = typeof questionData.header === 'string' ? questionData.header : '';
    const options: QuestionOption[] = Array.isArray(questionData.options)
      ? (questionData.options as unknown[])
          .map((option) => option as { label?: unknown; description?: unknown })
          .filter((option) => typeof option.label === 'string')
          .map((option) => ({ label: option.label as string, description: typeof option.description === 'string' ? option.description : '' }))
      : [];
    questions.push({ question, header, options });
  }
  if (questions.length === 0) return null;
  return { requestID: id, questions };
}
