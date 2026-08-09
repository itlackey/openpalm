/**
 * #488 — Guardian/assistant LAN mDNS self-advertisement (host control-plane
 * responder in @openpalm/lib).
 *
 * The DNS wire format + multicast socket are now the `multicast-dns` package's
 * job; this suite covers the OpenPalm policy this module owns: name derivation,
 * bind-address gating, and the responder/reconcile lifecycle. The responder
 * tests inject a stub `MdnsInstance` (no real socket) and assert on the record
 * objects handed to `respond()`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveMdnsNames,
  reconcileMdnsResponder,
  resolveMdnsAdvertisements,
  resolveMdnsStatus,
  sanitizeDnsLabel,
  _awaitMdnsProbeForTests,
  _resetMdnsResponderForTests,
  _setMdnsFactoryForTests,
  _setMdnsIntervalSchedulerForTests,
  _setMdnsProbeForTests,
  type MdnsAnswer,
  type MdnsFactory,
  type MdnsInstance,
  type MdnsIntervalScheduler,
  type MdnsProbe,
  type MdnsRemoteInfo,
} from "./mdns-responder.js";

const MDNS_PORT = 5353;

function assertDefined<T>(value: T | undefined | null): asserts value is T {
  expect(value).toBeDefined();
}

// ── Stub multicast-dns instance (records respond()/destroy(), no socket) ─────

class StubMdns implements MdnsInstance {
  responses: Array<{ res: { answers: MdnsAnswer[]; additionals?: MdnsAnswer[] }; rinfo?: MdnsRemoteInfo }> = [];
  destroyed = false;
  private queryHandler?: (message: { questions?: { name?: string; type?: string }[] }, rinfo: MdnsRemoteInfo) => void;
  private errorHandler?: (err: Error) => void;

  on(event: "query", handler: (message: { questions?: { name?: string; type?: string }[] }, rinfo: MdnsRemoteInfo) => void): void;
  on(event: "warning" | "error", handler: (err: Error) => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    if (event === "query") this.queryHandler = handler as never;
    else if (event === "error") this.errorHandler = handler as never;
  }
  respond(res: { answers: MdnsAnswer[]; additionals?: MdnsAnswer[] }, rinfo?: MdnsRemoteInfo): void {
    this.responses.push({ res, rinfo });
  }
  destroy(): void {
    this.destroyed = true;
  }

  emitQuery(questions: { name?: string; type?: string }[], rinfo: MdnsRemoteInfo): void {
    this.queryHandler?.({ questions }, rinfo);
  }
  emitError(err: Error): void {
    this.errorHandler?.(err);
  }
  /** Every answer record across all respond() calls (announcements + query answers). */
  allAnswers(): MdnsAnswer[] {
    return this.responses.flatMap((r) => r.res.answers);
  }
}

function createStubMdnsFactory(): { factory: MdnsFactory; instances: StubMdns[] } {
  const instances: StubMdns[] = [];
  const factory: MdnsFactory = () => {
    const m = new StubMdns();
    instances.push(m);
    return m;
  };
  return { factory, instances };
}

// ── name derivation ──────────────────────────────────────────────────────────

describe("sanitizeDnsLabel", () => {
  test("lowercases and maps underscores/invalid chars to hyphens", () => {
    expect(sanitizeDnsLabel("My_Lab!")).toBe("my-lab");
  });

  test("trims leading/trailing hyphens and collapses runs", () => {
    expect(sanitizeDnsLabel("--a__b--")).toBe("a-b");
  });

  test('falls back to "openpalm" when nothing survives', () => {
    expect(sanitizeDnsLabel("___")).toBe("openpalm");
    expect(sanitizeDnsLabel("")).toBe("openpalm");
  });

  test('truncates to 54 chars so "-guardian" still fits a 63-char DNS label', () => {
    const raw = "a".repeat(70);
    const result = sanitizeDnsLabel(raw);
    expect(result).toHaveLength(54);
    expect(result).toBe("a".repeat(54));
    expect(`${result}-guardian`.length).toBeLessThanOrEqual(63);
  });
});

describe("deriveMdnsNames", () => {
  test("defaults to openpalm.local / openpalm-guardian.local", () => {
    expect(deriveMdnsNames({})).toEqual({
      base: "openpalm",
      assistantName: "openpalm.local",
      guardianName: "openpalm-guardian.local",
    });
  });

  test("derives from OP_PROJECT_NAME", () => {
    expect(deriveMdnsNames({ OP_PROJECT_NAME: "my_lab" })).toEqual({
      base: "my-lab",
      assistantName: "my-lab.local",
      guardianName: "my-lab-guardian.local",
    });
  });
});

// ── gating truth table ───────────────────────────────────────────────────────

describe("resolveMdnsAdvertisements", () => {
  const HOST_IPV4 = ["192.168.1.20"];

  test("empty env advertises nothing", () => {
    expect(resolveMdnsAdvertisements({}, HOST_IPV4)).toEqual([]);
  });

  test("explicit loopback values advertise nothing", () => {
    expect(
      resolveMdnsAdvertisements(
        { OP_GUARDIAN_BIND_ADDRESS: "127.0.0.1", OP_ASSISTANT_BIND_ADDRESS: "localhost" },
        HOST_IPV4,
      ),
    ).toEqual([]);
  });

  test("OP_GUARDIAN_BIND_ADDRESS=0.0.0.0 advertises the guardian name only (direct ingress on)", () => {
    const adverts = resolveMdnsAdvertisements(
      { OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0", GUARDIAN_DIRECT_INGRESS: "true" },
      HOST_IPV4,
    );
    expect(adverts).toEqual([
      { service: "guardian", name: "openpalm-guardian.local", port: 3830, addresses: HOST_IPV4 },
    ]);
  });

  // PR #564 P2-1: a LAN-visible guardian bind must NOT be advertised while the
  // direct-ingress listener is disabled — else mDNS points the LAN at a 3830
  // listener that 404s (the shared-guardian preset leaves ingress off).
  test("OP_GUARDIAN_BIND_ADDRESS=0.0.0.0 advertises NOTHING when GUARDIAN_DIRECT_INGRESS is off/absent", () => {
    expect(resolveMdnsAdvertisements({ OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0" }, HOST_IPV4)).toEqual([]);
    expect(
      resolveMdnsAdvertisements({ OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0", GUARDIAN_DIRECT_INGRESS: "false" }, HOST_IPV4),
    ).toEqual([]);
    // Only a literal 'true' opens ingress (mirrors guardian server.ts).
    expect(
      resolveMdnsAdvertisements({ OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0", GUARDIAN_DIRECT_INGRESS: "1" }, HOST_IPV4),
    ).toEqual([]);
  });

  test("resolveMdnsStatus reports guardian advertised:false when a LAN bind has ingress off", () => {
    expect(resolveMdnsStatus({ OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0" }).guardian.advertised).toBe(false);
    expect(
      resolveMdnsStatus({ OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0", GUARDIAN_DIRECT_INGRESS: "true" }).guardian.advertised,
    ).toBe(true);
  });

  // The DEFAULT home install: network access on, everything else closed. This
  // is the whole reason the name exists — "find the assistant from any device"
  // — and gating it on the assistant bind meant it advertised nothing at all.
  test("OP_UI_BIND_ADDRESS=0.0.0.0 advertises the front door on the UI port", () => {
    const adverts = resolveMdnsAdvertisements({ OP_UI_BIND_ADDRESS: "0.0.0.0" }, HOST_IPV4);
    expect(adverts).toEqual([
      { service: "assistant", name: "openpalm.local", port: 3800, addresses: HOST_IPV4 },
    ]);
  });

  test("OP_ASSISTANT_BIND_ADDRESS=0.0.0.0 alone still advertises, on the assistant port", () => {
    // A headless install publishing only the OpenCode API keeps its name.
    const adverts = resolveMdnsAdvertisements({ OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" }, HOST_IPV4);
    expect(adverts).toEqual([
      { service: "assistant", name: "openpalm.local", port: 3810, addresses: HOST_IPV4 },
    ]);
  });

  test("the UI wins when both are published — one name, one SRV port", () => {
    const adverts = resolveMdnsAdvertisements(
      { OP_UI_BIND_ADDRESS: "0.0.0.0", OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" },
      HOST_IPV4,
    );
    expect(adverts).toEqual([
      { service: "assistant", name: "openpalm.local", port: 3800, addresses: HOST_IPV4 },
    ]);
  });

  test("both non-loopback advertises both; custom ports respected", () => {
    const adverts = resolveMdnsAdvertisements(
      {
        OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0",
        OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0",
        GUARDIAN_DIRECT_INGRESS: "true",
        OP_GUARDIAN_PORT: "4830",
        OP_ASSISTANT_PORT: "4800",
      },
      HOST_IPV4,
    );
    expect(adverts).toHaveLength(2);
    const guardian = adverts.find((a) => a.service === "guardian");
    const assistant = adverts.find((a) => a.service === "assistant");
    expect(guardian?.port).toBe(4830);
    expect(assistant?.port).toBe(4800);
  });

  test("a specific bind IP narrows the A-record addresses to that IP", () => {
    const adverts = resolveMdnsAdvertisements(
      { OP_GUARDIAN_BIND_ADDRESS: "192.168.1.5", GUARDIAN_DIRECT_INGRESS: "true" },
      HOST_IPV4,
    );
    expect(adverts).toEqual([
      { service: "guardian", name: "openpalm-guardian.local", port: 3830, addresses: ["192.168.1.5"] },
    ]);
  });

  test('OP_MDNS=off disables everything even with non-loopback binds', () => {
    for (const off of ["off", "0", "false"]) {
      const adverts = resolveMdnsAdvertisements(
        {
          OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0",
          OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0",
          OP_UI_BIND_ADDRESS: "0.0.0.0",
          OP_MDNS: off,
        },
        HOST_IPV4,
      );
      expect(adverts).toEqual([]);
    }
  });

  // PR #564 r3566892051: a specific non-IPv4 bind (IPv6 literal / hostname)
  // must not be encoded into an A record — skip it instead.
  test("a specific IPv6 bind is skipped (no malformed A record)", () => {
    expect(
      resolveMdnsAdvertisements({ OP_GUARDIAN_BIND_ADDRESS: "fd00::5", GUARDIAN_DIRECT_INGRESS: "true" }, HOST_IPV4),
    ).toEqual([]);
  });

  test("a specific hostname bind is skipped (no malformed A record)", () => {
    expect(
      resolveMdnsAdvertisements({ OP_ASSISTANT_BIND_ADDRESS: "my-host.lan" }, HOST_IPV4),
    ).toEqual([]);
  });

  test("a specific IPv4 bind is advertised with that exact address", () => {
    const adverts = resolveMdnsAdvertisements({ OP_ASSISTANT_BIND_ADDRESS: "192.168.1.7" }, HOST_IPV4);
    expect(adverts).toEqual([
      { service: "assistant", name: "openpalm.local", port: 3810, addresses: ["192.168.1.7"] },
    ]);
  });

  test("wildcard bind filters host addresses to IPv4 only", () => {
    const adverts = resolveMdnsAdvertisements(
      { OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" },
      ["192.168.1.20", "fe80::1", "not-an-ip"],
    );
    expect(adverts).toEqual([
      { service: "assistant", name: "openpalm.local", port: 3810, addresses: ["192.168.1.20"] },
    ]);
  });
});

describe("resolveMdnsStatus", () => {
  test("reports names/ports with advertised flags", () => {
    // A closed install shows the port it WOULD get: the UI's front door.
    const status = resolveMdnsStatus({});
    expect(status).toEqual({
      assistant: { name: "openpalm.local", port: 3800, advertised: false },
      guardian: { name: "openpalm-guardian.local", port: 3830, advertised: false },
    });
  });

  test("reports the front door actually published", () => {
    expect(resolveMdnsStatus({ OP_UI_BIND_ADDRESS: "0.0.0.0" }).assistant)
      .toEqual({ name: "openpalm.local", port: 3800, advertised: true });
    expect(resolveMdnsStatus({ OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" }).assistant)
      .toEqual({ name: "openpalm.local", port: 3810, advertised: true });
  });
});

// ── responder record content (stub MdnsInstance) ─────────────────────────────
//
// Driven through reconcileMdnsResponder — the only caller that starts a
// responder in production — rather than a test-only wrapper. Under HOST_IPV4,
// ASSISTANT_ENV resolves to openpalm.local:3810 and GUARDIAN_ENV to
// openpalm-guardian.local:3830. The reconcile describe below covers the
// start/stop/idempotence lifecycle; this block covers the DNS records.

const HOST_IPV4 = ["192.168.1.20"];
const ASSISTANT_ENV = { OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" };
const GUARDIAN_ENV = { GUARDIAN_DIRECT_INGRESS: "true", OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0" };
const LOOPBACK_ENV = { OP_ASSISTANT_BIND_ADDRESS: "127.0.0.1" };

describe("mdns responder records", () => {
  /**
   * Reconcile a responder into existence and hand back its stub instance.
   * ASYNC (contract change, Phase 2 §2 self-probe): the responder no longer
   * starts synchronously inside `reconcileMdnsResponder` — it starts once a
   * self-probe confirms the front door answers, so callers await
   * `_awaitMdnsProbeForTests()` before the stub instance exists. The
   * always-confirming probe installed in `beforeEach` below keeps every
   * existing record-content assertion in this block unchanged; only the
   * synchronicity of getting there changed.
   */
  async function startStub(env: Record<string, string | undefined> = ASSISTANT_ENV): Promise<{
    mdns: StubMdns;
    factory: MdnsFactory;
  }> {
    const { factory, instances } = createStubMdnsFactory();
    reconcileMdnsResponder("/nonexistent", { env, makeMdns: factory, hostIpv4: HOST_IPV4 });
    await _awaitMdnsProbeForTests();
    const [mdns] = instances;
    assertDefined(mdns);
    return { mdns, factory };
  }

  beforeEach(() => {
    _resetMdnsResponderForTests();
    _setMdnsFactoryForTests(null);
    // Confirm every front door immediately — this block asserts on DNS RECORD
    // CONTENT, not on self-probe gating (that is its own describe below), so
    // the probe must never be the thing under test here.
    _setMdnsProbeForTests(async () => true);
  });

  afterEach(() => {
    _resetMdnsResponderForTests();
    _setMdnsFactoryForTests(null);
    _setMdnsProbeForTests(null);
  });

  test("announces an A record per advert address", async () => {
    const { mdns } = await startStub();
    const announced = mdns.allAnswers().find((a) => a.type === "A");
    assertDefined(announced);
    expect(announced.name).toBe("openpalm.local");
    expect(announced.data).toBe("192.168.1.20");
  });

  test("answers a matching A query with the advert's address", async () => {
    const { mdns } = await startStub();
    mdns.responses.length = 0; // drop startup announcements

    mdns.emitQuery([{ name: "openpalm.local", type: "A" }], { address: "192.168.1.50", port: MDNS_PORT });

    expect(mdns.responses.length).toBeGreaterThanOrEqual(1);
    const last = mdns.responses[mdns.responses.length - 1];
    assertDefined(last);
    const answer = last.res.answers.find((a) => a.type === "A");
    assertDefined(answer);
    expect(answer.data).toBe("192.168.1.20");
    // A standard multicast query (source port 5353) is answered to the group.
    expect(last.rinfo).toBeUndefined();
  });

  test("answers a _http._tcp.local PTR query with SRV/TXT/A additionals", async () => {
    const { mdns } = await startStub();
    mdns.responses.length = 0;

    mdns.emitQuery([{ name: "_http._tcp.local", type: "PTR" }], { address: "192.168.1.50", port: MDNS_PORT });

    const last = mdns.responses[mdns.responses.length - 1];
    assertDefined(last);
    expect(last.res.answers.some((a) => a.type === "PTR")).toBe(true);
    expect(last.res.additionals?.some((a) => a.type === "SRV")).toBe(true);
    expect(last.res.additionals?.some((a) => a.type === "TXT")).toBe(true);
  });

  test("answers a legacy-unicast query (source port ≠ 5353) back to the sender", async () => {
    const { mdns } = await startStub();
    mdns.responses.length = 0;

    const rinfo = { address: "192.168.1.50", port: 54321 };
    mdns.emitQuery([{ name: "openpalm.local", type: "A" }], rinfo);

    const last = mdns.responses[mdns.responses.length - 1];
    assertDefined(last);
    expect(last.rinfo).toEqual(rinfo);
  });

  test("ignores non-matching queries", async () => {
    const { mdns } = await startStub();
    mdns.responses.length = 0;

    mdns.emitQuery([{ name: "unknown.local", type: "A" }], { address: "192.168.1.50", port: MDNS_PORT });
    expect(mdns.responses).toHaveLength(0);
  });

  test("every goodbye record carries TTL 0", async () => {
    const { mdns, factory } = await startStub();
    const before = mdns.responses.length;

    // Reconciling back to loopback stops the active responder SYNCHRONOUSLY
    // (going to an empty advert set never needs the probe) — the only
    // production path that sends goodbyes.
    reconcileMdnsResponder("/nonexistent", {
      env: LOOPBACK_ENV,
      makeMdns: factory,
      hostIpv4: HOST_IPV4,
    });

    expect(mdns.responses.length).toBeGreaterThan(before);
    const goodbye = mdns.responses[mdns.responses.length - 1];
    assertDefined(goodbye);
    expect(goodbye.res.answers.length).toBeGreaterThanOrEqual(1);
    for (const answer of goodbye.res.answers) expect(answer.ttl).toBe(0);
    expect(mdns.destroyed).toBe(true);
  });

  test("factory/socket errors are non-fatal", async () => {
    const throwingFactory: MdnsFactory = () => {
      throw new Error("EADDRINUSE");
    };
    expect(() =>
      reconcileMdnsResponder("/nonexistent", {
        env: ASSISTANT_ENV,
        makeMdns: throwingFactory,
        hostIpv4: HOST_IPV4,
      }),
    ).not.toThrow();
    // The throwing factory is only reached once the (stubbed, confirming)
    // self-probe settles and `createResponder` actually runs.
    await _awaitMdnsProbeForTests();

    const { mdns } = await startStub(GUARDIAN_ENV);
    expect(() => mdns.emitError(new Error("EACCES"))).not.toThrow();
  });
});

// ── reconcile ────────────────────────────────────────────────────────────────

describe("reconcileMdnsResponder", () => {
  const homes: string[] = [];

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "openpalm-mdns-"));
    mkdirSync(join(home, "knowledge", "env"), { recursive: true });
    mkdirSync(join(home, "state"), { recursive: true });
    homes.push(home);
    return home;
  }

  function writeStackEnv(home: string, content: string): void {
    writeFileSync(join(home, "state", "stack.env"), content);
  }

  beforeEach(() => {
    _resetMdnsResponderForTests();
    _setMdnsFactoryForTests(null);
    // Confirm every front door immediately by default — most tests in this
    // block assert on GATING (env in -> responder or not), not on the
    // self-probe itself (that has its own describe below).
    _setMdnsProbeForTests(async () => true);
    _setMdnsIntervalSchedulerForTests(null);
  });

  afterEach(() => {
    _resetMdnsResponderForTests();
    _setMdnsFactoryForTests(null);
    _setMdnsProbeForTests(null);
    _setMdnsIntervalSchedulerForTests(null);
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("starts nothing for a loopback stack.env", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_BIND_ADDRESS=127.0.0.1\n");
    const { factory, instances } = createStubMdnsFactory();
    const status = reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });
    expect(instances).toHaveLength(0);
    expect(status.assistant.advertised).toBe(false);
    expect(status.guardian.advertised).toBe(false);
  });

  test("starts the responder when stack.env enables LAN exposure", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, instances } = createStubMdnsFactory();
    const status = reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });
    await _awaitMdnsProbeForTests(); // contract change: starting now waits on the self-probe
    expect(instances.length).toBeGreaterThanOrEqual(1);
    expect(status.assistant.advertised).toBe(true);
  });

  test("is idempotent for an unchanged env", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, instances } = createStubMdnsFactory();
    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });
    await _awaitMdnsProbeForTests();
    const countAfterFirst = instances.length;
    const [first] = instances;
    assertDefined(first);

    // Unchanged key -> short-circuits synchronously, before ever scheduling
    // another probe (see reconcileMdnsResponder's `active.key === key` check).
    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });

    expect(instances.length).toBe(countAfterFirst); // no new responder created
    expect(first.destroyed).toBe(false); // unchanged handle not stopped
  });

  test("stops the responder when the env returns to loopback", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, instances } = createStubMdnsFactory();
    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });
    await _awaitMdnsProbeForTests();
    const [first] = instances;
    assertDefined(first);
    const before = first.responses.length;

    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=127.0.0.1\n");
    // Going to an empty advert set is synchronous — no probe involved.
    const status = reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });

    expect(first.responses.length).toBeGreaterThan(before); // goodbye sent
    expect(first.destroyed).toBe(true);
    expect(status.assistant.advertised).toBe(false);
  });

  test("process.env OP_MDNS=0 force-disables reconcile regardless of stack.env", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, instances } = createStubMdnsFactory();
    const status = reconcileMdnsResponder(home, {
      makeMdns: factory,
      hostIpv4: ["192.168.1.20"],
      processEnv: { OP_MDNS: "0" },
    });
    expect(instances).toHaveLength(0);
    expect(status.assistant.advertised).toBe(false);
  });

  // ── self-probe honesty (0.14.0 LAN-access review, Phase 2) ────────────────
  //
  // "advertise a name only once a self-probe confirms the published port
  // answers" — finding #2. Only the front door (`<name>.local`, the
  // "assistant" advert) is probed; see the module doc for why the guardian
  // advert is out of scope for this check.

  test("does not start the responder until a self-probe confirms the front door answers", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, instances } = createStubMdnsFactory();
    const probed: string[] = [];
    const probe: MdnsProbe = async (host, port) => {
      probed.push(`${host}:${port}`);
      return false; // never confirms
    };

    const status = reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"], probe });
    await _awaitMdnsProbeForTests();

    // OP_ASSISTANT_PORT default (the resolved front door); a wildcard bind
    // publishes on loopback too, so that is where the probe connects.
    expect(probed).toEqual(["127.0.0.1:3810"]);
    expect(instances).toHaveLength(0); // never confirmed -> never started
    // The returned status still reflects INTENT (the bind-address gate), same
    // as always — see resolveMdnsStatus's own doc. A probe failure changes
    // whether a socket exists, never what this status reports.
    expect(status.assistant.advertised).toBe(true);
  });

  test("a specific-IP bind is probed AT that IP — Docker publishes the port there, not on loopback", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=192.168.1.7\n");
    const { factory, instances } = createStubMdnsFactory();
    const probed: string[] = [];
    const probe: MdnsProbe = async (host, port) => {
      probed.push(`${host}:${port}`);
      return true;
    };

    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"], probe });
    await _awaitMdnsProbeForTests();

    expect(probed).toEqual(["192.168.1.7:3810"]);
    expect(instances).toHaveLength(1); // confirmed at the bind address -> advertised
  });

  test("retries the self-probe on the next reconcile call and starts once it confirms", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, instances } = createStubMdnsFactory();
    let confirm = false;
    const probe: MdnsProbe = async () => confirm;

    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"], probe });
    await _awaitMdnsProbeForTests();
    expect(instances).toHaveLength(0);

    confirm = true;
    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"], probe });
    await _awaitMdnsProbeForTests();
    expect(instances).toHaveLength(1);
  });

  test("a guardian-only advert set never calls the front-door probe", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_GUARDIAN_BIND_ADDRESS=0.0.0.0\nGUARDIAN_DIRECT_INGRESS=true\n");
    const { factory, instances } = createStubMdnsFactory();
    let probeCalls = 0;
    const probe: MdnsProbe = async () => {
      probeCalls++;
      return true;
    };

    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"], probe });
    await _awaitMdnsProbeForTests();

    expect(probeCalls).toBe(0); // no front door to confirm
    expect(instances).toHaveLength(1); // guardian starts unconditionally on its own gate
  });

  // ── convergence interval (0.14.0 LAN-access review, Phase 2) ───────────────
  //
  // "have the responder re-read state/stack.env on a timer (60s) from inside
  // the module" — finding #1. A manual scheduler stands in for the real 60s
  // `setInterval` so the test fires a tick deterministically instead of
  // waiting on the wall clock.

  test("the convergence interval re-reads stack.env on tick with no explicit reconcile call", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_BIND_ADDRESS=127.0.0.1\n"); // closed
    const { factory, instances } = createStubMdnsFactory();
    let tick: (() => void) | undefined;
    const scheduler: MdnsIntervalScheduler = (fn) => {
      tick = fn;
      return { cancel: () => { tick = undefined; } };
    };
    _setMdnsIntervalSchedulerForTests(scheduler);
    _setMdnsFactoryForTests(factory);

    // Arms the interval; nothing to advertise yet.
    reconcileMdnsResponder(home);
    await _awaitMdnsProbeForTests();
    expect(instances).toHaveLength(0);
    expect(tick).toBeDefined();

    // A DIFFERENT process — the one this interval exists for — wrote a
    // LAN-open bind straight to disk. A concrete IP (not a wildcard) so this
    // assertion never depends on the sandbox's real network interfaces.
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=192.168.1.7\n");

    tick?.();
    await _awaitMdnsProbeForTests();

    expect(instances).toHaveLength(1);
  });

  test("ensureIntervalStarted only arms the timer once per process", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_BIND_ADDRESS=127.0.0.1\n");
    let scheduleCalls = 0;
    _setMdnsIntervalSchedulerForTests(() => {
      scheduleCalls++;
      return { cancel: () => {} };
    });

    reconcileMdnsResponder(home);
    reconcileMdnsResponder(home);
    reconcileMdnsResponder(home);

    expect(scheduleCalls).toBe(1);
  });

  // ── in-container guard (0.14.0 LAN-access review, Phase 2 finding #3) ─────
  //
  // The container's UI co-process runs this exact hooks.server.ts init too
  // (see module doc). Bridge-network multicast can't reach the LAN there, so
  // the responder — and the interval/probe machinery that would eventually
  // start one — must never run, explicitly rather than by the accident of no
  // in-container caller happening to open a LAN bind.

  test("OP_UI_SERVED_IN_CONTAINER=1 never starts the responder or arms the interval", async () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n"); // would otherwise advertise
    const { factory, instances } = createStubMdnsFactory();
    let schedulerCalls = 0;
    _setMdnsIntervalSchedulerForTests(() => {
      schedulerCalls++;
      return { cancel: () => {} };
    });

    const status = reconcileMdnsResponder(home, {
      makeMdns: factory,
      hostIpv4: ["192.168.1.20"],
      processEnv: { OP_UI_SERVED_IN_CONTAINER: "1" },
    });
    await _awaitMdnsProbeForTests(); // no-op: nothing was ever scheduled

    expect(instances).toHaveLength(0);
    expect(schedulerCalls).toBe(0);
    // The status is still computed for informational purposes, purely from
    // the bind-address gate — it just never becomes a live socket.
    expect(status.assistant.advertised).toBe(true);
  });
});
