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
