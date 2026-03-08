/**
 * Utility functions for the memory package.
 */
import { createHash, randomUUID } from 'node:crypto';

/** Generate a new UUID v4. */
export function generateId(): string {
  return randomUUID();
}

/** MD5 hash a string (used for change detection). */
export function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

/**
 * Try to parse a JSON string, returning null on failure.
 * Strips markdown code fences if present.
 */
export function safeJsonParse<T = unknown>(text: string): T | null {
  try {
    const cleaned = removeCodeBlocks(text);
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/** Remove markdown code fences from a string. */
export function removeCodeBlocks(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/gm, '')
    .replace(/\n?```\s*$/gm, '')
    .trim();
}

/** Join message contents into a single string. */
export function parseMessages(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}
