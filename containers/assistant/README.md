# Assistant image

The active image is built from `Dockerfile.lean`.

It contains only:

- OpenCode;
- AKM CLI;
- the image-baked `akm-opencode` plugin;
- supercronic; and
- minimal runtime utilities.

The entrypoint validates its managed configuration and file-backed OpenCode
password, synchronizes user task sources, starts supercronic, and starts the
native OpenCode server. It performs no package installation or network download.

Assistant runs as the configured non-root operator identity, drops all
capabilities, and receives no Docker socket, Admin credential, Guardian token,
or portal token. Its authenticated host port defaults to loopback; StackConfig
may deliberately bind it to another exact host address for direct native
OpenCode clients.

Persistent mounts are the Assistant home, operator OpenCode/AKM configuration,
knowledge, AKM state, and workspace. Managed configuration is read-only.
Provider `auth.json` is intentionally Assistant-readable; delegated ingress
credentials are not.

Managed Guardian sessions select one of three Assistant profiles: tool-disabled
`remote`, read-only `remote-read`, or permission-inheriting `remote-full`.

The old `Dockerfile`, `Dockerfile.models`, and `entrypoint.sh` are inactive
legacy files pending deletion approval.
