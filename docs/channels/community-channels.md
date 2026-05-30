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
3. Write a custom runtime service in `~/.openpalm/config/stack/custom.compose.yml`, or add a first-party channel service to `channels.compose.yml`.
4. For first-party channel services, add the addon name to `~/.openpalm/config/stack/stack.yml` through the CLI or admin UI.
5. Rerun the OpenPalm compose command.

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
      CHANNEL_MY_CHANNEL_SECRET_FILE: /run/secrets/channel_my_channel_hmac
    secrets:
      - channel_my_channel_hmac
    networks: [channel_lan]

secrets:
  channel_my_channel_hmac:
    file: ${OP_HOME}/knowledge/vaults/secrets/channel_my_channel_hmac
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
| `CHANNEL_<NAME>_SECRET_FILE` | Path to the granted Guardian HMAC secret file |
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

- `packages/channel-api/README.md` (also serves the chat addon when run with `CHANNEL_ID=chat`)
- `packages/channel-discord/README.md`
- `packages/channel-slack/README.md`

## Related addons (not channels-sdk channels)

- `packages/channel-voice/README.md` — serves a static voice chat UI directly from the browser; has no guardian pipeline or channels-sdk dependency. It is an addon, not a channel in the SDK sense.
