import { beforeEach, describe, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('$lib/connections/boot.js', () => ({ getTransport: () => transport }));

import { deleteSession, getAssistantModel, renameSession } from './chat.js';

beforeEach(() => {
  transport.request.mockReset();
  transport.request.mockResolvedValue(new Response('true', { status: 200 }));
});

describe('chat session mutations', () => {
  test('renames a session through the native PATCH endpoint', async () => {
    await renameSession('session/with spaces', 'Quarterly planning');

    expect(transport.request).toHaveBeenCalledWith(
      'PATCH',
      '/session/session%2Fwith%20spaces',
      { title: 'Quarterly planning' },
    );
  });

  test('deletes a session through the native DELETE endpoint without a body', async () => {
    await deleteSession('session/with spaces');

    expect(transport.request).toHaveBeenCalledWith(
      'DELETE',
      '/session/session%2Fwith%20spaces',
    );
  });
});

// F10: the chat page's first-run empty state reads the active connection's
// configured model straight off OpenCode's own /config, not an admin route.
describe('getAssistantModel', () => {
  test('reads the configured model off /config', async () => {
    transport.request.mockResolvedValueOnce(
      new Response(JSON.stringify({ model: 'anthropic/claude-sonnet-4-5' }), { status: 200 }),
    );

    await expect(getAssistantModel()).resolves.toBe('anthropic/claude-sonnet-4-5');
    expect(transport.request).toHaveBeenCalledWith('GET', '/config');
  });

  test('returns an empty string when nothing is configured yet', async () => {
    transport.request.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await expect(getAssistantModel()).resolves.toBe('');
  });
});
