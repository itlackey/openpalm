import { beforeEach, describe, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('$lib/connections/boot.js', () => ({ getTransport: () => transport }));

import { deleteSession, renameSession } from './chat.js';

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
