# Debian 13 Kiosk ISO for OpenPalm

This guide creates a Debian 13 (trixie) kiosk ISO for Raspberry Pi class hardware (`arm64`) and standard x86_64 systems (`amd64`) that:

- boots to a graphical login manager (`lightdm`),
- uses a known default user/password,
- forces password rotation at first successful login,
- launches Chromium in kiosk mode to the OpenPalm admin URL,
- keeps Docker and the OpenPalm stack running at boot,
- enables unattended security updates,
- preloads current OpenPalm container images into the ISO.

## What this produces

The build script `scripts/iso/build-debian13-kiosk-iso.sh` composes a live-build tree and outputs:

- `.build/out/openpalm-debian13-kiosk-<arch>.iso`

The generated system includes these behavior guarantees:

1. **First-login password change**
   - User is created during image build and `chage -d 0` expires the password.
2. **No traditional desktop session**
   - A custom X session (`openpalm-kiosk.desktop`) launches `/usr/local/bin/openpalm-kiosk-session.sh`.
3. **OpenPalm stack reconciliation on boot**
   - `openpalm-stack.service` executes `/usr/local/bin/openpalm-bootstrap.sh`.
   - `openpalm-stack.timer` re-runs reconciliation every 5 minutes.
4. **Security updates**
   - `unattended-upgrades` is configured via `/etc/apt/apt.conf.d/52openpalm-auto-upgrades`.
5. **Offline-ish first boot**
   - Image cache (`openpalm-images.tar.zst`) is loaded into local Docker image store on first boot.

## Build prerequisites

Install required tooling on the build host:

```bash
sudo apt-get update
sudo apt-get install -y live-build rsync zstd docker.io
sudo systemctl enable --now docker
```

## Build the ISO

From the repository root:

```bash
KIOSK_USER=operator \
KIOSK_PASSWORD='ChangeMeNow123!' \
OPENPALM_ADMIN_URL='http://127.0.0.1:8100' \
DEBIAN_ARCH=arm64 \
./scripts/iso/build-debian13-kiosk-iso.sh
```

For standard x86_64 systems:

```bash
DEBIAN_ARCH=amd64 ./scripts/iso/build-debian13-kiosk-iso.sh
```

### Optional overrides

- `OPENPALM_IMAGES_TAR`: path to prebuilt `.tar.zst` image cache.
- `ISO_OUT_DIR`: output directory for final ISO.
- `BUILD_ROOT`: temporary live-build workspace.
- `DEBIAN_SUITE`: defaults to `trixie`.
- `DEBIAN_ARCH`: `arm64` or `amd64` (also accepts aliases `aarch64`, `x86_64`, `amd`).
- `DEBIAN_MIRROR` / `DEBIAN_SECURITY_MIRROR`: mirror customization.

## Flash and boot

1. Flash `.build/out/openpalm-debian13-kiosk-<arch>.iso` to target media.
2. Boot the device.
3. Sign in as configured `KIOSK_USER` with configured `KIOSK_PASSWORD`.
4. System forces password change immediately.
5. After successful password change, kiosk session opens OpenPalm admin at `OPENPALM_ADMIN_URL`.

## Runtime filesystem layout on device

The boot service uses:

- `OPENPALM_CONFIG_HOME=/var/lib/openpalm/config`
- `OPENPALM_STATE_HOME=/var/lib/openpalm/state`
- `OPENPALM_DATA_HOME=/var/lib/openpalm/data`
- `OPENPALM_WORK_DIR=/var/lib/openpalm/work`

This keeps config/state/data separated and aligned with OpenPalm's XDG-style
contract. The paths intentionally deviate from the standard XDG defaults
(`~/.config/`, `~/.local/share/`, `~/.local/state/`) because the kiosk is an
appliance: a single-purpose device where all OpenPalm data lives under
`/var/lib/openpalm/` for simpler management, backup, and security hardening.

## Notes for production rollout

- Replace default password in build pipeline secrets.
- Keep `OPENPALM_ADMIN_URL` on loopback for local-only kiosk access.
- If you need Wi-Fi onboarding, add NetworkManager + a first-boot provisioning UI before kiosk launch.
- For fully immutable kiosk behavior, tighten TTY switching and shell access separately.
