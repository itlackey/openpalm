export type RawEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

function propStr(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function partSnapshotType(event: RawEvent): { partID: string; type: string } | null {
  if (event.type !== 'message.part.updated') return null;
  const part = event.properties?.part as { id?: unknown; type?: unknown } | undefined;
  if (typeof part?.id === 'string' && typeof part.type === 'string') {
    return { partID: part.id, type: part.type };
  }
  return null;
}

export function extractTextDelta(
  event: RawEvent,
  sessionId: string,
  reasoningPartIds?: ReadonlySet<string>
): string | null {
  const props = event.properties ?? {};
  if (propStr(props, 'sessionID') !== sessionId) return null;

  if (event.type === 'session.next.text.delta') {
    return propStr(props, 'delta') ?? propStr(props, 'text') ?? null;
  }

  if (event.type === 'message.part.delta') {
    const field = propStr(props, 'field');
    if (field && field !== 'text') return null;
    const partID = propStr(props, 'partID');
    if (partID && reasoningPartIds?.has(partID)) return null;
    return propStr(props, 'delta') ?? null;
  }

  return null;
}

function statusName(status: unknown): string | undefined {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && typeof (status as { type?: unknown }).type === 'string') {
    return (status as { type: string }).type;
  }
  return undefined;
}

export function isTurnEnd(event: RawEvent, sessionId: string): boolean {
  const props = event.properties ?? {};
  if (propStr(props, 'sessionID') !== sessionId) return false;
  if (event.type === 'session.idle') return true;
  if (event.type === 'session.status') {
    const name = statusName(props.status);
    return name === 'idle' || name === 'completed' || name === 'done';
  }
  return false;
}

export type ToolUpdate = {
  callID: string;
  tool: string;
  status: string;
  title?: string;
  detail?: string;
  output?: string;
  error?: string;
};

export type PermissionAsk = {
  requestID: string;
  permission: string;
  patterns: string[];
  always: string[];
  tool: string;
  detail: string;
};

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
};

export type QuestionAsk = {
  requestID: string;
  questions: QuestionInfo[];
};

export type StepUpdate = {
  id: string;
  title: string;
  status: 'running' | 'completed';
  detail?: string;
};

function valueToText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value == null) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = valueToText(value);
    if (text) return text;
  }
  return undefined;
}

export function extractToolUpdate(event: RawEvent, sessionId: string): ToolUpdate | null {
  const props = event.properties ?? {};
  if (propStr(props, 'sessionID') !== sessionId) return null;

  const part = (props.part ?? props.tool) as Record<string, unknown> | undefined;
  if (event.type === 'message.part.updated' && part && (part.type === 'tool' || part.state)) {
    const state = (part.state ?? {}) as Record<string, unknown>;
    return {
      callID: String(part.callID ?? part.id ?? ''),
      tool: String(part.tool ?? 'tool'),
      status: String(state.status ?? 'running'),
      title: typeof state.title === 'string' ? state.title : undefined,
      detail: firstText(state.input, state.metadata, state.progress, state.output),
      output: valueToText(state.output),
      error: typeof state.error === 'string' ? state.error : undefined,
    };
  }

  if (event.type.startsWith('session.next.tool.')) {
    const type = event.type.replace('session.next.tool.', '');
    return {
      callID: propStr(props, 'callID') ?? '',
      tool: propStr(props, 'tool') ?? 'tool',
      status:
        type === 'completed'
          ? 'completed'
          : type === 'failed'
            ? 'error'
            : type === 'called'
              ? 'running'
              : (propStr(props, 'status') ?? 'running'),
      title: propStr(props, 'title') ?? propStr(props, 'tool'),
      detail: firstText(props.message, props.delta, props.progress, props.input, props.metadata),
      output: firstText(props.output, props.result),
      error: firstText(props.error),
    };
  }

  return null;
}

export function isSessionError(event: RawEvent, sessionId: string): boolean {
  return event.type === 'session.error' && propStr(event.properties, 'sessionID') === sessionId;
}

/**
 * Read the assistant-supplied detail off a `session.error` event for this
 * session, if any. This is exactly the event an invalid/revoked/quota-exhausted
 * provider API key produces at first-message time — the request that started
 * the turn already returned 200, and the provider only rejects once OpenCode
 * dials out, so the failure only ever surfaces here, not as an HTTP status.
 *
 * `properties.error` isn't guaranteed to be one shape: the guardian's own
 * upstream-reset synthetic frames send `{name, message}` (event-fanout.ts),
 * while OpenCode's own errors aren't contractually documented — so every
 * reasonable field is tried before giving up and letting the caller fall back
 * to its own generic copy.
 */
export function extractSessionErrorDetail(event: RawEvent, sessionId: string): string | undefined {
  if (!isSessionError(event, sessionId)) return undefined;
  const error = event.properties?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const rec = error as Record<string, unknown>;
    const data = rec.data as Record<string, unknown> | undefined;
    return firstText(rec.message, data?.message, rec.name);
  }
  return undefined;
}

export function extractPermissionAsk(event: RawEvent, sessionId: string): PermissionAsk | null {
  if (event.type !== 'permission.asked') return null;
  if (propStr(event.properties, 'sessionID') !== sessionId) return null;
  const id = propStr(event.properties, 'id');
  if (!id) return null;
  const patterns = Array.isArray(event.properties?.patterns)
    ? (event.properties.patterns as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const always = Array.isArray(event.properties?.always)
    ? (event.properties.always as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const toolRecord = event.properties?.tool as Record<string, unknown> | undefined;
  return {
    requestID: id,
    permission: propStr(event.properties, 'permission') ?? 'tool',
    patterns,
    always,
    tool: propStr(toolRecord, 'callID') ?? propStr(event.properties, 'permission') ?? 'tool',
    detail: firstText(event.properties?.metadata, event.properties?.message) ?? '',
  };
}

export function extractQuestionAsk(event: RawEvent, sessionId: string): QuestionAsk | null {
  if (event.type !== 'question.asked') return null;
  if (propStr(event.properties, 'sessionID') !== sessionId) return null;
  const id = propStr(event.properties, 'id');
  if (!id) return null;
  const rawQuestions = Array.isArray(event.properties?.questions) ? event.properties.questions : [];
  const questions: QuestionInfo[] = [];
  for (const raw of rawQuestions) {
    const item = raw as { question?: unknown; header?: unknown; options?: unknown };
    const options = Array.isArray(item.options)
      ? item.options
          .map((option) => option as { label?: unknown; description?: unknown })
          .filter((option) => typeof option.label === 'string')
          .map((option) => ({
            label: option.label as string,
            description: typeof option.description === 'string' ? option.description : '',
          }))
      : [];
    questions.push({
      question: typeof item.question === 'string' ? item.question : '',
      header: typeof item.header === 'string' ? item.header : '',
      options,
    });
  }
  if (questions.length === 0) return null;
  return { requestID: id, questions };
}

export function extractStepUpdate(event: RawEvent, sessionId: string): StepUpdate | null {
  const props = event.properties ?? {};
  if (propStr(props, 'sessionID') !== sessionId) return null;
  if (event.type !== 'session.next.step.started' && event.type !== 'session.next.step.ended') return null;
  const id = propStr(props, 'stepID') ?? propStr(props, 'id') ?? event.type;
  const title =
    propStr(props, 'title') ??
    propStr(props, 'step') ??
    (event.type === 'session.next.step.started' ? 'Working' : 'Step complete');
  return {
    id,
    title,
    status: event.type === 'session.next.step.ended' ? 'completed' : 'running',
    detail: firstText(props.detail, props.message),
  };
}
