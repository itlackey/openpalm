/**
 * The host UI's port and bind had seven independent answers: an explicit
 * `--port`, `PORT`, `OP_HOST_UI_PORT` from live env, the same key from
 * persisted stack.env (honored by the CLI, ignored by Electron), three separate
 * `3880` constants, and inline `?? 3880` fallbacks in UI routes. This pins the
 * one contract they now all call, including the two precedence rules that
 * actually diverged in shipped code.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HOST_UI_PORT,
  UI_LOOPBACK_HOST,
  resolveHostUiPort,
  resolveUiListenEnv,
} from "./network-contract.ts";
import { STACK_DEFAULTS } from "./defaults.ts";

describe("resolveHostUiPort", () => {
  test("falls back to the one shared default", () => {
    expect(resolveHostUiPort(undefined, {})).toBe(DEFAULT_HOST_UI_PORT);
    // The default is not a second literal — it IS the canonical port table.
    expect(DEFAULT_HOST_UI_PORT).toBe(STACK_DEFAULTS.ports.hostUi);
  });

  test("an explicit port (a --port flag) wins over everything", () => {
    expect(
      resolveHostUiPort(4200, { OP_HOST_UI_PORT: "5000" }, { OP_HOST_UI_PORT: "6000" }),
    ).toBe(4200);
  });

  test("reads the home's persisted OP_HOST_UI_PORT when live env has none", () => {
    // A headless install persists this. Electron read live env ALONE, so on the
    // same home `openpalm` bound the persisted port and the desktop app bound
    // 3880 — and the mic-permission origin check keyed off the wrong answer.
    expect(resolveHostUiPort(undefined, {}, { OP_HOST_UI_PORT: "4200" })).toBe(4200);
  });

  test("live env beats persisted stack.env, matching every other resolver", () => {
    // Electron's child-env spread had this INVERTED, so a value exported before
    // launching the desktop app was silently clobbered by the file.
    expect(
      resolveHostUiPort(undefined, { OP_HOST_UI_PORT: "5000" }, { OP_HOST_UI_PORT: "4200" }),
    ).toBe(5000);
  });

  test("a non-numeric or zero value falls back rather than producing NaN", () => {
    expect(resolveHostUiPort(undefined, { OP_HOST_UI_PORT: "nope" })).toBe(DEFAULT_HOST_UI_PORT);
    expect(resolveHostUiPort(undefined, { OP_HOST_UI_PORT: "" })).toBe(DEFAULT_HOST_UI_PORT);
    expect(resolveHostUiPort(undefined, { OP_HOST_UI_PORT: "0" })).toBe(DEFAULT_HOST_UI_PORT);
  });

  test("an invalid EXPLICIT port falls through to env/default instead of winning verbatim", () => {
    // The explicit branch is held to the same bar as the env branch: no
    // listener can bind 0, a negative, a fraction, or 65536+.
    expect(resolveHostUiPort(0, { OP_HOST_UI_PORT: "5000" })).toBe(5000);
    expect(resolveHostUiPort(-1, {})).toBe(DEFAULT_HOST_UI_PORT);
    expect(resolveHostUiPort(Number.NaN, {})).toBe(DEFAULT_HOST_UI_PORT);
    expect(resolveHostUiPort(3880.5, {})).toBe(DEFAULT_HOST_UI_PORT);
    expect(resolveHostUiPort(65536, {})).toBe(DEFAULT_HOST_UI_PORT);
    expect(resolveHostUiPort(65535, {})).toBe(65535);
  });
});

describe("resolveUiListenEnv", () => {
  test("an admin process is loopback-only, with ORIGIN matching the bind", () => {
    expect(resolveUiListenEnv({ port: 3880, admin: true, allowRemote: false })).toEqual({
      HOST: UI_LOOPBACK_HOST,
      PORT: "3880",
      ORIGIN: `http://${UI_LOOPBACK_HOST}:3880`,
      HOST_HEADER: undefined,
      PROTOCOL_HEADER: undefined,
    });
  });

  test("admin NEVER widens, even with the remote opt-in — host admin is not remotely reachable", () => {
    expect(resolveUiListenEnv({ port: 3880, admin: true, allowRemote: true }).HOST).toBe(
      UI_LOOPBACK_HOST,
    );
  });

  test("a non-admin process stays loopback by default", () => {
    expect(resolveUiListenEnv({ port: 3880, admin: false, allowRemote: false }).HOST).toBe(
      UI_LOOPBACK_HOST,
    );
  });

  test("the one non-loopback case trusts forwarded headers instead of pinning ORIGIN", () => {
    // Pinning ORIGIN behind a proxy would make SvelteKit compare the browser's
    // real origin against a fixed loopback string and reject every mutation.
    expect(resolveUiListenEnv({ port: 3880, admin: false, allowRemote: true })).toEqual({
      HOST: "0.0.0.0",
      PORT: "3880",
      HOST_HEADER: "host",
      PROTOCOL_HEADER: "x-forwarded-proto",
      ORIGIN: undefined,
    });
  });

  test("ORIGIN and HOST always agree on the loopback spelling", () => {
    // The split spelling (localhost for `openpalm`, 127.0.0.1 for admin) meant a
    // session minted under one command was not sent under the other.
    const env = resolveUiListenEnv({ port: 4200, admin: false, allowRemote: false });
    expect(env.ORIGIN).toBe(`http://${env.HOST}:4200`);
  });
});

describe("resolveUiListenEnv — trusted proxy", () => {
  test("trusts forwarded headers while STAYING on loopback", () => {
    // What Tailscale Serve / Caddy / nginx actually need: they connect to
    // 127.0.0.1, so the listener must not widen. Keying this off the same flag
    // that opens 0.0.0.0 is why the TLS guide had to add "now firewall the port
    // we just opened".
    expect(resolveUiListenEnv({ port: 3880, admin: false, allowRemote: false, trustProxy: true })).toEqual({
      HOST: UI_LOOPBACK_HOST,
      PORT: "3880",
      HOST_HEADER: "host",
      PROTOCOL_HEADER: "x-forwarded-proto",
      ORIGIN: undefined,
    });
  });

  test("admin ignores it — loopback bind AND a pinned origin", () => {
    const env = resolveUiListenEnv({ port: 3880, admin: true, allowRemote: false, trustProxy: true });
    expect(env.HOST).toBe(UI_LOOPBACK_HOST);
    expect(env.ORIGIN).toBe(`http://${UI_LOOPBACK_HOST}:3880`);
    expect(env.HOST_HEADER).toBeUndefined();
  });

  test("the explicit wildcard opt-in still wins when both are set", () => {
    expect(
      resolveUiListenEnv({ port: 3880, admin: false, allowRemote: true, trustProxy: true }).HOST,
    ).toBe("0.0.0.0");
  });
});
