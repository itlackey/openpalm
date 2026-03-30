# Community Channels

OpenPalm's channel SDK (`@openpalm/channels-sdk`) lets you ship custom channel adapters that run behind guardian in the shared `channel` image.
The deployment model is compose-first: create a compose overlay, include it in your file set, and let guardian handle signed forwarding.

## Quick start

1. Write a class that extends `BaseChannel`:

```ts
import { BaseChannel, type HandleResult } from '@openpalm/channels-sdk';

export default class MyChannel extends BaseChannel {
  name = 'my-channel';

  async handleRequest(req: Request): Promise<HandleResult | null> {
    const body = await req.json() as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    if (!userId || !text) return null;
    return { userId, text };
  }
}
```

2. Publish it as an npm package, or mount a local file and use `CHANNEL_FILE`.
3. Create a catalog entry under `~/.openpalm/registry/addons/<name>/`, or write a custom runtime overlay directly in `~/.openpalm/stack/addons/<name>/compose.yml`.
4. If you use the registry path, copy the addon into `~/.openpalm/stack/addons/<name>/` to enable it.
5. Include that overlay in your `docker compose -f ... up -d` command.

Example overlay:

```yaml
services:
  my-channel:
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/channel:${OP_IMAGE_TAG:-latest}
    restart: unless-stopped
    environment:
      PORT: '8187'
      GUARDIAN_URL: http://guardian:8080
      CHANNEL_PACKAGE: '@your-scope/openpalm-channel-my-channel'
    env_file:
      - ${OP_HOME}/vault/stack/stack.env
      - ${OP_HOME}/vault/stack/guardian.env
      - ${OP_HOME}/vault/user/user.env
    networks: [channel_lan]
```

## What the SDK gives you

- `Bun.serve()` startup with `/health`
- HMAC signing and guardian forwarding helpers
- Structured logging
- Optional request routing override
- `createFetch()` for tests without starting a real server

You implement `handleRequest(req)` and return `{ userId, text }` or `null`.

## Runtime variables

| Variable | Purpose |
|---|---|
| `PORT` | Listen port inside the container |
| `GUARDIAN_URL` | Guardian forwarding target |
| `CHANNEL_<NAME>_SECRET` | Guardian HMAC secret |
| `CHANNEL_PACKAGE` | npm package to import |
| `CHANNEL_FILE` | Local module path when not using a package |

## Testing

```ts
import { expect, mock, test } from 'bun:test';
import MyChannel from './my-channel.ts';

test('handles a simple request', async () => {
  const channel = new MyChannel();
  const handler = channel.createFetch(mock());

  const response = await handler(new Request('http://localhost/', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', text: 'hello' }),
  }));

  expect(response.status).toBe(200);
});
```

See `packages/channels-sdk/src/channel-base.test.ts` for fuller examples.

## Built-in examples

- `packages/channel-chat/README.md`
- `packages/channel-api/README.md`
- `packages/channel-discord/README.md`
- `packages/channel-slack/README.md`
- `packages/channel-voice/README.md`
