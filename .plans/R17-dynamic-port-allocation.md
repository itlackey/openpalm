# R17: Dynamic Port Allocation for Docker Tests

## Problem

Two Docker-based test files use hardcoded host ports when exposing container services.
The ports are hand-coordinated to avoid collisions with each other and with a running dev
stack, but this approach is fragile:

- **Parallel CI:** If two CI jobs (or two developers) run Docker tests on the same host
  simultaneously, the hardcoded ports collide and the second run fails with
  `address already in use`.
- **Manual coordination:** Adding a new Docker test suite requires the author to pick
  yet another unused port and document the conflict-avoidance convention.
- **Dev stack collision:** The chosen ports (18200, 18280, 18300) avoid the default dev
  ports (8100, 8080), but only by convention -- nothing enforces this at runtime.

The non-Docker integration tests (`channel-gateway.integration.test.ts`) already
demonstrate the correct pattern: `Bun.serve({ port: 0 })` lets the OS assign an
ephemeral port. Docker Compose supports the equivalent via `"0:8100"` port syntax, which
publishes the container port on a random host port.

---

## Inventory of Hardcoded Ports

### Docker test files (in scope for this change)

| File | Line | Constant | Value | Used for |
|---|---|---|---|---|
| `test/docker/docker-stack.docker.ts` | 97 | `ADMIN_PORT` | `18200` | Host port mapped to admin container `:8100` |
| `test/docker/docker-stack.docker.ts` | 98 | `GATEWAY_PORT` | `18280` | Host port mapped to gateway container `:8080` |
| `test/docker/docker-stack.docker.ts` | 179 | compose overlay | `"${ADMIN_PORT}:8100"` | Port mapping in generated YAML |
| `test/docker/docker-stack.docker.ts` | 196 | compose overlay | `"${GATEWAY_PORT}:8080"` | Port mapping in generated YAML |
| `test/install-e2e/happy-path.docker.ts` | 25 | `ADMIN_PORT` | `18300` | Host port mapped to admin container `:8100` |
| `test/install-e2e/happy-path.docker.ts` | 189 | compose overlay | `"${ADMIN_PORT}:8100"` | Port mapping in generated YAML |

### Integration tests targeting a live dev stack (out of scope)

These tests connect to an already-running dev stack at fixed ports. They are guarded by
`OPENPALM_INTEGRATION=1` and do not start their own containers, so dynamic allocation
does not apply to them. Listed here for completeness:

| File | Line | Port | Note |
|---|---|---|---|
| `test/integration/container-health.integration.test.ts` | 13, 24, 31, 40 | 8100, 4096, 8765 | Targets running dev stack |
| `test/integration/admin-auth.integration.test.ts` | 8 | 8100 | Targets running dev stack |
| `test/integration/admin-health-check.integration.test.ts` | 8 | 8100 | Targets running dev stack |
| `test/contracts/setup-wizard-gate.contract.test.ts` | 6 | 8100 | Targets running dev stack |

### Tests already using dynamic ports (no change needed)

| File | Pattern | Note |
|---|---|---|
| `test/integration/channel-gateway.integration.test.ts` | `Bun.serve({ port: 0 })` | Already correct -- OS-assigned ports |

---

## Proposed Strategy

### Use Docker Compose `"0:<container_port>"` syntax

Docker Compose supports `"0:8100"` as a port mapping, which tells Docker to pick an
available ephemeral host port and map it to container port 8100. After `docker compose up`,
the assigned port can be discovered via `docker compose port <service> <container_port>`.

This is the simplest approach because:
1. No external dependencies or custom port-allocator code needed.
2. Docker handles the OS-level port allocation atomically.
3. The `docker compose port` command is the official way to retrieve the mapped port.
4. It mirrors the `Bun.serve({ port: 0 })` pattern already used in non-Docker tests.

### Port discovery helper

Create a small helper function (shared between both test files) that calls
`docker compose port <service> <container_port>` and parses the output to extract the
assigned host port. The output format is `0.0.0.0:<host_port>` or
`127.0.0.1:<host_port>`.

---

## Step-by-Step Implementation

### Step 1: Create a shared test helper module

Create `test/helpers/docker-compose-port.ts` with a function that resolves the dynamically
assigned host port for a given service and container port.

```typescript
/**
 * Resolves the host port assigned by Docker Compose for a service's container port.
 *
 * Requires the compose project to be running with port "0:<container_port>" mappings.
 * Calls `docker compose port <service> <container_port>` and parses the output.
 */
export async function resolveHostPort(
  composeArgs: string[],
  service: string,
  containerPort: number,
  cwd: string,
): Promise<number> {
  const proc = Bun.spawn(
    ["docker", "compose", ...composeArgs, "port", service, String(containerPort)],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  if (exitCode !== 0) {
    throw new Error(
      `Failed to resolve port for ${service}:${containerPort}: ${stderr}`,
    );
  }

  // Output format: "0.0.0.0:12345" or "127.0.0.1:12345" or "[::]:12345"
  const match = stdout.match(/:(\d+)$/);
  if (!match) {
    throw new Error(
      `Unexpected docker compose port output for ${service}:${containerPort}: "${stdout}"`,
    );
  }

  return Number(match[1]);
}
```

### Step 2: Modify `test/docker/docker-stack.docker.ts`

**2a. Remove hardcoded port constants (lines 96-98):**

Replace:
```typescript
// Use non-conflicting ports so we don't clash with a running dev stack
const ADMIN_PORT = 18200;
const GATEWAY_PORT = 18280;
```

With:
```typescript
// Ports are dynamically assigned by Docker (via "0:<container_port>" mapping)
// and discovered after container startup using `docker compose port`.
let ADMIN_PORT: number;
let GATEWAY_PORT: number;
```

**2b. Update the compose overlay template (lines 178-179, 195-196):**

Change the port mappings in the generated YAML from:
```yaml
    ports:
      - "${ADMIN_PORT}:8100"
```
to:
```yaml
    ports:
      - "0:8100"
```

And from:
```yaml
    ports:
      - "${GATEWAY_PORT}:8080"
```
to:
```yaml
    ports:
      - "0:8080"
```

Since `ADMIN_PORT` and `GATEWAY_PORT` are no longer interpolated into the overlay string,
remove the template literal references to them.

**2c. Add port discovery after containers start (after line 217, before the health-check wait):**

After the `composeRun("up", ...)` succeeds, resolve the assigned ports:

```typescript
import { resolveHostPort } from "../helpers/docker-compose-port.ts";

// ... inside beforeAll, after containers start:

// Discover the dynamically assigned host ports
const composeBaseArgs = [
  "-p", PROJECT_NAME, "--env-file", envFilePath,
  "-f", COMPOSE_BASE, "-f", composeTestFile, "--project-directory", REPO_ROOT,
];
ADMIN_PORT = await resolveHostPort(composeBaseArgs, "admin", 8100, REPO_ROOT);
GATEWAY_PORT = await resolveHostPort(composeBaseArgs, "gateway", 8080, REPO_ROOT);
console.log(`[docker-test] Admin on port ${ADMIN_PORT}, Gateway on port ${GATEWAY_PORT}`);
```

**2d. Extract compose args to avoid duplication:**

The compose args array (`["-p", PROJECT_NAME, "--env-file", ...]`) is already used in the
`compose()` function. Extract it to a shared variable so both `compose()` and
`resolveHostPort()` use the same args. Alternatively, create a helper that returns the
args array and use it in both places. The simplest approach is to store the args in a
module-level `let` variable that is set in `beforeAll` (since `envFilePath` is also set
there).

### Step 3: Modify `test/install-e2e/happy-path.docker.ts`

**3a. Remove hardcoded port constant (line 25):**

Replace:
```typescript
const ADMIN_PORT = 18300; // Non-conflicting with docker-stack tests (18200)
```

With:
```typescript
// Port is dynamically assigned by Docker (via "0:8100" mapping)
// and discovered after container startup using `docker compose port`.
let ADMIN_PORT: number;
```

**3b. Update the compose overlay template (line 189):**

Change:
```yaml
    ports:
      - "${ADMIN_PORT}:8100"
```
to:
```yaml
    ports:
      - "0:8100"
```

**3c. Add port discovery after the container starts (after line 254, before health-check wait):**

```typescript
import { resolveHostPort } from "../helpers/docker-compose-port.ts";

// ... inside beforeAll, after admin starts:

// Discover the dynamically assigned host port
const composeBaseArgs = [
  "-p", PROJECT_NAME, "--env-file", envFilePath,
  "-f", composeTestFile, "--project-directory", REPO_ROOT,
];
ADMIN_PORT = await resolveHostPort(composeBaseArgs, "admin", 8100, REPO_ROOT);
console.log(`[install-e2e] Admin on port ${ADMIN_PORT}`);
```

Note: this file's `compose()` function only uses `-f composeTestFile` (not the base
compose file), so the args for `resolveHostPort` should match.

### Step 4: Remove the hand-coordination comment

Delete the comment on line 25 of `happy-path.docker.ts` that says
`// Non-conflicting with docker-stack tests (18200)` and the comment on line 96 of
`docker-stack.docker.ts` that says
`// Use non-conflicting ports so we don't clash with a running dev stack`.
Replace with comments explaining the dynamic allocation approach.

---

## Files to Modify/Create

| File | Action |
|---|---|
| `test/helpers/docker-compose-port.ts` | **Create** -- shared port-resolution helper |
| `test/docker/docker-stack.docker.ts` | **Modify** -- remove hardcoded ports, use `"0:<port>"` in overlay, add port discovery |
| `test/install-e2e/happy-path.docker.ts` | **Modify** -- remove hardcoded port, use `"0:8100"` in overlay, add port discovery |

No other files need changes. The integration tests that target a live dev stack
(`container-health`, `admin-auth`, `admin-health-check`, `setup-wizard-gate`) use fixed
ports intentionally because they connect to a pre-existing stack -- they do not start
containers and are not in scope for this change.

---

## Verification Steps

1. **Unit-test the helper in isolation:**
   ```bash
   # Start a simple container with a dynamic port to test the helper
   docker run -d --name port-test -p 0:80 nginx:alpine
   docker compose port  # verify the docker CLI produces expected output format
   docker rm -f port-test
   ```

2. **Run the Docker stack tests:**
   ```bash
   OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test test/docker/docker-stack.docker.ts
   ```
   Verify:
   - The log output shows dynamically assigned ports (not 18200/18280)
   - All tests pass
   - Ports are different on each run

3. **Run the install E2E tests:**
   ```bash
   OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test test/install-e2e/happy-path.docker.ts
   ```
   Verify:
   - The log output shows a dynamically assigned port (not 18300)
   - All tests pass

4. **Parallel collision test:**
   Run both test suites simultaneously in separate terminals:
   ```bash
   # Terminal 1
   OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test test/docker/docker-stack.docker.ts

   # Terminal 2
   OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test test/install-e2e/happy-path.docker.ts
   ```
   Both should pass without port conflicts. Previously this would fail because both
   suites used nearby hardcoded ports.

5. **Confirm no hardcoded test ports remain:**
   ```bash
   grep -rn "18200\|18280\|18300" test/ --include="*.ts"
   ```
   Expected: no results.

6. **Confirm non-Docker integration tests are unaffected:**
   ```bash
   bun test test/integration/channel-gateway.integration.test.ts
   ```

---

## Risk Assessment

**Risk: Low.**

- The `docker compose port` command is stable Docker CLI functionality, available since
  Docker Compose V2.
- The `"0:<port>"` syntax for random host port assignment is a standard Docker feature.
- The only behavioral change is that ports are OS-assigned instead of hardcoded. All test
  logic (health checks, API calls, assertions) remains identical -- only the port values
  change.
- The helper is small, deterministic, and has a single responsibility.
- If `docker compose port` fails (e.g., container not running), it throws a clear error
  that surfaces in the test output, which is the same failure mode as the current approach
  when a port is already in use.

---

## Notes

- The `docker compose port` command requires the service to be running. The current test
  flow already ensures this: containers are started with `docker compose up -d`, then
  health is checked. Port resolution is inserted between these two steps.
- Docker assigns ephemeral ports from the OS range (typically 32768-60999 on Linux). This
  range has tens of thousands of ports, so collisions between concurrent test runs are
  effectively impossible.
- The `channel-gateway.integration.test.ts` file already uses `Bun.serve({ port: 0 })`
  correctly. This change brings the Docker-based tests in line with that established
  pattern.
