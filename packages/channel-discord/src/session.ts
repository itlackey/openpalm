export type InteractionSessionContext = {
  channelId: string;
  userId: string;
  threadId?: string | null;
};

type SessionTask = {
  run: () => Promise<void>;
  onQueued?: () => Promise<void>;
};

type SessionState = {
  processing: boolean;
  queue: SessionTask[];
};

export function buildThreadSessionKey(threadId: string): string {
  return `discord:thread:${threadId}`;
}

export function buildChannelUserSessionKey(channelId: string, userId: string): string {
  return `discord:channel:${channelId}:user:${userId}`;
}

export function resolveInteractionSessionKey(context: InteractionSessionContext): string {
  if (context.threadId?.trim()) {
    return buildThreadSessionKey(context.threadId);
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
      await this.notifyQueued(task);
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
    while (true) {
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
      }

      if (state.queue.length === 0) {
        this.states.delete(sessionKey);
        return;
      }
    }
  }

  private async notifyQueued(task: SessionTask): Promise<void> {
    try {
      await task.onQueued?.();
    } catch {
      // best-effort notification; task stays queued
    }
  }
}
