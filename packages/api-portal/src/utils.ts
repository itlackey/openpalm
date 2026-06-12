export function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

export function extractChatText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const record = asRecord(messages[i]);
    if (!record || record.role !== 'user') continue;
    if (typeof record.content === 'string' && record.content.trim()) return record.content;
    if (Array.isArray(record.content)) {
      const parts: string[] = [];
      for (const part of record.content) {
        const p = asRecord(part);
        if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) parts.push(p.text);
      }
      if (parts.length) return parts.join('\n');
    }
  }
  return null;
}
