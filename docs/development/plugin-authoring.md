# Plugin Authoring Guide

How to write OpenCode plugins for OpenPalm.

Plugins are the highest-risk extension sub-type. They hook into the OpenCode runtime event system and can inspect, block, or augment agent behavior at defined lifecycle points. Use the lowest-risk extension sub-type that satisfies your requirement -- prefer Skills or Commands over Plugins where possible.

## Plugin structure

A plugin is a TypeScript file that exports a function. The function receives an optional context object and returns an object whose keys are event hook names and whose values are async handler functions.

```typescript
// plugins/my-plugin.ts
type PluginContext = { client?: any; $?: any; [key: string]: unknown };
type Plugin = (ctx: PluginContext) => Promise<Record<string, unknown>>;

export const MyPlugin: Plugin = async ({ client }) => {
  return {
    "tool.execute.before": async (params: { tool: string; args: Record<string, unknown> }) => {
      console.log(`Tool called: ${params.tool}`);
      // Return nothing to allow, or return { blocked: true } to block
    },
    "tool.execute.after": async (params: { tool: string; result: unknown }) => {
      console.log(`Tool finished: ${params.tool}`);
    },
  };
};
```

## How plugins are loaded

Plugins are loaded from two sources:

1. **Auto-discovery** -- Any `.ts` file in `$OPENCODE_CONFIG_DIR/plugins/` is automatically loaded.
2. **Explicit registration** -- Entries in the `plugin[]` array in `opencode.jsonc`. These can be local paths or npm package names.

```jsonc
// opencode.jsonc
{
  "plugin": [
    "plugins/my-plugin.ts",
    "@myorg/some-npm-plugin"
  ]
}
```

npm packages are installed automatically via `bun install` at startup.

## Available hooks

| Hook | When it fires | Common use |
|---|---|---|
| `tool.execute.before` | Before any tool call | Block dangerous calls, log usage |
| `tool.execute.after` | After a tool call completes | Post-process results, audit logging |
| `experimental.chat.system.transform` | Before the system prompt is sent | Inject context (e.g., recalled memories) |
| `event` | On runtime events (`session.idle`, `compaction`, etc.) | Writeback, cleanup, periodic tasks |

Handlers receive a params object specific to the hook type. Return values vary by hook -- `tool.execute.before` can return `{ blocked: true, reason: "..." }` to prevent execution.

## Example: minimal audit plugin

```typescript
// plugins/audit-log.ts
export const AuditLog = async () => {
  return {
    "tool.execute.before": async (params: { tool: string; args: Record<string, unknown> }) => {
      const entry = { ts: new Date().toISOString(), tool: params.tool };
      console.log(JSON.stringify(entry));
    },
  };
};
```

## Security model

- Plugins run inside the OpenCode process within the `opencode-core` container.
- They are confined to the `assistant_net` Docker network and cannot access the host filesystem directly.
- The `policy-and-telemetry` built-in plugin scans all tool arguments for secrets and blocks execution if detected.
- The admin config editor rejects permission widening (e.g., changing `"bash": "ask"` to `"bash": "allow"`).
- All mutating admin endpoints require authentication via `x-admin-token`.

## Deployment

Place the file in `~/.config/openpalm/opencode-core/plugins/` and restart opencode-core. For npm packages, add to `plugin[]` in `opencode.jsonc`. To bake into the image, add to `opencode/extensions/plugins/` and rebuild.

See also: [Extensions Guide](../extensions-guide.md) | [Extensions Reference](../reference/extensions-reference.md)
