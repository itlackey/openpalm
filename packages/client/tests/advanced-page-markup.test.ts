import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ADVANCED_PATH = fileURLToPath(new URL('../src/routes/advanced/+page.svelte', import.meta.url));
const CHAT_PATH = fileURLToPath(new URL('../src/routes/chat/+page.svelte', import.meta.url));

describe('static-client Advanced mode wiring', () => {
  test('renders either a raw OpenCode iframe or an explicit unavailable state', () => {
    const source = readFileSync(ADVANCED_PATH, 'utf8');
    expect(source).toContain('resolveAdvancedTarget');
    expect(source).toMatch(/title="OpenCode — Advanced Chat"/);
    expect(source).toContain('Advanced mode unavailable');
    expect(source).toContain('Back to chat');
    expect(source).not.toContain('$effect');
  });

  test('chat restores the requested session after its controller transport initializes', () => {
    const source = readFileSync(CHAT_PATH, 'utf8');
    expect(source).toContain('requestedSessionId');
    expect(source).toMatch(/await controller\.init\(\)[\s\S]*controller\.selectSession\(requestedSessionId\)/);
    expect(source).not.toContain('$effect');
  });

  test('Chat and Advanced require an explicitly active connection', () => {
    const advanced = readFileSync(ADVANCED_PATH, 'utf8');
    const chat = readFileSync(CHAT_PATH, 'utf8');
    expect(advanced).toContain('await store.getActive()');
    expect(chat).toContain('await store.getActive()');
    expect(advanced).not.toMatch(/store\.list\(\)\)\[0\]/);
    expect(chat).not.toMatch(/store\.list\(\)\)\[0\]/);
  });
});
