# ISSUE-16: No Telemetry or Error Reporting for Install Failures

**Severity:** LOW  
**Priority:** Post-v1  
**Effort:** M — add "Report Issue" link and optional telemetry

## Problem Summary

When install fails (image pull timeout, compose error, disk full), there is no mechanism for the team to learn about failure patterns. Users who hit issues silently give up or file incomplete bug reports.

## Implementation Steps

### Step 1: Add a "Report Issue" link to all error output in install.ts

**File:** `packages/cli/src/commands/install.ts`

This is the minimum viable change. Add a pre-filled GitHub issue link to every error exit path.

Create a helper function near the top of the file (after imports):

```typescript
function reportIssueUrl(context: { os: string; arch: string; runtime: string; error: string }): string {
  const title = encodeURIComponent(`Install failure: ${context.error.slice(0, 80)}`);
  const body = encodeURIComponent(
    `## Environment\n` +
    `- OS: ${context.os}\n` +
    `- Arch: ${context.arch}\n` +
    `- Runtime: ${context.runtime}\n` +
    `- Version: ${process.env.npm_package_version ?? 'unknown'}\n\n` +
    `## Error\n\`\`\`\n${context.error}\n\`\`\`\n\n` +
    `## Steps to Reproduce\n1. Ran \`openpalm install\`\n`
  );
  return `https://github.com/itlackey/openpalm/issues/new?title=${title}&body=${body}`;
}
```

### Step 2: Add report link to image pull failure

**File:** `packages/cli/src/commands/install.ts:339-351`

After the existing retry guidance (line 347), add:

```typescript
info("");
info("  If this keeps happening, report the issue:");
info(`    ${cyan(reportIssueUrl({ os, arch, runtime: platform, error: String(pullErr) }))}`);
```

### Step 3: Add report link to health check timeout failure

**File:** `packages/cli/src/commands/install.ts:428-446`

After step 4 in the "Common fixes" section, add:

```typescript
info("");
info("  5. Still stuck? Report the issue:");
info(`     ${cyan(reportIssueUrl({ os, arch, runtime: platform, error: 'Health check timeout after 3 minutes' }))}`);
```

### Step 4: Add report link to runtime detection failure

**File:** `packages/cli/src/commands/install.ts:34-37`

After the error message for unknown runtime, add the report link before `process.exit(1)`.

### Step 5: (Post-v1) Add opt-in anonymous telemetry

This is a larger feature for after v1. The design would be:

1. Add a `--no-telemetry` flag to the `install` command
2. On first install, ask the user: "Send anonymous install statistics to help improve OpenPalm? (y/n)"
3. If opted in, send a single POST request at the end of install with:
   - OS, arch, runtime
   - Install success/failure
   - Error category (not full error text)
   - Time taken
4. No PII, no IP logging
5. Telemetry endpoint: a simple webhook or analytics service

This step is intentionally deferred to post-v1 due to effort and the need for a telemetry backend.

## Files Changed

| File | Change |
|---|---|
| `packages/cli/src/commands/install.ts` | Add `reportIssueUrl()` helper, add "Report Issue" links to all error paths |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: simulate a failure (e.g., stop Docker) → run `openpalm install` → verify report link appears in error output
3. Verify: the GitHub issue URL opens correctly and pre-fills the template with OS/arch/runtime info
4. Verify: the URL is not excessively long (GitHub has URL length limits)

## Dependencies

None — standalone enhancement.
