import { asRecord } from './http-util.ts';

export function extractChatText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const record = asRecord(messages[index]);
    if (record?.role !== 'user') continue;
    if (typeof record.content === 'string' && record.content.trim()) return record.content;
    if (Array.isArray(record.content)) {
      const parts: string[] = [];
      for (const part of record.content) {
        const textPart = asRecord(part);
        if (textPart?.type === 'text' && typeof textPart.text === 'string' && textPart.text.trim()) parts.push(textPart.text);
      }
      if (parts.length) return parts.join('\n');
    }
  }
  return null;
}
