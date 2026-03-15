type SessionTask = {
  run: () => Promise<void>;
  onQueued?: () => Promise<void>;
};

type SessionState = {
  processing: boolean;
  queue: SessionTask[];
};

export function buildThreadSessionKey(channelId: string, threadTs: string): string {
  return `slack:thread:${channelId}:${threadTs}`;
}

export function buildDMSessionKey(userId: string): string {
  return `slack:dm:${userId}`;
}

export function buildChannelUserSessionKey(channelId: string, userId: string): string {
  return `slack:channel:${channelId}:user:${userId}`;
}

export function resolveSessionKey(context: {
  channelId: string;
  userId: string;
  threadTs?: string;
  isDM: boolean;
}): string {
  if (context.threadTs) {
    return buildThreadSessionKey(context.channelId, context.threadTs);
  }
  if (context.isDM) {
    return buildDMSessionKey(context.userId);
  }
  return buildChannelUserSessionKey(context.channelId, context.userId);
}

export class ConversationQueue {
  private states = new Map<string, SessionState>();

  isProcessing(sessionKey: string): boolean {
    return this.states.get(sessionKey)?.processing ?? false;
  }

  queuedCount(sessionKey: string): number {
    return this.states.get(sessionKey)?.queue.length ?? 0;
  }

  clear(sessionKey: string): number {
    const state = this.states.get(sessionKey);
    if (!state) return 0;

    const dropped = state.queue.length;
    state.queue.length = 0;

    if (!state.processing) {
      this.states.delete(sessionKey);
    }

    return dropped;
  }

  async runOrQueue(sessionKey: string, task: SessionTask): Promise<"started" | "queued"> {
    const state = this.states.get(sessionKey) ?? { processing: false, queue: [] };
    this.states.set(sessionKey, state);

    if (state.processing) {
      state.queue.push(task);
      try {
        await task.onQueued?.();
      } catch {
        // best-effort notification; task stays queued
      }
      return "queued";
    }

    state.processing = true;
    try {
      await task.run();
    } finally {
      state.processing = false;
      if (state.queue.length > 0) {
        void this.drain(sessionKey);
      } else {
        this.states.delete(sessionKey);
      }
    }

    return "started";
  }

  private async drain(sessionKey: string): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state || state.processing) return;

    const next = state.queue.shift();
    if (!next) {
      this.states.delete(sessionKey);
      return;
    }

    state.processing = true;
    try {
      await next.run();
    } catch {
      // errors are handled by the task itself; continue draining
    } finally {
      state.processing = false;
      if (state.queue.length > 0) {
        void this.drain(sessionKey);
      } else {
        this.states.delete(sessionKey);
      }
    }
  }
}
