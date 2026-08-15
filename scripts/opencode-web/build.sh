#!/usr/bin/env bash
# Build OpenCode's web UI from PINNED source with base-path support, into
# packages/ui/static/opencode-ui/ (GITIGNORED — no built artifact is ever
# committed; this repo carries only this script and the patch beside it).
#
# Why this exists: /advanced embeds OpenCode's web UI on OpenPalm's own origin.
# The app is a Vite SPA compiled for the origin root, and upstream has no
# base-path option — so we build the app ourselves from the exact source tag
# matching the pinned `opencode-ai` runtime, with a four-hunk patch that makes
# it subpath-clean:
#   1. entry.tsx           — honor VITE_OPENCODE_SERVER_URL (server = /oc here)
#   2. server-protocol.ts  — path-preserving URL join
#   3. app.tsx             — router base from Vite's --base
#   4. @opencode-ai/client — one line, applied post-install below (the package
#      ships prebuilt inside their repo, so it cannot ride the git patch)
# Everything asserts loudly: bumping the opencode pin with drifted sources
# fails THIS build, never a user's workspace at runtime.
#
# Served at /opencode-ui/ as plain static files; every API call the app makes
# goes to the same-origin /oc proxy, which holds the session gate and attaches
# OpenCode's credential server-side. No runtime rewriting anywhere.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PATCH_FILE="$REPO_ROOT/scripts/opencode-web/opencode-app-subpath.patch"
OUT_DIR="$REPO_ROOT/packages/ui/static/opencode-ui"
WORK_DIR="${OPENCODE_WEB_BUILD_DIR:-$REPO_ROOT/.opencode-web-build}"

# The single source of truth for the version is the runtime pin — the web UI
# must match the `opencode` server it talks to.
PIN="$(node -e 'console.log(require(process.argv[1]).dependencies["opencode-ai"])' \
  "$REPO_ROOT/containers/assistant/tools/package.json")"
if [ -z "$PIN" ] || [[ "$PIN" == *[\^\~\*]* ]]; then
  echo "error: opencode-ai pin '$PIN' is not an exact version" >&2
  exit 1
fi
TAG="v$PIN"

if [ -f "$OUT_DIR/.version" ] && [ "$(cat "$OUT_DIR/.version")" = "$PIN" ]; then
  echo "opencode-web: bundle for $PIN already present at $OUT_DIR — nothing to do"
  exit 0
fi

echo "opencode-web: building app $TAG (bundle -> $OUT_DIR)"
rm -rf "$WORK_DIR"
git clone --depth 1 --branch "$TAG" https://github.com/sst/opencode "$WORK_DIR"

# Keep the install to the app's workspace closure — the full monorepo drags in
# desktop/TUI toolchains this build never touches.
node - "$WORK_DIR" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const keep = [
  "packages/app",
  "packages/core",
  "packages/effect-drizzle-sqlite",
  "packages/effect-sqlite-node",
  "packages/http-recorder",
  "packages/llm",
  "packages/plugin",
  "packages/schema",
  "packages/session-ui",
  "packages/ui",
  "packages/sdk/js",
];
const file = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.workspaces = keep;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
NODE

(cd "$WORK_DIR" && git apply --verbose "$PATCH_FILE")
(cd "$WORK_DIR" && bun install)

# Hunk 4: their vendored @opencode-ai/client ships prebuilt (a tarball inside
# their repo), so it is patched where it lands after install. The grep pair
# makes drift a hard failure, mirroring `git apply` above.
CLIENT_JS="$WORK_DIR/packages/app/node_modules/@opencode-ai/client/dist/promise/generated/client.js"
OLD='const url = new URL(descriptor.path, options.baseUrl);'
NEW='const url = new URL(`${(options.baseUrl ?? "").replace(/\/$/, "")}${descriptor.path}`);'
grep -qF "$OLD" "$CLIENT_JS" || { echo "error: @opencode-ai/client join site drifted — update this script and the patch" >&2; exit 1; }
node -e '
const fs = require("fs");
const [file, oldStr, newStr] = process.argv.slice(1);
fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(oldStr, newStr));
' "$CLIENT_JS" "$OLD" "$NEW"
grep -qF "$NEW" "$CLIENT_JS" || { echo "error: @opencode-ai/client patch did not apply" >&2; exit 1; }

# Sourcemaps off: they are ~40 MB of the default output and nothing ships them.
(cd "$WORK_DIR/packages/app" && \
  VITE_OPENCODE_SERVER_URL=/oc \
  ./node_modules/.bin/vite build --base=/opencode-ui/ --sourcemap false)

rm -rf "$OUT_DIR"
mkdir -p "$(dirname "$OUT_DIR")"
cp -r "$WORK_DIR/packages/app/dist" "$OUT_DIR"
printf '%s\n' "$PIN" > "$OUT_DIR/.version"
rm -rf "$WORK_DIR"
echo "opencode-web: built $PIN -> $OUT_DIR"
