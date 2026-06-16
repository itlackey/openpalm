# Persisting Assistant-Installed Tools

The assistant container's writable layer (everything outside the bind-mounted directories) is **discarded on `docker compose up --force-recreate`, on image upgrades, and on any other container recreate**. Tools installed with `apt install`, `npm i -g`, `pip install` into the system Python, etc. all live in that writable layer and disappear at the next recreate.

OpenPalm ships with two persistence patterns enabled out of the box (home-based installs and the `/opt/persistent` escape hatch), and supports a more involved apt pattern if the assistant needs to keep distro packages across upgrades.

---

## Pattern 1 — Assistant Home (enabled by default)

The assistant container bind-mounts `${OP_HOME}/data/assistant` at `/home/opencode`, and `/home/opencode/.local/bin` is first on `PATH`. Anything installed under `$HOME` or `$HOME/.local` survives recreates and image upgrades.

| Installer | How to use it | Notes |
|---|---|---|
| `cargo install` | `cargo install --root "$HOME/.local" <crate>` | Drops binaries into `$HOME/.local/bin` |
| `go install` | `GOBIN="$HOME/.local/bin" go install <pkg>@latest` | |
| `make install` | `make install PREFIX="$HOME/.local"` | Most autotools/make projects respect `PREFIX` |
| Pre-built tarballs | `tar -xJf …; mv ./<bin> "$HOME/.local/bin/"` | Standard "extract a binary" pattern |
| Direct download | `curl -L … -o "$HOME/.local/bin/<tool>" && chmod +x "$HOME/.local/bin/<tool>"` | |
| Self-installers | Many provide `--install-dir` or `--prefix` flags | Check `<installer> --help` |

`$HOME`-based installers (`bun install -g`, `pipx install`, `uv tool install`, etc.) already persist via the same `/home/opencode/` bind mount. If an installer cannot use `$HOME/.local`, use `/opt/persistent` as an escape hatch: binaries in `/opt/persistent/bin` are also on `PATH`.

### Verifying

```bash
docker compose exec assistant ls /home/opencode/.local/bin
docker compose exec assistant ls /opt/persistent/bin
```

---

## Pattern 2 — apt package manifest (advanced, opt-in)

If the assistant needs to install Debian packages (`apt install`) and have them survive upgrades, you can wire up a manifest + named apt cache. This is **not enabled by default** because it adds startup time and a small failure surface (a package that vanishes from the upstream repo causes a noisy start).

### When to use Pattern 2

- The assistant routinely runs `apt install <pkg>` for new tools and you don't want to bake them into `containers/assistant/Dockerfile` each time.
- The tool you need has no upstream binary release and is only available via apt (otherwise prefer Pattern 1).
- You're comfortable with the assistant container taking 5–30 extra seconds on first start of each upgrade cycle while apt re-fetches.

For most use cases, **prefer adding packages to `containers/assistant/Dockerfile`** — it's faster, more reproducible, and travels with the image.

### Implementation

**1. Add named volumes for the apt cache and lib state.** In `~/.openpalm/config/stack/core.compose.yml`, on the `assistant` service:

```yaml
    volumes:
      # … existing mounts …
      - assistant-apt-cache:/var/cache/apt
      - assistant-apt-lib:/var/lib/apt
```

And at the bottom of the file:

```yaml
volumes:
  assistant-apt-cache:
  assistant-apt-lib:
```

**2. Add a manifest reader to the entrypoint.** Edit `containers/assistant/entrypoint.sh` to add a new function and call it from the startup sequence:

```bash
maybe_install_extra_packages() {
  local manifest="/home/opencode/.local/share/openpalm/extra-packages.txt"
  [ -r "$manifest" ] || return 0
  # Read one package per line, skipping blanks and comments.
  local pkgs
  pkgs="$(grep -vE '^\s*(#|$)' "$manifest" | xargs)"
  [ -n "$pkgs" ] || return 0
  if [ "$(id -u)" = "0" ]; then
    apt-get update -qq || true
    # shellcheck disable=SC2086
    apt-get install -y --no-install-recommends $pkgs || \
      echo "WARN: extra-packages install partially failed" >&2
  fi
}
```

Call it after `ensure_home_layout` and before `start_opencode`. Rebuild the assistant image:

```bash
docker build -t openpalm/assistant:dev -f containers/assistant/Dockerfile .
docker compose up -d --force-recreate assistant
```

**3. Maintain the manifest.** The manifest lives in the existing `/home/opencode` bind mount, so it persists across recreates. The assistant adds a package like this:

```bash
# inside the assistant container
mkdir -p ~/.local/share/openpalm
echo "ripgrep" >> ~/.local/share/openpalm/extra-packages.txt
sudo apt-get install -y --no-install-recommends ripgrep
```

On the next recreate, the entrypoint sees `ripgrep` in the manifest and re-installs it (fast — the `.deb` is in the cache volume).

### Failure modes to know about

- **Missing package upstream**: if a package in the manifest no longer exists, `apt-get install` returns non-zero. The entrypoint logs a warning and continues. Audit the manifest periodically.
- **First start is slow**: the apt cache volume is empty on first creation. Expect 10–60 seconds for the initial `apt-get update && install` depending on package count.
- **Manifest grows unbounded**: a long manifest slows every start. Prune ruthlessly; move "permanent" packages into `containers/assistant/Dockerfile`.

---

## Pattern 3 — bake into the Dockerfile (the right answer for "every install")

For anything that should be present on **every** OpenPalm install (e.g. `ripgrep`, `htop`, language runtimes), add it to the `apt-get install` line in `containers/assistant/Dockerfile`. This is the cleanest, most reproducible, fastest-startup option. It just requires a release / image rebuild to roll out.

---

## Summary

| Need | Use |
|---|---|
| Persist a Cargo / Go / `make install` tool | **Pattern 1** — install to `$HOME/.local` |
| Persist a tool that requires a global-style prefix | Install to `/opt/persistent` |
| Persist a `bun install -g`, `pipx`, `uv tool install` | Already works via the home bind mount — no extra setup |
| Persist a one-off `apt install` for this session only | Plain `sudo apt install <pkg>` — survives restart, not recreate |
| Persist a small set of distro packages across upgrades | **Pattern 2** — manifest + cache volume |
| Add a package to every install | **Pattern 3** — Dockerfile edit |
