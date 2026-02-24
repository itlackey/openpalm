# ISSUE-14: Channel Config Fields Show Raw Env Var Names

**Severity:** MEDIUM  
**Priority:** Nice to Have  
**Effort:** S — small UI change

## Problem Summary

In `packages/ui/src/lib/components/ChannelsStep.svelte:79-80`, credential fields are labeled using the raw `field.key` value (the env var name, e.g., `DISCORD_BOT_TOKEN`). The `field.helpText` property (from `e.description` in channel YAML) is only used as the input `placeholder`, not as the label. Non-technical users see `DISCORD_BOT_TOKEN *` as a label and don't know what it means.

## Implementation Steps

### Step 1: Add a humanizeKey helper function

**File:** `packages/ui/src/lib/components/ChannelsStep.svelte`

Add a helper function in the `<script>` block, after the `isChecked` function (after line 46):

```typescript
/** Turn env var names like DISCORD_BOT_TOKEN into "Bot Token". */
function humanizeKey(key: string): string {
  return key
    .replace(/^[A-Z]+_/, '')      // strip channel prefix e.g. DISCORD_
    .split('_')
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(' ');
}
```

### Step 2: Update the label to prefer helpText over raw key

**File:** `packages/ui/src/lib/components/ChannelsStep.svelte:79-80`

Change:
```svelte
<label style="display:block;margin:0.4rem 0 0.2rem;font-size:13px">
  {field.key}{field.required ? ' *' : ''}
</label>
```

to:
```svelte
<label style="display:block;margin:0.4rem 0 0.2rem;font-size:13px">
  {field.helpText || humanizeKey(field.key)}{field.required ? ' *' : ''}
</label>
```

This shows:
- The human-readable `description` from the channel YAML if available (e.g., "Bot Token")
- A humanized version of the env var name as fallback (e.g., `DISCORD_BOT_TOKEN` → "Bot Token")

### Step 3: Keep the raw key as input placeholder for reference

**File:** `packages/ui/src/lib/components/ChannelsStep.svelte:87`

Change the placeholder to show the env var name (since helpText is now used as the label):

```svelte
<input
  class="wiz-ch-field"
  data-channel={channel.id}
  data-key={field.key}
  type={field.type}
  placeholder={field.key}
  value=""
/>
```

This way the user sees a human label but can still identify the underlying env var in the placeholder ghost text.

## Files Changed

| File | Change |
|---|---|
| `packages/ui/src/lib/components/ChannelsStep.svelte` | Add `humanizeKey()` helper, use `helpText` for labels, show `key` in placeholder |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: open setup wizard → navigate to Channels step → verify labels show human-readable text
3. Verify: channels with `description` in their YAML show that description as the label
4. Verify: channels without `description` show a humanized version of the env var name
5. Verify: the raw env var name appears as placeholder text in the input field

## Dependencies

None — standalone UI improvement.
