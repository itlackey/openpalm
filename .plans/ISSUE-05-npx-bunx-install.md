# ISSUE-5: npx/bunx Alternative Install Not Tested

**Severity:** LOW  
**Priority:** Post-v1  
**Effort:** XS

## Problem Summary

The README mentions `npx openpalm install` as an alternative but the npm package contains CLI TypeScript source that requires Bun. This is not a standard prerequisite and the path is untested.

## Implementation Steps

### Step 1: Remove the npx/bunx section from README.md

**File:** `README.md:46-55`

Remove the entire `<details>` block:

```markdown
<details>
<summary>Alternative: install via npx or bunx</summary>

If you already have Node.js or Bun installed:
```bash
npx openpalm install
# or
bunx openpalm install
```
</details>
```

Replace with nothing — the binary installer is the only documented path for v1.

### Step 2: Consider restoring post-v1

If the npm package is updated to include a compiled binary or a Node.js-compatible shim, this section can be restored. Track this as a post-v1 enhancement.

## Files Changed

| File | Change |
|---|---|
| `README.md` | Remove lines 46-55 (npx/bunx details block) |

## Testing

1. Visual review of README after change
2. Verify the install instructions still flow correctly without the removed section
