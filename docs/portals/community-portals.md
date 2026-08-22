# Community Portals

A community portal is its own container that translates an external protocol to
Guardian's authenticated `/oc/*` API. The first-party `portal` image contains
only the baked first-party adapters; custom integrations must publish their own
image.

## Contract

Your adapter must:

- expose a health endpoint
- read its principal token from a file, never an inline environment value
- call `http://guardian:8080/oc/*` with HTTP Basic credentials
- send `x-openpalm-user` for the external user identity
- join `portal_net`, not `assistant_net`

Guardian must know the same principal before traffic arrives. The simplest
Compose-first path is to grant the same named secret to Guardian through a
`PORTAL_<ID>_SECRET_FILE` variable. Guardian seeds that principal at boot.

## Example

Create `~/.openpalm/state/secrets/portal_community_secret` with mode `0600`,
then add this to `~/.openpalm/config/stack/custom.compose.yml`:

```yaml
services:
  guardian:
    environment:
      PORTAL_COMMUNITY_SECRET_FILE: /run/secrets/portal_community_secret
    secrets:
      - portal_community_secret

  community-portal:
    image: ghcr.io/example/community-portal:1.0.0
    restart: unless-stopped
    environment:
      PORT: "8080"
      GUARDIAN_URL: http://guardian:8080
      PRINCIPAL_ID: community
      PRINCIPAL_SECRET_FILE: /run/secrets/portal_community_secret
    secrets:
      - portal_community_secret
    networks: [portal_net]
    depends_on:
      guardian:
        condition: service_healthy

secrets:
  portal_community_secret:
    file: ${OP_HOME}/state/secrets/portal_community_secret
```

Enable the Guardian-only gateway profile and reconcile the stack:

```bash
openpalm addon enable gateway
openpalm start
```

The environment key `PORTAL_COMMUNITY_SECRET_FILE` seeds principal id
`community`, matching `PRINCIPAL_ID`. Use an env-safe uppercase identifier whose
lowercase form is the desired principal id.

## Testing

Exercise health, invalid and valid Basic authentication, user attribution,
session ownership, event streaming, and rate-limit behavior against a real
Guardian. Never test a custom portal by connecting it directly to Assistant.

First-party reference implementations:

- [`packages/portal-discord/README.md`](../../packages/portal-discord/README.md)
- [`packages/portal-slack/README.md`](../../packages/portal-slack/README.md)
- `packages/portal-sdk/`
