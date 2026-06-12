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
