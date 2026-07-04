# Community Portals

OpenPalm's current ingress model is guardian `/oc/*` traffic authenticated with a principal id and shared secret file. First-party adapters are baked into the shared `portal` image.

For custom community integrations, the deployment model remains compose-first: create a compose overlay, include it in your file set, and let guardian handle authenticated `/oc/*` traffic.

## Quick start

1. Build a small Bun service that accepts the external protocol you care about.
2. Read `PRINCIPAL_ID` and `PRINCIPAL_SECRET_FILE` from the environment.
3. Call guardian `/oc/*` using Basic auth plus `x-openpalm-user`.
4. Write a custom runtime service in `~/.openpalm/config/stack/custom.compose.yml`, or use one of the first-party portal services in `portals.compose.yml`.
5. Rerun the OpenPalm compose command.

Example overlay:

```yaml
services:
  my-portal:
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/portal:${OP_PORTAL_IMAGE_TAG:-${OP_IMAGE_TAG:-latest}}
    restart: unless-stopped
    environment:
      PORT: '8187'
      PRINCIPAL_ID: my-portal
      PRINCIPAL_SECRET_FILE: /run/secrets/portal_my_portal_secret
    secrets:
      - portal_my_portal_secret
    networks: [portal_net]

secrets:
  portal_my_portal_secret:
    file: ${OP_HOME}/knowledge/secrets/portal_my_portal_secret
```

> First-party portal adapters are baked into the portal image. Custom community
> integrations should ship as normal containers or compose overlays, not as
> runtime-installed npm packages.

## What your integration needs

- `Bun.serve()` startup with `/health`
- Basic-auth calls to guardian `/oc/*`
- structured logging
- tests that exercise the guardian-facing contract

## Runtime variables

| Variable | Purpose |
|---|---|
| `PORT` | Listen port inside the container |
| `PRINCIPAL_ID` | Guardian principal id |
| `PRINCIPAL_SECRET_FILE` | Path to the shared secret file used for Basic auth |

## Testing

Test the same things the first-party adapters test: health responses, permission
policy, Basic-auth `/oc/*` calls, and session/stream behavior.

## Built-in examples

- `packages/guardian/src/openai-api.ts` (guardian-hosted OpenAI-compatible API)
- `portals/discord/README.md`
- `portals/slack/README.md`

## Related addons

- The voice addon serves a static browser UI and is not a guardian-fronted portal.
