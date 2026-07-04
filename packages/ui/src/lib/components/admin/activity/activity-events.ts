/**
 * Pure event-processing mappers for the operator Activity view.
 *
 * These functions turn raw OpenCode SSE payloads into the view models the
 * Activity tab renders (attention items, feed items, tool-strip entries).
 * They are intentionally free of Svelte state, timers, and side effects so the
 * severity/classification rules can be unit-tested in isolation. `ActivityTab`
 * owns the subscription, buffers, metrics, and rendering; it stamps the `id`
 * and `timestamp` onto the items these mappers produce.
 */
import type { ToolStripEntry } from '$lib/chat/tool-strip.js';
import {
  extractStepUpdate,
  extractToolUpdate,
  type RawEvent,
} from '$lib/chat/oc-events.js';
import type { OpenCodeSessionEventPayload } from '$lib/chat/session-events.js';

export type AttentionSeverity = 'high' | 'medium' | 'low';
export type AttentionKind = 'permission' | 'question' | 'error' | 'info';

export type AttentionItem = {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  sessionId: string;
  timestamp: number;
};

export type FeedItem = {
  id: string;
  type: string;
  sessionId: string;
  title: string;
  detail: string;
  toolState?: ToolStripEntry;
  timestamp: number;
};

/** Nested session descriptor carried on `properties.info`. */
export type ActivitySessionInfo = {
  id?: string;
  title?: string;
  time?: { created?: number; updated?: number };
};

/** Tool/step descriptor carried on `properties.part` for `message.part.updated`. */
export type ActivityMessagePart = {
  type?: string;
  tool?: string;
  state?: { status?: string; error?: string };
};

/**
 * DTO for the loosely-typed `properties` bag on an OpenCode session event.
 * Replaces the ad-hoc `as Record<string, unknown>` / `as { ... }` casts that
 * were scattered through `ActivityTab`. Unknown keys remain accessible via the
 * index signature; the named fields document the shapes these mappers read.
 */
export type ActivityEventProperties = {
  sessionID?: unknown;
  info?: ActivitySessionInfo;
  permission?: unknown;
  questions?: unknown;
  error?: unknown;
  tool?: unknown;
  progress?: unknown;
  message?: unknown;
  part?: ActivityMessagePart;
  [key: string]: unknown;
};

function eventProps(payload: OpenCodeSessionEventPayload): ActivityEventProperties | undefined {
  return payload.properties as ActivityEventProperties | undefined;
}

export function eventSessionId(payload: OpenCodeSessionEventPayload): string {
  const props = eventProps(payload);
  if (typeof props?.sessionID === 'string') return props.sessionID;
  const info = props?.info;
  return typeof info?.id === 'string' ? info.id : '';
}

function truncate(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function toRawEvent(payload: OpenCodeSessionEventPayload): RawEvent {
  return {
    type: payload.type,
    properties: (payload.properties ?? {}) as Record<string, unknown>,
  };
}

export function toToolStripEntry(payload: OpenCodeSessionEventPayload): ToolStripEntry | null {
  const sessionId = eventSessionId(payload);
  if (!sessionId) return null;

  const raw = toRawEvent(payload);
  const toolUpdate = extractToolUpdate(raw, sessionId);
  if (toolUpdate) {
    return {
      id: toolUpdate.callID || `${toolUpdate.tool}:${Date.now()}`,
      kind: 'tool',
      tool: toolUpdate.tool,
      status: toolUpdate.status,
      title: toolUpdate.title ?? toolUpdate.tool,
      detail: toolUpdate.detail ?? '',
      output: toolUpdate.output ?? '',
      error: toolUpdate.error ?? '',
      updatedAt: Date.now(),
    };
  }

  const stepUpdate = extractStepUpdate(raw, sessionId);
  if (stepUpdate) {
    return {
      id: stepUpdate.id,
      kind: 'step',
      tool: 'step',
      status: stepUpdate.status,
      title: stepUpdate.title,
      detail: stepUpdate.detail ?? '',
      output: '',
      error: '',
      updatedAt: Date.now(),
    };
  }

  return null;
}

export function summarizeEvent(
  payload: OpenCodeSessionEventPayload,
): Omit<AttentionItem, 'id' | 'timestamp'> | null {
  const props = eventProps(payload);
  const sessionId = eventSessionId(payload);
  const type = payload.type;

  if (type === 'permission.asked') {
    return {
      kind: 'permission',
      severity: 'high',
      title: 'Approval needed',
      detail:
        typeof props?.permission === 'string'
          ? props.permission
          : 'Assistant is waiting for a permission decision.',
      sessionId,
    };
  }

  if (type === 'question.asked') {
    return {
      kind: 'question',
      severity: 'high',
      title: 'Answer requested',
      detail: Array.isArray(props?.questions)
        ? `${props.questions.length} question${props.questions.length === 1 ? '' : 's'} waiting for an answer.`
        : 'Assistant asked a question.',
      sessionId,
    };
  }

  if (type === 'session.error') {
    return {
      kind: 'error',
      severity: 'high',
      title: 'Session error',
      detail: typeof props?.error === 'string' ? props.error : 'Assistant session reported an error.',
      sessionId,
    };
  }

  if (type === 'session.deleted') {
    return {
      kind: 'info',
      severity: 'medium',
      title: 'Session removed',
      detail: 'An active session was deleted.',
      sessionId,
    };
  }

  if (type === 'session.created') {
    return {
      kind: 'info',
      severity: 'low',
      title: 'New session started',
      detail: 'A new conversation became active.',
      sessionId,
    };
  }

  if (type.startsWith('session.next.tool.')) {
    const toolName = typeof props?.tool === 'string' ? props.tool : 'tool';
    const progress =
      typeof props?.progress === 'string'
        ? props.progress
        : typeof props?.message === 'string'
          ? props.message
          : '';
    if (type.endsWith('.failed')) {
      return {
        kind: 'error',
        severity: 'high',
        title: `Tool failed: ${toolName}`,
        detail: truncate(progress || 'Assistant tool execution failed.'),
        sessionId,
      };
    }
    if (type.endsWith('.called')) {
      return {
        kind: 'info',
        severity: 'medium',
        title: `Tool running: ${toolName}`,
        detail: truncate(progress || 'Assistant started a tool.'),
        sessionId,
      };
    }
    if (type.endsWith('.completed')) {
      return {
        kind: 'info',
        severity: 'low',
        title: `Tool finished: ${toolName}`,
        detail: 'Assistant completed a tool call.',
        sessionId,
      };
    }
  }

  if (type === 'message.part.updated') {
    const part = props?.part;
    if (typeof part?.tool === 'string' && part.state?.status === 'error') {
      return {
        kind: 'error',
        severity: 'high',
        title: `Tool failed: ${part.tool}`,
        detail: typeof part.state.error === 'string' ? truncate(part.state.error) : 'Assistant tool execution failed.',
        sessionId,
      };
    }
  }

  return null;
}

export function eventTitle(payload: OpenCodeSessionEventPayload): string {
  const props = eventProps(payload);
  const info = props?.info;
  if (typeof info?.title === 'string' && info.title.trim()) return info.title;

  const summary = summarizeEvent(payload);
  if (summary?.title) return summary.title;

  const sessionId = eventSessionId(payload);
  return sessionId ? `Session ${sessionId.slice(0, 8)}` : 'Assistant event';
}

export function eventDetail(payload: OpenCodeSessionEventPayload): string {
  const props = eventProps(payload);
  const summary = summarizeEvent(payload);
  if (summary?.detail) return summary.detail;
  if (!props) return '';

  if (payload.type.startsWith('session.next.tool.')) {
    const tool = typeof props.tool === 'string' ? props.tool : 'tool';
    const progress =
      typeof props.progress === 'string'
        ? props.progress
        : typeof props.message === 'string'
          ? props.message
          : '';
    return truncate(progress ? `${tool}: ${progress}` : tool);
  }

  if (payload.type === 'message.part.updated') {
    const part = props.part;
    if (typeof part?.tool === 'string') {
      const status = typeof part.state?.status === 'string' ? part.state.status : 'updated';
      return `${part.tool} ${status}`;
    }
    if (typeof part?.type === 'string') return part.type;
  }

  if (payload.type === 'session.updated') return 'Session metadata changed.';
  return '';
}
