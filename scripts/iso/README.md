# Debian 13 Kiosk ISO Helper

This directory contains an experimental builder for a Debian 13 kiosk ISO that boots into Chromium and points at an OpenPalm admin URL.

## Position in the current model

- OpenPalm's normal deployment model is still manual-first Docker Compose using the `.openpalm/` bundle
- This ISO helper is an appliance-oriented wrapper around that idea
- It should be treated as a specialized path, not the canonical install flow

## What it builds

`build-debian13-kiosk-iso.sh` creates:

- `.build/out/openpalm-debian13-kiosk-<arch>.iso`

The generated system:

- boots to LightDM
- forces a first-login password change
- launches Chromium in kiosk mode
- keeps Docker and the OpenPalm bootstrap service enabled
- can preload OpenPalm images into the local Docker cache

## Build prerequisites

```bash
sudo apt-get update
sudo apt-get install -y live-build rsync zstd docker.io
sudo systemctl enable --now docker
```

## Build

This builder is not currently a supported end-user flow. The script still needs
to be refreshed for the current `.openpalm/` bundle layout before these commands
are expected to work reliably.

If you are iterating on the ISO packaging internally, start from:

```bash
KIOSK_USER=operator \
KIOSK_PASSWORD='ChangeMeNow123!' \
OP_ADMIN_URL='http://127.0.0.1:3880' \
DEBIAN_ARCH=arm64 \
./scripts/iso/build-debian13-kiosk-iso.sh
```

For `amd64`:

```bash
DEBIAN_ARCH=amd64 ./scripts/iso/build-debian13-kiosk-iso.sh
```

## Optional overrides

- `OP_IMAGES_TAR` - prebuilt image cache path
- `ISO_OUT_DIR` - output directory
- `BUILD_ROOT` - temporary live-build workspace
- `DEBIAN_SUITE` - defaults to `trixie`
- `DEBIAN_ARCH` - `arm64` or `amd64`
- `DEBIAN_MIRROR` / `DEBIAN_SECURITY_MIRROR` - mirror overrides

## Runtime notes

- The kiosk session opens the URL from `OP_ADMIN_URL`
- Use the deployed admin addon URL (`http://127.0.0.1:3880` by default), not the container's internal port
- The ISO helper is currently an internal packaging flow and still expects repo-local asset paths during image assembly; treat it as development-only until it is refreshed for the current `.openpalm/` bundle layout

## Production notes

- Replace the default kiosk password in CI or build secrets
- Keep the admin URL loopback-bound unless you intentionally expose it
- Add your own first-boot networking or provisioning UX if needed
