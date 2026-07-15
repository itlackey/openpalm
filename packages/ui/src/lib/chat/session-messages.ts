import type { ChatEntry, ChatMessage, ChatToolGroup, ToolStripEntry } from '$lib/types.js';
import { toolStripEntryFromSessionPart, type SessionMessagePart } from '$lib/chat/tool-strip.js';

/** A raw OpenCode message row as returned by
 *  `GET /session/:id/message` on the active connection. */
export type SessionMessageRow = {
  info: {
    id: string;
    role: 'user' | 'assistant';
    time?: { created?: number };
  };
  parts: SessionMessagePart[];
};

/**
 * Flatten raw OpenCode session-message rows into UI `ChatEntry`s.
 *
 * Tool parts are grouped into the assistant turn that follows them (attached
 * as `toolStates` on the `ChatMessage`). If tool parts appear with no
 * following assistant text in the same OpenCode message they are emitted as a
 * single `ChatToolGroup` entry — never as N separate entries.
 *
 * Skips non-text, non-tool parts (files, reasoning, etc.). Empty-text
 * messages with no tool activity are dropped.
 *
 * Pure domain transformation (no transport) — kept next to `tool-strip.ts` so
 * the chat api client can call it and it can be unit-tested in isolation.
 */
export function flattenSessionMessages(rows: SessionMessageRow[]): ChatEntry[] {
  const messages: ChatEntry[] = [];
  for (const row of rows) {
    const timestamp = row.info.time?.created ?? Date.now();
    let textBuffer = '';
    let textIndex = 0;
    const pendingToolStates: ToolStripEntry[] = [];

    const flushText = (): void => {
      const text = textBuffer.trim();
      textBuffer = '';
      if (!text && pendingToolStates.length === 0) return;

      if (text) {
        const entry: ChatMessage = {
          id: textIndex === 0 ? row.info.id : `${row.info.id}:text:${textIndex}`,
          role: row.info.role,
          text,
          timestamp,
        };
        if (pendingToolStates.length > 0) {
          entry.toolStates = [...pendingToolStates];
          pendingToolStates.length = 0;
        }
        messages.push(entry);
        textIndex += 1;
      } else if (pendingToolStates.length > 0) {
        // Tools with no following text in this message — emit as orphan group.
        const group: ChatToolGroup = {
          id: `${row.info.id}:tools:${textIndex}`,
          type: 'tool-group',
          toolStates: [...pendingToolStates],
          timestamp,
        };
        pendingToolStates.length = 0;
        messages.push(group);
        textIndex += 1;
      }
    };

    row.parts.forEach((part, index) => {
      if (part.type === 'text' && part.text) {
        textBuffer += part.text;
        return;
      }
      if (part.type === 'tool' || part.state) {
        const toolState = toolStripEntryFromSessionPart(part, `${row.info.id}:${index}`);
        if (!toolState) return;
        pendingToolStates.push(toolState);
      }
    });

    flushText();
  }
  return messages;
}
