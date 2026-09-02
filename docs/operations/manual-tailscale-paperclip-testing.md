# Manual Tailscale and Paperclip Acceptance

This runbook manually verifies the OpenPalm `remote` (Tailscale) and
`paperclip` addons against a disposable, isolated installation built from the
current checkout. It supplements Tier 5; Tier 5 deliberately uses no real
external credentials and does not start either addon.

Run the whole guide for a release candidate that changes either addon, addon
lifecycle behavior, networking, secrets, or the managed Compose stack.

## Result Rules

- Record the candidate SHA, host platform, browser/device, result, and evidence
  for every required result. Never capture a secret, pairing code, bootstrap
  invite, session cookie, or full Tailscale status response.
- A required result that does not occur is `FAIL`. A later recovery step exists
  only to continue coverage; it does not convert that failure into a pass.
- The setup installs an `ERR` trap so a failed shell assertion is visible and
  counted even when later commands continue for recovery coverage. Any nonzero
  final count is a failed candidate.
- Use `BLOCKED_CREDENTIAL` only when a required Tailscale account capability or
  test credential is genuinely unavailable. An implementation failure is not a
  credential block.
- Do not use `~/.openpalm`, the Compose project `openpalm`, production ports, or
  a production tailnet node. Paperclip remains loopback-only and is not a
  supported target of the Tailscale addon.

The commands below assume Linux; Bash; Bun; Node.js; Git; OpenSSL; `curl`;
Docker Compose V2; `ss` from iproute2; `ps` from procps; and GNU `realpath`,
`stat`, `sha256sum`, `sort`, and `cut`. Run them from the repository root in a
dedicated Bash shell with xtrace disabled. Do not source an OpenPalm or Compose
environment file into that shell; the setup refuses inherited `OP_*` and
`COMPOSE_*` overrides.

## Prerequisites

Prepare these before starting:

- A tailnet with MagicDNS and HTTPS enabled.
- A one-off, non-ephemeral, pre-approved Tailscale auth key, restricted to a
  test tag when the tailnet policy supports tags. Non-ephemeral is intentional:
  this runbook verifies that the persisted node identity survives a restart.
  Do not use a reusable production key.
- Funnel permission for that test tag if the public-mode test will run. Funnel
  also requires the tailnet's HTTPS and Funnel prerequisites.
- Tailnet policy that lets the second test device reach the test-tagged node.
- One second device signed into the same tailnet, with `curl` or equivalent
  browser developer tools for the Guardian status/header checks.
- One browser/device that is not on the tailnet, such as a phone on cellular
  with Tailscale disconnected, with `curl` or browser developer tools for the
  private-denial, login-throttle, and Funnel tests.
- Enough disk for the OpenPalm development images and both upstream addon
  images.
- A disposable provider credential for one credential-backed Paperclip local
  adapter run. Record `BLOCKED_CREDENTIAL` if none is available.
- No stale tailnet node named `openpalm-e2e-manual-addons` from an earlier test.

Relevant Tailscale references:

- [Auth keys](https://tailscale.com/kb/1085/auth-keys)
- [Enable HTTPS](https://tailscale.com/kb/1153/enabling-https)
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)

## 1. Start an Isolated Instance

The launcher below replaces only the exact generated test home under `.cache/`.
After a successful run it leaves the isolated stack and host Admin process
running because `--keep` is set; a failed run cleans them up.

```bash
set +x
set +e
set -Euo pipefail

MANUAL_COMMAND_FAILURES=0
record_failure() {
  MANUAL_COMMAND_FAILURES=$((MANUAL_COMMAND_FAILURES + 1))
  printf 'FAIL: %s\n' "$1" >&2
}
record_shell_failure() {
  local status="$1"
  local command="$2"
  record_failure "command exited $status: $command"
}
capture_project_health() {
  local project="$1"
  local ids
  local id
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$project")" || return 1
  for id in $ids; do
    docker inspect --format '{{.Id}}|status={{.State.Status}}|health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" || return 1
  done
}
trap 'record_shell_failure "$?" "$BASH_COMMAND"' ERR

if env | grep -Eq '^(OP_|COMPOSE_)'; then
  printf 'Refusing inherited OP_* or COMPOSE_* overrides; start a clean test shell.\n' >&2
  exit 1
fi

REPO="$(git rev-parse --show-toplevel)"
export REPO
TEST_HOME="$(realpath -m -- "$REPO/.cache/manual-tailscale-paperclip")"
export TEST_HOME
export TEST_PROJECT="openpalm-e2e-manual-addons"
export TEST_ADMIN_PORT=3990
export TEST_ASSISTANT_PORT=3991
export TEST_UI_PORT=3992
export TEST_GUARDIAN_PORT=3993
export TEST_GUARDIAN_ADMIN_PORT=3994
export TEST_API_PORT=3995
export TEST_CHAT_PORT=3996
export TEST_PAPERCLIP_PORT=3940

readonly REPO TEST_HOME TEST_PROJECT TEST_ADMIN_PORT TEST_ASSISTANT_PORT
readonly TEST_UI_PORT TEST_GUARDIAN_PORT TEST_GUARDIAN_ADMIN_PORT
readonly TEST_API_PORT TEST_CHAT_PORT TEST_PAPERCLIP_PORT

if [[ "$TEST_HOME" != "$REPO/.cache/manual-tailscale-paperclip" ||
      "$TEST_HOME" == "$HOME/.openpalm" ]]; then
  printf 'Refusing unsafe test home: %s\n' "$TEST_HOME" >&2
  exit 1
fi

if ! INITIAL_GIT_STATUS="$(git status --porcelain)"; then
  printf 'Could not inspect the candidate checkout.\n' >&2
  exit 1
fi
if [[ -n "$INITIAL_GIT_STATUS" ]]; then
  printf 'Refusing a dirty candidate checkout; commit or remove changes first.\n' >&2
  exit 1
fi

CANDIDATE_SHA="$(git rev-parse HEAD)"
export CANDIDATE_SHA
readonly CANDIDATE_SHA

DOCKER_ENDPOINT="$(
  docker context inspect --format '{{(index .Endpoints "docker").Host}}'
)"
case "$DOCKER_ENDPOINT" in
  unix://*) ;;
  *)
    printf 'Refusing non-local Docker endpoint: %s\n' "$DOCKER_ENDPOINT" >&2
    exit 1
    ;;
esac
readonly DOCKER_ENDPOINT

export OP_E2E_PROJECT_NAME="$TEST_PROJECT"
export OP_E2E_HOME="$TEST_HOME"
export OP_E2E_UI_PORT="$TEST_ADMIN_PORT"
export OP_E2E_ASSISTANT_PORT="$TEST_ASSISTANT_PORT"
export OP_E2E_CONTAINER_UI_PORT="$TEST_UI_PORT"
export OP_E2E_GUARDIAN_PORT="$TEST_GUARDIAN_PORT"
export OP_E2E_GUARDIAN_ADMIN_PORT="$TEST_GUARDIAN_ADMIN_PORT"
export OP_E2E_API_PORT="$TEST_API_PORT"

for port in \
  "$TEST_ADMIN_PORT" "$TEST_ASSISTANT_PORT" "$TEST_UI_PORT" \
  "$TEST_GUARDIAN_PORT" "$TEST_GUARDIAN_ADMIN_PORT" \
  "$TEST_API_PORT" "$TEST_CHAT_PORT" "$TEST_PAPERCLIP_PORT" 3941; do
  if ! PORT_LISTENERS="$(ss -H -ltn "sport = :$port")"; then
    printf 'Could not inspect test port: %s\n' "$port" >&2
    exit 1
  fi
  if [[ -n "$PORT_LISTENERS" ]]; then
    printf 'Refusing occupied test port: %s\n' "$port" >&2
    exit 1
  fi
done

if ! TEST_PROJECT_CONTAINERS="$(
  docker ps -a --filter "label=com.docker.compose.project=$TEST_PROJECT" --format '{{.ID}}'
)" || ! TEST_PROJECT_NETWORKS="$(
  docker network ls --filter "label=com.docker.compose.project=$TEST_PROJECT" --format '{{.ID}}'
)" || ! TEST_PROJECT_VOLUMES="$(
  docker volume ls --filter "label=com.docker.compose.project=$TEST_PROJECT" --format '{{.Name}}'
)"; then
  printf 'Could not inspect existing test-project resources.\n' >&2
  exit 1
fi
if [[ -n "$TEST_PROJECT_CONTAINERS" || -n "$TEST_PROJECT_NETWORKS" ||
      -n "$TEST_PROJECT_VOLUMES" ]]; then
  printf 'Refusing existing Compose project: %s\n' "$TEST_PROJECT" >&2
  exit 1
fi

for image in openpalm/assistant:dev openpalm/guardian:dev; do
  if ! IMAGE_USERS="$(docker ps -a --filter "ancestor=$image" --format '{{.ID}}')"; then
    printf 'Could not inspect containers using dev image: %s\n' "$image" >&2
    exit 1
  fi
  if [[ -n "$IMAGE_USERS" ]]; then
    printf 'Refusing to replace a dev image used by an existing container: %s\n' "$image" >&2
    exit 1
  fi
done

export PROD_HOME="$HOME/.openpalm"
PROD_PROJECT='openpalm'
if [[ -f "$PROD_HOME/state/stack.env" ]]; then
  CONFIGURED_PROD_PROJECT="$(
    sed -n 's/^OP_PROJECT_NAME=//p' "$PROD_HOME/state/stack.env" | tail -n 1
  )"
  if [[ -n "$CONFIGURED_PROD_PROJECT" ]]; then
    PROD_PROJECT="$CONFIGURED_PROD_PROJECT"
  fi
fi
export PROD_PROJECT
readonly PROD_HOME PROD_PROJECT

if [[ "$PROD_PROJECT" == "$TEST_PROJECT" ]]; then
  printf 'Refusing test project name that matches the production project.\n' >&2
  exit 1
fi

if ! PROD_CONTAINERS_BEFORE="$(
  docker ps -a --filter "label=com.docker.compose.project=$PROD_PROJECT" \
    --format '{{.ID}}|{{.Names}}|{{.Ports}}' | sort
)"; then
  printf 'Could not capture production containers.\n' >&2
  exit 1
fi
export PROD_CONTAINERS_BEFORE
if ! PROD_HEALTH_BEFORE="$(capture_project_health "$PROD_PROJECT" | sort)"; then
  printf 'Could not capture production health.\n' >&2
  exit 1
fi
export PROD_HEALTH_BEFORE
if ! PROD_STACK_ENV_BEFORE="$(
  if [[ -f "$PROD_HOME/state/stack.env" ]]; then
    sha256sum "$PROD_HOME/state/stack.env" | cut -d' ' -f1
  else
    printf 'missing\n'
  fi
)"; then
  printf 'Could not hash the production stack.env.\n' >&2
  exit 1
fi
export PROD_STACK_ENV_BEFORE

printf '%s\n' "$PROD_HEALTH_BEFORE"
if [[ -n "$PROD_HEALTH_BEFORE" ]] &&
  printf '%s\n' "$PROD_HEALTH_BEFORE" |
    grep -Evq '\|status=running\|health=(healthy|none)$'; then
  printf 'Refusing unhealthy production baseline\n' >&2
  exit 1
fi

if ! ./scripts/dev-e2e-test.sh --keep; then
  printf 'The isolated launcher failed and attempted scoped cleanup; do not continue.\n' >&2
  exit 1
fi
```

The preflight must pass before the launcher runs. Do not stop an unrelated
listener, reuse an existing project, or rebuild a dev image used by another
container to make the test fit. The repository's `.dockerignore` excludes the
exact secret-bearing test home from every image build context.

Replace the launcher's public test password immediately. Keep the generated
value in this shell and transfer it to test devices through a secure password
manager; do not print or capture it as evidence. The in-place write updates the
Host Admin immediately. The assistant UI reads its secret at process start, so
the assistant is explicitly restarted below.

```bash
TEST_UI_PASSWORD="$(openssl rand -hex 32)"
printf '%s\n' "$TEST_UI_PASSWORD" > "$TEST_HOME/state/secrets/op_ui_login_password"
chmod 600 "$TEST_HOME/state/secrets/op_ui_login_password"

# A real install seeds this delegated secret as an existing empty file.
: > "$TEST_HOME/state/secrets/ts_authkey"
chmod 600 "$TEST_HOME/state/secrets/ts_authkey"
```

Capture the retained Admin supervisor, not only its socket-owning child:

```bash
ADMIN_CHILD_PID="$(
  ss -H -ltnp "sport = :$TEST_ADMIN_PORT" |
    sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p'
)"
ADMIN_SUPERVISOR_PID="$(ps -o ppid= -p "$ADMIN_CHILD_PID" | tr -d ' ')"
test -n "$ADMIN_CHILD_PID"
test -n "$ADMIN_SUPERVISOR_PID"
test "$ADMIN_SUPERVISOR_PID" -gt 1
ADMIN_SUPERVISOR_START="$(ps -o lstart= -p "$ADMIN_SUPERVISOR_PID")"
ADMIN_SUPERVISOR_COMMAND="$(ps -o args= -p "$ADMIN_SUPERVISOR_PID")"
test -n "$ADMIN_SUPERVISOR_START"
test -n "$ADMIN_SUPERVISOR_COMMAND"
ps -fp "$ADMIN_SUPERVISOR_PID" "$ADMIN_CHILD_PID"
```

Define a helper that always targets the isolated home:

```bash
op_test() {
  OP_HOME="$TEST_HOME" bun run packages/cli/src/main.ts "$@"
}

export ASSISTANT_CONTAINER="$TEST_PROJECT-assistant-1"
export GUARDIAN_CONTAINER="$TEST_PROJECT-guardian-1"
export TUNNEL_CONTAINER="$TEST_PROJECT-tunnel-1"
export PAPERCLIP_CONTAINER="$TEST_PROJECT-paperclip-1"

op_test restart assistant
op_test start assistant

OLD_PASSWORD_STATUS="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$TEST_UI_PORT/api/auth/login" \
    -H 'content-type: application/json' \
    --data '{"password":"e2e-test-password"}'
)"
NEW_PASSWORD_STATUS="$(
  printf '{"password":"%s"}' "$TEST_UI_PASSWORD" |
    curl -sS -o /dev/null -w '%{http_code}' \
      -X POST "http://127.0.0.1:$TEST_UI_PORT/api/auth/login" \
      -H 'content-type: application/json' \
      --data-binary @-
)"
test "$OLD_PASSWORD_STATUS" = 401
test "$NEW_PASSWORD_STATUS" = 200
```

Verify the baseline before adding either service:

```bash
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
grep -E '^(OP_HOME|OP_PROJECT_NAME|OP_ENABLED_ADDONS)=' "$TEST_HOME/state/stack.env"
curl -fsS "http://127.0.0.1:$TEST_ADMIN_PORT/health"
docker ps --filter "label=com.docker.compose.project=$TEST_PROJECT" \
  --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'

if ! TEST_CONTAINER_IDS="$(
  docker ps -aq --filter "label=com.docker.compose.project=$TEST_PROJECT"
)"; then
  printf 'Could not inspect test-project containers.\n' >&2
  exit 1
fi
TEST_MOUNT_SOURCES=''
for id in $TEST_CONTAINER_IDS; do
  if ! CONTAINER_MOUNTS="$(
    docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$id"
  )"; then
    printf 'Could not inspect test-container mounts.\n' >&2
    exit 1
  fi
  TEST_MOUNT_SOURCES+="${CONTAINER_MOUNTS}"$'\n'
done
if printf '%s\n' "$TEST_MOUNT_SOURCES" | grep -Fqx "$PROD_HOME" ||
  printf '%s\n' "$TEST_MOUNT_SOURCES" | grep -Fq "$PROD_HOME/"; then
  printf 'FAIL: a test container mounts the production home\n' >&2
  exit 1
fi
```

Required results:

- `OP_HOME` is the `.cache/manual-tailscale-paperclip` path and the project is
  `openpalm-e2e-manual-addons`.
- The Admin health request succeeds, and only test-project containers use the
  selected ports.
- No test container mounts the production home. The captured production
  project containers and `state/stack.env` have not changed.

Print and open the isolated Admin URL, then sign in with `TEST_UI_PASSWORD`:

```bash
printf 'Admin URL: http://127.0.0.1:%s/host?tab=addons\n' "$TEST_ADMIN_PORT"
```

Confirm that **Remote** and **Paperclip** are both listed and disabled.

## 2. Configure Private Tailscale Serve

In **Host > Addons > Remote > Configure**:

1. Verify a fresh form presents `assistant` as the effective
   `OP_REMOTE_TARGET`, private mode (`OP_REMOTE_PUBLIC` off), and a blank custom
   hostname. A placeholder that is submitted as an empty target is a failure.
2. Keep the custom hostname blank so OpenPalm derives and pins it from the
   isolated project name.
3. For `TS_AUTHKEY`, choose **New**, use the exact secret name `ts_authkey`,
   paste the disposable key, and choose **Save & select**.
4. Save the Remote settings without enabling the addon yet.

If the fresh-form default is not submitted correctly, record `FAIL`, explicitly
enter `assistant`, and save again so the remaining tests can continue.

If the secret picker cannot replace the seeded `ts_authkey`, record `FAIL` and
use this test-only continuation without printing the key:

```bash
umask 077
read -rsp 'Disposable Tailscale auth key: ' TEST_TS_AUTHKEY; printf '\n'
printf '%s\n' "$TEST_TS_AUTHKEY" > "$TEST_HOME/state/secrets/ts_authkey"
chmod 600 "$TEST_HOME/state/secrets/ts_authkey"
unset TEST_TS_AUTHKEY
```

Verify secret placement and non-secret configuration without displaying the
secret:

```bash
test "$(stat -c '%a' "$TEST_HOME/state/secrets/ts_authkey")" = 600
if [[ -e "$TEST_HOME/knowledge/secrets/ts_authkey" ]]; then
  record_failure 'ts_authkey leaked into the assistant-readable knowledge tree'
fi
if grep -q '^TS_AUTHKEY=' "$TEST_HOME/state/stack.env"; then
  record_failure 'TS_AUTHKEY leaked into state/stack.env'
else
  GREP_STATUS=$?
  if [[ "$GREP_STATUS" -gt 1 ]]; then
    record_failure 'state/stack.env could not be inspected for TS_AUTHKEY'
  fi
fi
grep -E '^OP_REMOTE_(TARGET|PUBLIC|HOSTNAME)=' "$TEST_HOME/state/stack.env"
```

Required results:

- The key exists only at `state/secrets/ts_authkey`, mode `0600`.
- Neither `state/stack.env` nor the assistant-readable `knowledge/` tree holds
  the key.
- Target and visibility are `assistant` and `false`. No hostname is pinned
  before first enable.

## 3. Enable and Test the Assistant Target

Click **Enable** on the Remote row. Do not run a CLI command first: this step is
also testing the Admin addon lifecycle.

Wait up to 90 seconds, then inspect:

```bash
docker inspect --format '{{.State.Health.Status}}' "$TUNNEL_CONTAINER"
op_test addon list
```

Required result: the UI enable action starts `tunnel`, it becomes `healthy`, and
Remote is enabled. An enabled badge with no running tunnel is `FAIL`.

To continue after that failure only:

```bash
op_test addon disable remote
op_test addon enable remote
```

Wait for `healthy`, then verify the generated policy:

```bash
node -e '
const c = require(process.argv[1]);
const webKey = "${TS_CERT_DOMAIN}:443";
const sameKeys = (value, expected) =>
  JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...expected].sort());
if (!sameKeys(c.TCP, ["443"])) process.exit(1);
if (!sameKeys(c.Web, [webKey])) process.exit(1);
if (!sameKeys(c.AllowFunnel, [webKey])) process.exit(1);
if (c.TCP?.["443"]?.HTTPS !== true) process.exit(1);
if (!sameKeys(c.Web?.[webKey]?.Handlers, ["/"])) process.exit(1);
if (c.Web?.[webKey]?.Handlers?.["/"]?.Proxy !== "http://assistant:3000") process.exit(1);
if (c.AllowFunnel?.[webKey] !== false) process.exit(1);
' "$TEST_HOME/state/remote/serve.json"

grep '^OP_REMOTE_HOSTNAME=' "$TEST_HOME/state/stack.env"
docker port "$TUNNEL_CONTAINER"
docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
  "$TUNNEL_CONTAINER"
docker inspect --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  "$TUNNEL_CONTAINER"
docker inspect --format 'user={{.Config.User}} privileged={{.HostConfig.Privileged}} caps={{json .HostConfig.CapAdd}} devices={{json .HostConfig.Devices}}' \
  "$TUNNEL_CONTAINER"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$TUNNEL_CONTAINER" |
  grep -x 'TS_AUTH_ONCE=true'
```

Required results:

- `serve.json` contains only private HTTPS `443` proxying to
  `http://assistant:3000`.
- `OP_REMOTE_HOSTNAME=openpalm-e2e-manual-addons` is pinned.
- `docker port` prints nothing: the sidecar publishes no host port.
- The sidecar joins only this project's `assistant_net` and `portal_net`, mounts
  `state/remote`, `data/tunnel`, and the named Tailscale secret, and has no
  Docker socket or broad `state/secrets/` mount.
- The sidecar runs as the configured non-root UID/GID with
  `privileged=false`, no added capabilities, and no device mounts.
- `TS_AUTH_ONCE=true` is active, so the one-off key enrolls the persisted node
  once instead of being replayed on every recreate.

Read the observed FQDN without retaining the peer roster returned by status:

```bash
TS_FQDN="$(
  docker exec "$TUNNEL_CONTAINER" \
    tailscale --socket=/tmp/tailscaled.sock status --json |
    node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const v=JSON.parse(s).Self?.DNSName; if(typeof v!=="string"||!v.trim()) process.exit(1); console.log(v.replace(/\.$/, "")); })'
)"
export TS_FQDN
printf 'Test FQDN: %s\n' "$TS_FQDN"
test -n "$TS_FQDN"
```

On the second, tailnet-connected device:

1. Open `https://<TS_FQDN>`.
2. Confirm the certificate is valid for the Tailscale name.
3. Confirm the OpenPalm login wall appears.
4. Sign in with `TEST_UI_PASSWORD`, reload, and verify the UI remains usable.

On the non-tailnet device, with Tailscale disconnected, open the same URL.

Required results:

- The signed-in tailnet device reaches the assistant over HTTPS and can use the
  authenticated UI.
- The non-tailnet device cannot reach the private Serve URL at all.

Verify node identity survives container replacement:

```bash
TS_ID_BEFORE="$(
  docker exec "$TUNNEL_CONTAINER" \
    tailscale --socket=/tmp/tailscaled.sock status --json |
    node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const v=JSON.parse(s).Self?.ID; if(typeof v!=="string"||!v.trim()) process.exit(1); console.log(v); })'
)"
export TS_ID_BEFORE
test -n "$TS_ID_BEFORE"
test -n "$TS_FQDN"
docker rm -f "$TUNNEL_CONTAINER"
op_test start tunnel
```

Wait for `healthy`, then compare the ID and FQDN:

```bash
TS_ID_AFTER="$(
  docker exec "$TUNNEL_CONTAINER" \
    tailscale --socket=/tmp/tailscaled.sock status --json |
    node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const v=JSON.parse(s).Self?.ID; if(typeof v!=="string"||!v.trim()) process.exit(1); console.log(v); })'
)"
export TS_ID_AFTER
TS_FQDN_AFTER="$(
  docker exec "$TUNNEL_CONTAINER" \
    tailscale --socket=/tmp/tailscaled.sock status --json |
    node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const v=JSON.parse(s).Self?.DNSName; if(typeof v!=="string"||!v.trim()) process.exit(1); console.log(v.replace(/\.$/, "")); })'
)"
export TS_FQDN_AFTER
test "$TS_ID_BEFORE" = "$TS_ID_AFTER"
test "$TS_FQDN" = "$TS_FQDN_AFTER"
```

Both must be unchanged. Removing and recreating the container proves identity
comes from `data/tunnel`, not its writable layer. A recreate that asks for a new
login, consumes another key, or gains a `-1` hostname suffix is `FAIL`.

## 4. Test Guardian and Both Targets

Capture the running container IDs before the settings change:

```bash
BOTH_TUNNEL_ID_BEFORE="$(docker inspect --format '{{.Id}}' "$TUNNEL_CONTAINER")"
BOTH_GUARDIAN_ID_BEFORE="$(docker inspect --format '{{.Id}}' "$GUARDIAN_CONTAINER")"
```

In Remote settings, keep public mode off, change `OP_REMOTE_TARGET` to `both`,
and save. Before any manual apply, verify the Admin save recreated both affected
services:

```bash
test "$BOTH_TUNNEL_ID_BEFORE" != \
  "$(docker inspect --format '{{.Id}}' "$TUNNEL_CONTAINER")"
test "$BOTH_GUARDIAN_ID_BEFORE" != \
  "$(docker inspect --format '{{.Id}}' "$GUARDIAN_CONTAINER")"
```

The Guardian browser connection needs the exact HTTPS UI origin in its CORS
allowlist. Add it to the isolated stack only, then reapply Guardian:

```bash
OP_HOME="$TEST_HOME" TS_FQDN="$TS_FQDN" bun -e '
import { patchSecretsEnvFile } from "./packages/lib/src/control-plane/secrets.ts";
const home = process.env.OP_HOME;
const fqdn = process.env.TS_FQDN;
if (!home || !fqdn) throw new Error("missing isolated test values");
patchSecretsEnvFile(home, { GUARDIAN_CORS_ALLOWED_ORIGINS: `https://${fqdn}` });
'
op_test start guardian
```

Verify the resulting state and policy:

```bash
grep -E '^(OP_REMOTE_TARGET|OP_REMOTE_PUBLIC|GUARDIAN_DIRECT_INGRESS|OP_GUARDIAN_BIND_ADDRESS|GUARDIAN_CORS_ALLOWED_ORIGINS)=' \
  "$TEST_HOME/state/stack.env"
docker port "$GUARDIAN_CONTAINER" 3830/tcp
node -e '
const c = require(process.argv[1]);
const webKeys = ["${TS_CERT_DOMAIN}:443", "${TS_CERT_DOMAIN}:8443"];
const sameKeys = (value, expected) =>
  JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...expected].sort());
if (!sameKeys(c.TCP, ["443", "8443"])) process.exit(1);
if (!sameKeys(c.Web, webKeys)) process.exit(1);
if (!sameKeys(c.AllowFunnel, webKeys)) process.exit(1);
for (const port of ["443", "8443"]) {
  if (c.TCP?.[port]?.HTTPS !== true) process.exit(1);
  const webKey = "${TS_CERT_DOMAIN}:" + port;
  if (!sameKeys(c.Web?.[webKey]?.Handlers, ["/"])) process.exit(1);
  if (c.AllowFunnel?.[webKey] !== false) process.exit(1);
}
if (c.Web?.["${TS_CERT_DOMAIN}:443"]?.Handlers?.["/"]?.Proxy !== "http://assistant:3000") process.exit(1);
if (c.Web?.["${TS_CERT_DOMAIN}:8443"]?.Handlers?.["/"]?.Proxy !== "http://guardian:3830") process.exit(1);
' "$TEST_HOME/state/remote/serve.json"
```

From the tailnet-connected device, substitute the observed hostname:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  'https://<TS_FQDN>:8443/oc/health'
curl -fsS 'https://<TS_FQDN>:8443/health'
curl -sS -D - -o /dev/null \
  -H 'Origin: https://not-allowed.example' \
  'https://<TS_FQDN>:8443/oc/health'
```

Required results:

- Saving `both` recreates the affected running services without a manual full
  stack restart.
- `GUARDIAN_DIRECT_INGRESS=true`, while the host publication remains the
  isolated loopback address `127.0.0.1:3993`.
- Private Serve exposes assistant `443` and Guardian `8443`; neither is
  funneled publicly.
- `https://<TS_FQDN>:8443/health` succeeds from the tailnet device.
- An unauthenticated `https://<TS_FQDN>:8443/oc/health` request returns `401`,
  not `404` or a forwarded success.
- A request with `Origin: https://not-allowed.example` receives no
  `Access-Control-Allow-Origin` header.

From the host Admin UI, open **Connections**, choose **Pair a device**, label it
`Manual Tailscale device`, and use `https://<TS_FQDN>:8443/oc` as the URL. Scan
or import the one-time pairing code on the second device. Do not retain the code
in evidence.

Required result: the second device verifies and saves the Guardian connection,
and can create a Guardian-backed OpenCode session. Authentication and CORS
remain enforced through the Tailscale path.

Now set the target to `guardian` and save again. The Guardian URL must remain
available, while assistant port `443` must close. Restore `assistant` before the
next section. This covers every accepted target value: `assistant`, `both`, and
`guardian`.

## 5. Test Funnel and Fail-Closed Reversal

Public mode is intentionally tested for the shortest possible interval. Arm a
shell trap before opening it. If the shell exits or is interrupted, the trap
persists `OP_REMOTE_PUBLIC=false`, rewrites the Serve policy, and stops or kills
the isolated tunnel as a final backstop.

```bash
FUNNEL_ARMED=0
close_test_funnel() {
  if [ "${FUNNEL_ARMED:-0}" != 1 ]; then return 0; fi
  local policy_closed=0
  local tunnel_stopped=0

  if OP_HOME="$TEST_HOME" bun -e '
import { applyRemoteAccess } from "./packages/lib/src/control-plane/remote-apply.ts";
import { patchSecretsEnvFile } from "./packages/lib/src/control-plane/secrets.ts";
const home = process.env.OP_HOME;
if (!home) throw new Error("missing isolated test home");
patchSecretsEnvFile(home, { OP_REMOTE_PUBLIC: "false" });
const result = applyRemoteAccess(home);
if (result.error) throw new Error(result.error);
' && grep -qx 'OP_REMOTE_PUBLIC=false' "$TEST_HOME/state/stack.env" &&
    node -e '
const c = require(process.argv[1]);
if (Object.values(c.AllowFunnel ?? {}).some((value) => value === true)) process.exit(1);
' "$TEST_HOME/state/remote/serve.json"; then
    policy_closed=1
  fi

  docker stop "$TUNNEL_CONTAINER" >/dev/null 2>&1 ||
    docker kill "$TUNNEL_CONTAINER" >/dev/null 2>&1 || true

  if TUNNEL_RUNNING="$(
    docker inspect --format '{{.State.Running}}' "$TUNNEL_CONTAINER" 2>/dev/null
  )"; then
    if [ "$TUNNEL_RUNNING" = false ]; then tunnel_stopped=1; fi
  elif TUNNEL_MATCHES="$(
    docker ps -a \
      --filter "label=com.docker.compose.project=$TEST_PROJECT" \
      --filter 'label=com.docker.compose.service=tunnel' \
      --format '{{.ID}}'
  )" && [ -z "$TUNNEL_MATCHES" ]; then
    tunnel_stopped=1
  fi

  if [ "$policy_closed" = 1 ] && [ "$tunnel_stopped" = 1 ]; then
    FUNNEL_ARMED=0
    return 0
  fi

  printf 'CRITICAL: Funnel closure could not be verified; use the Tailscale admin console now.\n' >&2
  return 1
}
trap 'close_test_funnel || true' EXIT
trap 'if ! close_test_funnel; then printf "CRITICAL: verify Funnel closure in the Tailscale admin console.\n" >&2; fi; exit 130' HUP INT TERM
FUNNEL_ARMED=1
```

Keep the target at `assistant`, turn `OP_REMOTE_PUBLIC` on, and save.

```bash
grep -x 'OP_REMOTE_TARGET=assistant' "$TEST_HOME/state/stack.env"
grep -x 'OP_REMOTE_PUBLIC=true' "$TEST_HOME/state/stack.env"
node -e '
const c = require(process.argv[1]);
const sameKeys = (value, expected) =>
  JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...expected].sort());
if (!sameKeys(c.TCP, ["443"])) process.exit(1);
if (!sameKeys(c.Web, ["${TS_CERT_DOMAIN}:443"])) process.exit(1);
if (!sameKeys(c.AllowFunnel, ["${TS_CERT_DOMAIN}:443"])) process.exit(1);
if (c.Web?.["${TS_CERT_DOMAIN}:443"]?.Handlers?.["/"]?.Proxy !== "http://assistant:3000") process.exit(1);
if (c.AllowFunnel?.["${TS_CERT_DOMAIN}:443"] !== true) process.exit(1);
' "$TEST_HOME/state/remote/serve.json"
```

On the non-tailnet device:

1. Open `https://<TS_FQDN>` over cellular or another non-tailnet network.
2. Confirm the OpenPalm login wall still protects the application.
3. Confirm a wrong password is rejected and `TEST_UI_PASSWORD` succeeds.
4. Sign out and use fresh private sessions on both devices. From the non-tailnet
   client, submit wrong passwords, honoring each backoff, until its actual
   `POST /api/auth/login` response is `429` with `Retry-After` at least 60.
   During that window, the tailnet client's login POST with `TEST_UI_PASSWORD`
   must return `200`; immediately afterward, the non-tailnet client must still
   receive `429`. Use browser Network tools or `curl`, and stop after this one
   bounded isolation check.

Required result: the URL is publicly reachable only while Funnel is enabled,
OpenPalm authentication remains enforced, and one remote client's failures do
not throttle or clear another client's login state.

Immediately turn public mode off and save. Verify `AllowFunnel` is explicitly
`false`, not missing, then test both devices again.

```bash
grep -x 'OP_REMOTE_TARGET=assistant' "$TEST_HOME/state/stack.env"
grep -x 'OP_REMOTE_PUBLIC=false' "$TEST_HOME/state/stack.env"
node -e '
const c = require(process.argv[1]);
const sameKeys = (value, expected) =>
  JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...expected].sort());
if (!sameKeys(c.TCP, ["443"])) process.exit(1);
if (!sameKeys(c.Web, ["${TS_CERT_DOMAIN}:443"])) process.exit(1);
if (!sameKeys(c.AllowFunnel, ["${TS_CERT_DOMAIN}:443"])) process.exit(1);
if (c.AllowFunnel?.["${TS_CERT_DOMAIN}:443"] !== false) process.exit(1);
' "$TEST_HOME/state/remote/serve.json"
```

Required results:

- The non-tailnet device can no longer connect.
- The signed-in tailnet device still can connect through private Serve.
- No restart, failed apply, or stale policy leaves Funnel reachable after the
  UI reports public mode off.

Only after the non-tailnet denial succeeds, disarm the emergency closure:

```bash
FUNNEL_ARMED=0
```

If the public-off save or denial check fails, record `FAIL` and run
`close_test_funnel` immediately. Do not proceed until the tunnel is stopped or
the non-tailnet URL is unreachable.

Test disable and re-enable once:

1. Disable Remote in the Admin UI.
2. Verify `state/remote/serve.json` still exists and its `TCP`, `Web`, and
   `AllowFunnel` objects are all empty.
3. Verify the tunnel stops and both remote URLs close.
4. Re-enable Remote and verify the same node ID and FQDN return without another
   login.
5. Disable Remote again before starting Paperclip.

The final disabled state passes only when the persisted policy is empty and the
URLs are closed. This normal-path check does not simulate a Docker stop failure;
stop-failure ordering remains an automated-test and code-review requirement.

### Test the Default Interactive Enrollment

The auth-key path above is deterministic, but a blank key and a logged AuthURL
are the documented default. Test that path separately:

1. Delete the now-disabled `openpalm-e2e-manual-addons` node from the Tailscale
   admin console so its hostname is available.
2. Reset only the generated tunnel identity and empty the delegated auth-key
   file.

```bash
test "$TEST_HOME" = "$REPO/.cache/manual-tailscale-paperclip"
if [[ "$TEST_HOME/data/tunnel" != "$REPO/.cache/manual-tailscale-paperclip/data/tunnel" ]]; then
  printf 'Refusing unsafe tunnel-data path\n' >&2
  exit 1
fi
rm -rf -- "$TEST_HOME/data/tunnel"
mkdir -m 700 "$TEST_HOME/data/tunnel"
: > "$TEST_HOME/state/secrets/ts_authkey"
chmod 600 "$TEST_HOME/state/secrets/ts_authkey"
op_test addon enable remote
test "$(docker inspect --format '{{.State.Status}}' "$TUNNEL_CONTAINER")" = running

AUTH_URL=''
PREAUTH_HEALTH_FAILURE=0
for _ in $(seq 1 30); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "$TUNNEL_CONTAINER")" = healthy ]; then
    printf 'FAIL: tunnel became healthy before interactive authorization\n' >&2
    PREAUTH_HEALTH_FAILURE=1
  fi
  TUNNEL_LOGS="$(op_test logs tunnel 2>&1 || true)"
  AUTH_URL="$(
    printf '%s\n' "$TUNNEL_LOGS" |
      sed -n 's|.*\(https://login\.tailscale\.com/[^[:space:]]*\).*|\1|p' |
      tail -n 1
  )"
  if [ -n "$AUTH_URL" ]; then break; fi
  sleep 2
done
test -n "$AUTH_URL"
test "$PREAUTH_HEALTH_FAILURE" = 0
printf 'Open this one-time AuthURL locally: %s\n' "$AUTH_URL"
```

3. Open the AuthURL from the tunnel logs promptly and authorize only this test
   node.
4. Run `unset AUTH_URL TUNNEL_LOGS`, then `op_test start tunnel` after
   authorization; it must reach healthy.
5. Open the private Serve URL from the tailnet device and verify the same HTTPS
   and OpenPalm login behavior as before.
6. Disable Remote, verify the empty policy again, and delete the interactive
   test node from the Tailscale admin console.

Required result: an operator can discover and complete first-time interactive
login from `openpalm logs tunnel` without putting a key in any OpenPalm file.
The tunnel must not report healthy before it has a tailnet IP.

## 6. Configure and Enable Paperclip

This is a COLD START, and that is the point of the step. Paperclip initialises
an embedded PostgreSQL cluster the first time it runs, and `initdb` runs ONLY
against an empty data directory — an instance whose cluster already exists
never executes that path again. A cold start broke for every new install
between the digest bump and 0.13.0-beta.25 while this lane reported a pass,
because the cluster under test had been created by an earlier, locally patched
image and the step only ever re-started it. Prove the directory is absent
first, and prove this run created it.

Confirm there is no pre-existing cluster:

```bash
test ! -e "$TEST_HOME/data/paperclip/instances/default/db"
```

`FAIL` if that path exists. Do not delete it and retry — its presence means the
launcher did not start from a clean home, so nothing after this point is a cold
start and the whole run is invalid.

In **Host > Addons > Paperclip > Configure**:

1. Set `OP_PAPERCLIP_PORT` to `3940`.
2. Keep `OP_TELEMETRY_DISABLED=1`.
3. Save, then click **Enable**. Do not run a CLI command first.

Wait up to three minutes for the first pull and embedded database startup:

```bash
docker inspect --format '{{.State.Health.Status}}' "$PAPERCLIP_CONTAINER"
curl -fsS "http://127.0.0.1:$TEST_PAPERCLIP_PORT/api/health"
op_test addon list
```

Required result: the Admin enable action starts Paperclip, it becomes healthy,
and the loopback health endpoint responds. An enabled badge with no running
container is `FAIL`.

Prove the cluster was created by THIS run, from nothing:

```bash
test -s "$TEST_HOME/data/paperclip/instances/default/db/PG_VERSION"
# Assert the init failure is ABSENT. `grep -v` would pass on any one
# non-matching line and never catch it.
! docker logs "$PAPERCLIP_CONTAINER" 2>&1 | grep -qi 'Postgres init script exited with code 1'
```

Prove the image under test is the pinned upstream one, not a local rebuild:

```bash
PINNED_PAPERCLIP_DIGEST="$(
  grep -oE 'ghcr\.io/paperclipai/paperclip:[^@]+@sha256:[0-9a-f]+' \
    "$REPO/packages/skeleton/system/stack/services.compose.yml" | head -1 | sed 's/.*@//'
)"
test -n "$PINNED_PAPERCLIP_DIGEST"
# RepoDigests, NOT the image id: the pin is a REGISTRY manifest digest, while
# `.Image`/`.Id` is the local config digest. The two coincide under the
# containerd image store and diverge under the classic one, so comparing ids
# passes or fails depending on the operator's storage driver rather than on
# what is running. A locally built image has no RepoDigest for this repo at
# all, which is exactly the substitution this check exists to catch.
docker image inspect "$(docker inspect --format '{{.Image}}' "$PAPERCLIP_CONTAINER")" \
  --format '{{json .RepoDigests}}' | grep -q "$PINNED_PAPERCLIP_DIGEST"
```

`FAIL` on a mismatch. A locally built or patched paperclip image passes the
health check while telling you nothing about what ships — this is exactly how
the cold-start defect above survived a full acceptance run.

If the enable fails, the run has `FAIL`ed and the release is blocked. There is
no continue-past for this step: disabling and re-enabling, running `op_test
start paperclip`, deleting the data directory, or substituting a patched image
all convert a real cold-start defect into a green run. Record the failure with
`docker logs "$PAPERCLIP_CONTAINER"` attached and stop.

Note that Paperclip's own logs are not sufficient evidence on their own here.
Its embedded-postgres library forwards only `initdb`'s stdout and discards
stderr, so a locale or permission failure surfaces as nothing more than two
banner lines and "The data directory might already exist". To see the real
error, re-run `initdb` by hand with stderr attached inside the container.

Inspect the OpenPalm boundary without printing secret values:

```bash
test "$(stat -c '%a' "$TEST_HOME/state/env")" = 700
test "$(stat -c '%a' "$TEST_HOME/state/env/paperclip.env")" = 600
awk -F= 'NF {print $1}' "$TEST_HOME/state/env/paperclip.env" | sort
docker port "$PAPERCLIP_CONTAINER" 3100/tcp
docker inspect --format '{{.Config.User}}' "$PAPERCLIP_CONTAINER"
docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
  "$PAPERCLIP_CONTAINER"
docker inspect --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  "$PAPERCLIP_CONTAINER"
docker exec "$PAPERCLIP_CONTAINER" sh -lc '
  test "$PAPERCLIP_DEPLOYMENT_MODE" = authenticated &&
  test "$PAPERCLIP_DEPLOYMENT_EXPOSURE" = private &&
  test "$PAPERCLIP_TELEMETRY_DISABLED" = 1 &&
  test "$DO_NOT_TRACK" = 1
'
```

Required results:

- `paperclip.env` contains exactly `BETTER_AUTH_SECRET` and
  `PAPERCLIP_AGENT_JWT_SECRET`, with directory/file modes `0700` and
  `0600`.
- Paperclip binds only `127.0.0.1:3940`, runs as the configured non-root UID/GID,
  and joins only this project's `addon_net`.
- Its mounts are limited to `/paperclip`, managed and user OpenCode config,
  Paperclip AKM config/state, and the shared `/stash`. There are no per-service
  overmounts on `/stash`. The user OpenCode config is read-only; mutable runtime
  config and plugin dependencies come from `cache/paperclip-opencode/runtime`.
- Paperclip sees the shared stash exactly as the assistant does, including
  `knowledge/env/user.env` and `knowledge/secrets/auth.json`; delegated
  credentials are not there. It has no `/work`, no `state/secrets/` mount, no
  assistant or Guardian credential, no Docker socket, and no `assistant_net` or
  `portal_net` access.
- Authenticated/private deployment and telemetry opt-out values are active.
- `http://<host-LAN-address>:3940` is unreachable from a second device.
- The Tailscale URL exposes no Paperclip port. The Remote addon supports only
  assistant and Guardian targets.

## 7. Complete First-Admin Bootstrap

Open `http://127.0.0.1:3940` in a private browser window. Container health alone
is not acceptance: the UI must provide a usable route to create the first admin.

If the UI instructs you to run a bootstrap command, run the equivalent inside
the pinned container:

```bash
docker exec -w /app "$PAPERCLIP_CONTAINER" \
  pnpm paperclipai auth bootstrap-ceo --data-dir /paperclip \
  --base-url "http://localhost:$TEST_PAPERCLIP_PORT"
```

Required result: the documented first-run path produces a one-time local invite
and allows the first admin to be claimed. A healthy server that remains at
`bootstrap_pending`, or a bootstrap command that reports that onboarding/config
is missing, is `FAIL`.

To continue the remaining functional tests after that failure only, initialize
the pinned upstream runtime explicitly:

```bash
docker exec -it -w /app "$PAPERCLIP_CONTAINER" \
  pnpm paperclipai onboard --data-dir /paperclip
```

Choose **Quickstart** and decline starting a second Paperclip server. Then:

```bash
op_test restart paperclip
op_test start paperclip
docker exec -w /app "$PAPERCLIP_CONTAINER" \
  pnpm paperclipai auth bootstrap-ceo --data-dir /paperclip \
  --base-url "http://localhost:$TEST_PAPERCLIP_PORT"
```

Open the invite locally, create a test-only admin account, and discard the
invite. Verify readiness without recording account or invite values:

```bash
curl -fsS "http://127.0.0.1:$TEST_PAPERCLIP_PORT/api/health"
docker exec -w /app "$PAPERCLIP_CONTAINER" \
  pnpm paperclipai doctor --data-dir /paperclip
```

Required results:

- Health reports `deploymentMode: authenticated`,
  `deploymentExposure: private`, `authReady: true`, and
  `bootstrapStatus: ready`.
- A new private/incognito window cannot reach the board without signing in.
- Paperclip's own doctor reports a valid config, database, auth, agent JWT,
  storage, and secrets setup.

## 8. Exercise a Real Paperclip Run

Initialize the exact-pinned OpenCode config dependencies, then verify the
selected adapter and AKM runtimes:

```bash
docker exec -w /tmp "$PAPERCLIP_CONTAINER" opencode debug config >/dev/null

for tool in curl git node pnpm claude codex opencode bun akm; do
  docker exec "$PAPERCLIP_CONTAINER" sh -c 'command -v "$1" >/dev/null' sh "$tool" \
    && printf 'present  %s\n' "$tool" \
    || printf 'MISSING  %s\n' "$tool"
done

test "$(docker exec "$PAPERCLIP_CONTAINER" akm --version)" = 0.9.8-beta.3
docker exec "$PAPERCLIP_CONTAINER" akm --format json -q info
```

Every listed command must resolve. `bun` is the managed launcher for the Bun
runtime embedded in Paperclip's pinned OpenCode binary; it is not downloaded at
container startup. A healthy web server with a missing selected adapter or AKM
dependency is `FAIL`.

Seed non-sensitive AKM acceptance assets. The env and secret marker values are
only leak canaries; never print them in evidence:

```bash
mkdir -p "$TEST_HOME/knowledge/knowledge"
cat > "$TEST_HOME/knowledge/knowledge/paperclip-manual-acceptance.md" <<'EOF'
---
description: Disposable Paperclip AKM integration acceptance marker.
---

# Paperclip AKM acceptance

The expected knowledge marker is PAPERCLIP_AKM_KNOWLEDGE_OK.
EOF
printf 'PAPERCLIP_AKM_ENV_CANARY=paperclip-env-value-must-not-be-printed\n' \
  > "$TEST_HOME/knowledge/env/user.env"
printf 'paperclip-secret-value-must-not-be-printed\n' \
  > "$TEST_HOME/knowledge/secrets/manual-acceptance.txt"
chmod 600 \
  "$TEST_HOME/knowledge/env/user.env" \
  "$TEST_HOME/knowledge/secrets/manual-acceptance.txt"

docker exec "$PAPERCLIP_CONTAINER" akm index
docker exec "$PAPERCLIP_CONTAINER" akm search \
  'Paperclip AKM integration acceptance marker'
```

Create an isolated local workspace for a credential-backed agent run:

```bash
docker exec "$PAPERCLIP_CONTAINER" mkdir -p /paperclip/manual-acceptance
```

1. Create a company named `OpenPalm manual acceptance` and a simple top-level
   goal in the Paperclip UI.
2. Create a project named `Manual acceptance` with **Local folder** set to
   `/paperclip/manual-acceptance`.
3. Create a `backlog` issue in that project instructing the agent to add a
   comment containing `PAPERCLIP_LOCAL_OK`, then mark the issue complete through
   the Paperclip API with a separate status-only PATCH and no second comment.
   Also require it to call `akm_search` and `akm_show`, and to resolve the env
   key and the secret through the `akm` CLI (`akm env run user -- <cmd>` and
   `akm secret`); it may report key/ref names and the secret path,
   but must never report either canary value.
4. Store a disposable provider credential through Paperclip's own encrypted
   secret/agent configuration. Do not put it in OpenPalm's assistant auth file,
   `stack.env`, evidence, or shell history.
5. Create and approve an agent using `opencode_local`. Record the model,
   provider environment-key name, and small test budget. The model must use
   `provider/model` form. The project supplies the working directory; do not
   invent an agent-level `cwd` field that the pinned create form does not show.
6. Run the agent form's **Test environment** action and require a pass before
   assigning work.
7. Move the issue to `todo` and assign it to the agent. Observe the one
   assignment-triggered run; invoke a heartbeat manually only if no run was
   queued, never in addition to an already queued run.
8. Inspect the streamed run log and the resulting issue activity.

Use the selected OpenCode provider's normal credential and record the provider,
credential key name, and model without recording its value.

Required result: Paperclip injects an authenticated `PAPERCLIP_API_KEY`, the
local CLI starts, reads its assigned issue, posts the marker comment, completes
the issue, and reports one run/cost without exposing its credential. A run that
continues without an API key, runs twice from one assignment, or cannot use the
project's local folder is `FAIL`. The same run must complete both AKM tool
calls and both CLI lookups, find `PAPERCLIP_AKM_KNOWLEDGE_OK`, list the env key and secret ref/path,
and contain neither `paperclip-env-value-must-not-be-printed` nor
`paperclip-secret-value-must-not-be-printed` in model or tool output. The run
must not enumerate the process environment or log the injected Paperclip API
key or either long-lived Paperclip server secret.

## 9. Verify Paperclip Persistence and Reconfiguration

Capture only a hash of the OpenPalm-managed Paperclip env, then disable and
re-enable the addon through the Admin UI:

```bash
PAPERCLIP_ENV_HASH_BEFORE="$(sha256sum "$TEST_HOME/state/env/paperclip.env" | cut -d' ' -f1)"
export PAPERCLIP_ENV_HASH_BEFORE
```

Required results:

- Disable stops Paperclip but does not remove `data/paperclip` or
  `state/env/paperclip.env`.
- Re-enable starts the service without a CLI fallback.
- The test account can still sign in, and the company, project, issue, marker
  comment, and run survive.
- The env-file hash is unchanged; re-enable does not rotate sessions or secret
  values.

Verify the hash:

```bash
test "$PAPERCLIP_ENV_HASH_BEFORE" = \
  "$(sha256sum "$TEST_HOME/state/env/paperclip.env" | cut -d' ' -f1)"
```

If Admin re-enable records Paperclip as enabled but does not start it, retain
the required `FAIL`, run `op_test start paperclip`, and complete the persistence
checks before changing the port.

While Paperclip is enabled, change `OP_PAPERCLIP_PORT` to `3941`, save, and run:

```bash
op_test start paperclip
curl -fsS http://127.0.0.1:3941/api/health
if ! OLD_PAPERCLIP_LISTENERS="$(ss -H -ltn 'sport = :3940')"; then
  record_failure 'the old Paperclip port could not be inspected'
elif [[ -n "$OLD_PAPERCLIP_LISTENERS" ]]; then
  record_failure 'the old Paperclip port remains open'
fi
```

Required result: an explicit apply recreates the publication on the new
loopback port; the old port closes. A plain process restart is not sufficient
to change Docker port publication.

Create one logical database backup through the command actually available in
the upstream image:

```bash
docker exec -w /app "$PAPERCLIP_CONTAINER" \
  pnpm paperclipai db:backup --data-dir /paperclip --json
```

Required result: the command reports a successful backup under the Paperclip
data tree. Remember that OpenPalm lifecycle safety backups exclude
`data/paperclip` and, with it, `state/env/paperclip.env`; this test does not
change that operator responsibility.

## 10. Clean Up Fail-Closed

Close remote exposure first, before removing credentials or containers:

1. Confirm Remote public mode is off.
2. Disable Remote and verify `serve.json` contains three empty objects.
3. Disable Paperclip.
4. Delete the test node from the Tailscale admin console and revoke any unused
   test key.
5. Revoke the disposable model-provider credential at the provider.
6. Remove `Manual Tailscale device` from the second device's saved Guardian
   connections.
7. Delete the test password-manager entry and any browser-saved test login.

```bash
FUNNEL_ARMED=1
if ! close_test_funnel; then
  printf 'Keep the closure traps armed and stop cleanup until Funnel is closed.\n' >&2
  exit 1
fi
trap - EXIT HUP INT TERM
```

Stop and remove only the isolated Compose project:

```bash
op_test stop

if ! docker compose --project-directory "$REPO" \
    -f "$TEST_HOME/system/stack/core.compose.yml" \
    -f "$TEST_HOME/system/stack/services.compose.yml" \
    -f "$TEST_HOME/system/stack/portals.compose.yml" \
    -f "$TEST_HOME/config/stack/custom.compose.yml" \
    -f "$REPO/compose.dev.yml" \
    --env-file "$TEST_HOME/state/stack.env" \
    --project-name "$TEST_PROJECT" \
    --profile addon.api \
    --profile addon.remote \
    --profile addon.paperclip \
    down --remove-orphans --volumes; then
  printf 'Refusing to remove the test home after Compose teardown failed.\n' >&2
  exit 1
fi

if ! REMAINING_TEST_CONTAINERS="$(
  docker ps -a --filter "label=com.docker.compose.project=$TEST_PROJECT" --format '{{.ID}}'
)" || ! REMAINING_TEST_NETWORKS="$(
  docker network ls --filter "label=com.docker.compose.project=$TEST_PROJECT" --format '{{.ID}}'
)" || ! REMAINING_TEST_VOLUMES="$(
  docker volume ls --filter "label=com.docker.compose.project=$TEST_PROJECT" --format '{{.Name}}'
)"; then
  printf 'Could not verify project-resource teardown.\n' >&2
  exit 1
fi
if [[ -n "$REMAINING_TEST_CONTAINERS" || -n "$REMAINING_TEST_NETWORKS" ||
      -n "$REMAINING_TEST_VOLUMES" ]]; then
  printf 'Refusing to remove the test home while project resources remain.\n' >&2
  exit 1
fi
```

Stop the captured Admin supervisor. Inspect both captured processes before
signalling the supervisor; never use a broad `pkill` pattern:

```bash
ps -fp "$ADMIN_SUPERVISOR_PID" "$ADMIN_CHILD_PID"
if [[ "$ADMIN_SUPERVISOR_PID" -le 1 ||
      "$(ps -o lstart= -p "$ADMIN_SUPERVISOR_PID")" != "$ADMIN_SUPERVISOR_START" ||
      "$(ps -o args= -p "$ADMIN_SUPERVISOR_PID")" != "$ADMIN_SUPERVISOR_COMMAND" ||
      "$(ps -o ppid= -p "$ADMIN_CHILD_PID" | tr -d ' ')" != "$ADMIN_SUPERVISOR_PID" ]]; then
  printf 'Refusing to signal an Admin process whose identity changed.\n' >&2
  exit 1
fi
kill "$ADMIN_SUPERVISOR_PID"
for _ in $(seq 1 20); do
  if ! kill -0 "$ADMIN_SUPERVISOR_PID" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$ADMIN_SUPERVISOR_PID" 2>/dev/null; then
  printf 'Admin supervisor did not stop.\n' >&2
  exit 1
fi
if ! ADMIN_LISTENERS="$(ss -H -ltn "sport = :$TEST_ADMIN_PORT")"; then
  printf 'Could not verify that the Admin port closed.\n' >&2
  exit 1
fi
if [[ -n "$ADMIN_LISTENERS" ]]; then
  printf 'Admin port remains open after stopping its supervisor.\n' >&2
  exit 1
fi
```

After collecting non-secret evidence, remove only the generated test home:

```bash
if [[ "$TEST_HOME" != "$REPO/.cache/manual-tailscale-paperclip" ]]; then
  printf 'Refusing unsafe test-home deletion: %s\n' "$TEST_HOME" >&2
  exit 1
fi
if ! rm -rf -- "$TEST_HOME"; then
  printf 'Test-home removal failed; inspect it without broadening the path.\n' >&2
  exit 1
fi
test ! -e "$TEST_HOME"
if ! PROD_CONTAINERS_AFTER="$(
  docker ps -a --filter "label=com.docker.compose.project=$PROD_PROJECT" \
    --format '{{.ID}}|{{.Names}}|{{.Ports}}' | sort
)"; then
  printf 'Could not inspect production containers after acceptance.\n' >&2
  exit 1
fi
test "$PROD_CONTAINERS_BEFORE" = "$PROD_CONTAINERS_AFTER"
if ! PROD_HEALTH_AFTER="$(capture_project_health "$PROD_PROJECT" | sort)"; then
  printf 'Could not inspect production health after acceptance.\n' >&2
  exit 1
fi
test "$PROD_HEALTH_BEFORE" = "$PROD_HEALTH_AFTER"
if [ -n "$PROD_HEALTH_AFTER" ] &&
  printf '%s\n' "$PROD_HEALTH_AFTER" |
    grep -Evq '\|status=running\|health=(healthy|none)$'; then
  printf 'Production is not healthy after manual acceptance\n' >&2
  exit 1
fi
if ! PROD_STACK_ENV_AFTER="$(
  if [[ -f "$PROD_HOME/state/stack.env" ]]; then
    sha256sum "$PROD_HOME/state/stack.env" | cut -d' ' -f1
  else
    printf 'missing\n'
  fi
)"; then
  printf 'Could not hash production stack.env after acceptance.\n' >&2
  exit 1
fi
test "$PROD_STACK_ENV_BEFORE" = "$PROD_STACK_ENV_AFTER"
if ! FINAL_TEST_CONTAINERS="$(
  docker ps -a --filter "label=com.docker.compose.project=$TEST_PROJECT" --format '{{.ID}}'
)" || ! FINAL_TEST_NETWORKS="$(
  docker network ls --filter "label=com.docker.compose.project=$TEST_PROJECT" --format '{{.ID}}'
)" || ! FINAL_TEST_VOLUMES="$(
  docker volume ls --filter "label=com.docker.compose.project=$TEST_PROJECT" --format '{{.Name}}'
)" || ! FINAL_ADMIN_LISTENERS="$(ss -H -ltn "sport = :$TEST_ADMIN_PORT")"; then
  printf 'Could not perform final isolated-resource inspection.\n' >&2
  exit 1
fi
if [[ -n "$FINAL_TEST_CONTAINERS" || -n "$FINAL_TEST_NETWORKS" ||
      -n "$FINAL_TEST_VOLUMES" || -n "$FINAL_ADMIN_LISTENERS" ]]; then
  printf 'FAIL: isolated resources remain after cleanup.\n' >&2
  exit 1
fi
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
if ! FINAL_GIT_STATUS="$(git status --porcelain)"; then
  printf 'Could not inspect the final candidate worktree.\n' >&2
  exit 1
fi
if [[ -n "$FINAL_GIT_STATUS" ]]; then
  printf 'FAIL: candidate checkout changed during manual acceptance.\n' >&2
  exit 1
fi
if (( MANUAL_COMMAND_FAILURES != 0 )); then
  printf 'FAIL: %d shell assertion(s) failed during manual acceptance.\n' \
    "$MANUAL_COMMAND_FAILURES" >&2
  exit 1
fi
trap - ERR
unset TEST_UI_PASSWORD
printf 'Isolated cleanup verified.\n'
```

Final required results:

- No container or Compose project named `openpalm-e2e-manual-addons` remains.
- The test Admin port is closed.
- The disposable Tailscale key/node, model-provider credential, saved Guardian
  connection, and password-manager entry are gone.
- The captured production project containers and `state/stack.env` are
  unchanged and healthy.
- The candidate SHA is unchanged and its worktree is clean.
