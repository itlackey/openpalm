/**
 * Shared utility functions for OpenPalm channel packages.
 */

/**
 * Constant-time string comparison to prevent timing attacks.
 * Used for API key and token validation.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Type guard that narrows an unknown value to a plain object record.
 * Returns null for non-objects, null, and arrays.
 */
export function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * Split a long message into chunks that respect a character limit.
 * Preserves code block boundaries — unclosed blocks are closed at the
 * split point and reopened (with language hint) in the continuation chunk.
 * Prefers splitting at paragraph boundaries (double newline), then single
 * newlines, before falling back to hard splits.
 */
export function splitMessage(content: string, maxLength: number): string[] {
  if (!content) return [];
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = maxLength;
    const beforeSplit = remaining.slice(0, splitIndex);
    const codeBlockStarts = (beforeSplit.match(/```/g) || []).length;
    const inCodeBlock = codeBlockStarts % 2 === 1;

    if (inCodeBlock) {
      const newlineIndex = remaining.lastIndexOf("\n", splitIndex);
      if (newlineIndex > maxLength / 2) splitIndex = newlineIndex;
    } else {
      const doubleNewline = remaining.lastIndexOf("\n\n", splitIndex);
      const singleNewline = remaining.lastIndexOf("\n", splitIndex);
      if (doubleNewline > maxLength / 2) splitIndex = doubleNewline + 2;
      else if (singleNewline > maxLength / 2) splitIndex = singleNewline + 1;
    }

    let chunk = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex);

    // Handle unclosed code blocks
    const chunkCodeBlocks = (chunk.match(/```/g) || []).length;
    if (chunkCodeBlocks % 2 === 1) {
      chunk += "\n```";
      const match = chunk.match(/```(\w+)?/);
      const lang = match?.[1] || "";
      remaining = "```" + lang + "\n" + remaining;
    }

    chunks.push(chunk.trim());
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Extract the last user message text from an OpenAI or Anthropic messages array.
 * Supports both plain string content and content-block arrays.
 */
export function extractChatText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const record = asRecord(messages[i]);
    if (!record || record.role !== "user") continue;
    if (typeof record.content === "string" && record.content.trim()) return record.content;
    if (Array.isArray(record.content)) {
      const parts: string[] = [];
      for (const part of record.content) {
        const p = asRecord(part);
        if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) parts.push(p.text);
      }
      if (parts.length) return parts.join("\n");
    }
  }
  return null;
}
