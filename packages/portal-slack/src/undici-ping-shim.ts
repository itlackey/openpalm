// openpalm#665 — Slack socket-mode keepalive tears the connection down every
// ~7s with "undici.ping is not a function", every release since 0.13.0.
//
// Root cause: `require("undici")`/`import "undici"` under Bun always resolves
// to Bun's own built-in reimplementation of the undici API, never the real
// npm `undici` package — even though `@slack/socket-mode` declares (and this
// repo installs) real `undici@^7`, which does export a standalone `ping()`.
// Bun's bundled undici shim only exposes the WHATWG `WebSocket`; there is no
// standalone `ping` export at all, so `@slack/socket-mode@3.0.0`'s keepalive
// (`SlackWebSocket.js`: `(0, undici_1.ping)(this.websocket, data)`) throws on
// every tick.
//
// Bun's `WebSocket` instances carry their own non-standard `.ping(data)`
// instance method (Bun's native keepalive API) that undici's real standalone
// `ping(ws, data)` function does not need but a Bun `WebSocket` supports
// directly. This patches the missing standalone function onto the shared
// `undici` module object so `@slack/socket-mode`'s existing, unmodified call
// site starts working. A no-op wherever `undici.ping` already exists (a real
// Node/undici runtime), so this is safe to call unconditionally at startup.
//
// Deliberately `require`, not `import * as undici` — Bun hands out a
// separate, non-writable ES-namespace object for `import * as undici from
// "undici"`, distinct from the mutable object `require("undici")` returns.
// `@slack/socket-mode` is CJS and calls `require("undici")`, so patching has
// to land on that same object or socket-mode never sees it.
const undici = require("undici") as UndiciWithPing;

type PingableWebSocket = { ping?: (data?: unknown) => void };
type UndiciWithPing = { ping?: (ws: PingableWebSocket, data?: unknown) => void };

export function ensureUndiciPing(): void {
  if (typeof undici.ping === "function") return;
  undici.ping = (ws, data) => {
    if (typeof ws.ping !== "function") {
      throw new TypeError("undici.ping shim: WebSocket instance has no ping() method available");
    }
    ws.ping(data);
  };
}
