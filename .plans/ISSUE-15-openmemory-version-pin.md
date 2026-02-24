# ISSUE-15: OpenMemory Images Not Version-Pinned

**Severity:** MEDIUM  
**Priority:** Nice to Have  
**Effort:** S — change two image tags

## Problem Summary

`packages/lib/src/embedded/state/docker-compose.yml:49` and `:70` use `mem0/openmemory-mcp:latest` and `mem0/openmemory-ui:latest` with a `# TODO: pin version` comment. Using `latest` makes installs non-reproducible and vulnerable to upstream breaking changes.

## Implementation Steps

### Step 1: Determine the current tested versions

Before pinning, verify which versions are currently tested and working:

```bash
docker pull mem0/openmemory-mcp:latest
docker image inspect mem0/openmemory-mcp:latest --format '{{.RepoDigests}}'

docker pull mem0/openmemory-ui:latest
docker image inspect mem0/openmemory-ui:latest --format '{{.RepoDigests}}'
```

Also check Docker Hub for available tags:
- https://hub.docker.com/r/mem0/openmemory-mcp/tags
- https://hub.docker.com/r/mem0/openmemory-ui/tags

Pin to the latest stable tag available at the time of the fix.

### Step 2: Pin openmemory-mcp image version

**File:** `packages/lib/src/embedded/state/docker-compose.yml:48-49`

Change:
```yaml
  openmemory:
    # TODO: Pin to specific version tag (e.g., mem0/openmemory-mcp:v0.1.0) when stable releases are published
    image: mem0/openmemory-mcp:latest
```

to (using the actual version found in Step 1):
```yaml
  openmemory:
    # Pinned 2026-02-24 — update deliberately after testing newer versions
    image: mem0/openmemory-mcp:<VERSION>
```

### Step 3: Pin openmemory-ui image version

**File:** `packages/lib/src/embedded/state/docker-compose.yml:69-71`

Change:
```yaml
  openmemory-ui:
    # TODO: Pin to specific version tag (e.g., mem0/openmemory-ui:v0.1.0) when stable releases are published
    image: mem0/openmemory-ui:latest
```

to:
```yaml
  openmemory-ui:
    # Pinned 2026-02-24 — update deliberately after testing newer versions
    image: mem0/openmemory-ui:<VERSION>
```

### Step 4: Verify the stack-generator also respects pinned versions

**File:** `packages/lib/src/admin/stack-generator.ts`

The stack generator reads the embedded `docker-compose.yml` as a template and uses it to produce the runtime compose file. Verify that the image fields are passed through as-is (not overridden with `latest`). Based on the architecture, the embedded compose is copied directly — no override expected.

### Step 5: Update any other references

Search for `openmemory-mcp:latest` and `openmemory-ui:latest` in the codebase to ensure no other files reference the unpinned tags:

```bash
rg "openmemory-mcp:latest|openmemory-ui:latest" --type yaml --type ts
```

## Files Changed

| File | Change |
|---|---|
| `packages/lib/src/embedded/state/docker-compose.yml` | Pin `mem0/openmemory-mcp` and `mem0/openmemory-ui` to specific version tags |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: full install → verify openmemory and openmemory-ui containers start with pinned versions
3. Verify: `docker compose ps` shows the pinned image tags, not `latest`
4. Verify: health checks still pass for openmemory service

## Dependencies

None — standalone fix. Requires checking Docker Hub for available tags at implementation time.
