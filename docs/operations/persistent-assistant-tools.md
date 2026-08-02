# Persisting Assistant-Installed Tools

The assistant container's writable layer is discarded on container recreation.
OpenPalm provides two persistent install locations; system packages require a
custom image.

## Assistant Home

`${OP_HOME}/data/assistant` is mounted at `/home/opencode`. The following paths
survive image updates and recreates:

- `$HOME/.local/bin`
- `$HOME/.bun/bin`
- other installer state under `$HOME`

Examples:

```bash
cargo install --root "$HOME/.local" <crate>
GOBIN="$HOME/.local/bin" go install <module>@latest
make install PREFIX="$HOME/.local"
bun install -g <package>
```

`$HOME/.local/bin` and `$HOME/.bun/bin` are already on `PATH`.

Regenerable package caches are mounted separately from
`${OP_HOME}/cache/assistant`; `openpalm doctor --clean-caches` may remove them
without deleting installed home files.

## Persistent Prefix

The named volume `assistant-persistent` is mounted at `/opt/persistent`, and
`/opt/persistent/bin` is first on `PATH`. Use it for software that requires a
prefix outside the home directory:

```bash
make install PREFIX=/opt/persistent
```

This named volume survives normal recreates. Include Docker volumes in your
backup plan if you store irreplaceable files there; a full `OP_HOME` archive
does not contain named-volume content.

## System Packages

An in-container `apt install` survives a process restart but not a container
recreate. OpenPalm does not maintain an apt manifest or modify the entrypoint at
runtime.

For a package that must exist in every recreated container, build a derived
image:

```dockerfile
FROM openpalm/assistant:0.13.0
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
USER root
```

Then override only the assistant image in the user-owned overlay:

```yaml
# ~/.openpalm/config/stack/custom.compose.yml
services:
  assistant:
    image: local/openpalm-assistant:0.13.0
```

Do not edit `system/stack/core.compose.yml` or the shipped entrypoint; managed
files are replaced on reconcile. Rebuild the derived image when the base image
or package set changes.

## Image-Baked Assets

The standard image already bakes the default tool package tree and OpenPalm UI.
Startup does not install or update them from npm. Skeleton files are host assets,
not image content. To change an image-wide default, build/release a new assistant
image rather than adding a runtime version variable.

## Verify

```bash
docker exec --user node openpalm-assistant-1 sh -lc 'command -v <tool>'
docker exec --user node openpalm-assistant-1 ls -la /home/opencode/.local/bin
docker exec --user node openpalm-assistant-1 ls -la /opt/persistent/bin
```

Use the actual container name from `docker ps` if the Compose project name is
not `openpalm`.

## Summary

| Need | Supported approach |
|---|---|
| User-level binary or package | Install under `$HOME` or `$HOME/.local` |
| Prefix-style persistent install | Install under `/opt/persistent` |
| One-session distro package | Install in the current writable layer |
| Distro package across recreates | Build a derived image and override it in `custom.compose.yml` |
| Platform default tool | Add it to the released assistant image |
