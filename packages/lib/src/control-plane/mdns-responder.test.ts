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
  startMdnsResponder,
  _resetMdnsResponderForTests,
  _setMdnsFactoryForTests,
  type MdnsAdvertisement,
  type MdnsAnswer,
  type MdnsFactory,
  type MdnsInstance,
  type MdnsRemoteInfo,
  type MdnsResponderHandle,
} from "./mdns-responder.js";

const MDNS_PORT = 5353;

function assertDefined<T>(value: T | undefined | null): asserts value is T {
  expect(value).toBeDefined();
}

function makeAssistantAdvert(): MdnsAdvertisement {
  return { service: "assistant", name: "openpalm.local", port: 3810, addresses: ["192.168.1.20"] };
}
function makeGuardianAdvert(): MdnsAdvertisement {
  return { service: "guardian", name: "openpalm-guardian.local", port: 3830, addresses: ["192.168.1.20"] };
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

// ── responder lifecycle (stub MdnsInstance) ──────────────────────────────────

describe("startMdnsResponder", () => {
  test("returns null and creates no responder when there is nothing to advertise", () => {
    const { factory, instances } = createStubMdnsFactory();
    const handle = startMdnsResponder([], { makeMdns: factory });
    expect(handle).toBeNull();
    expect(instances).toHaveLength(0);
  });

  test("creates one responder and announces an A record per advert address", () => {
    const { factory, instances } = createStubMdnsFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { makeMdns: factory });
    expect(handle).not.toBeNull();
    expect(instances).toHaveLength(1);
    const [mdns] = instances;
    assertDefined(mdns);
    const announced = mdns.allAnswers().find((a) => a.type === "A");
    assertDefined(announced);
    expect(announced.name).toBe("openpalm.local");
    expect(announced.data).toBe("192.168.1.20");
    handle?.stop();
  });

  test("answers a matching A query with the advert's address", () => {
    const { factory, instances } = createStubMdnsFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { makeMdns: factory });
    const [mdns] = instances;
    assertDefined(mdns);
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
    handle?.stop();
  });

  test("answers a _http._tcp.local PTR query with SRV/TXT/A additionals", () => {
    const { factory, instances } = createStubMdnsFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { makeMdns: factory });
    const [mdns] = instances;
    assertDefined(mdns);
    mdns.responses.length = 0;

    mdns.emitQuery([{ name: "_http._tcp.local", type: "PTR" }], { address: "192.168.1.50", port: MDNS_PORT });

    const last = mdns.responses[mdns.responses.length - 1];
    assertDefined(last);
    expect(last.res.answers.some((a) => a.type === "PTR")).toBe(true);
    expect(last.res.additionals?.some((a) => a.type === "SRV")).toBe(true);
    expect(last.res.additionals?.some((a) => a.type === "TXT")).toBe(true);
    handle?.stop();
  });

  test("answers a legacy-unicast query (source port ≠ 5353) back to the sender", () => {
    const { factory, instances } = createStubMdnsFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { makeMdns: factory });
    const [mdns] = instances;
    assertDefined(mdns);
    mdns.responses.length = 0;

    const rinfo = { address: "192.168.1.50", port: 54321 };
    mdns.emitQuery([{ name: "openpalm.local", type: "A" }], rinfo);

    const last = mdns.responses[mdns.responses.length - 1];
    assertDefined(last);
    expect(last.rinfo).toEqual(rinfo);
    handle?.stop();
  });

  test("ignores non-matching queries", () => {
    const { factory, instances } = createStubMdnsFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { makeMdns: factory });
    const [mdns] = instances;
    assertDefined(mdns);
    mdns.responses.length = 0;

    mdns.emitQuery([{ name: "unknown.local", type: "A" }], { address: "192.168.1.50", port: MDNS_PORT });
    expect(mdns.responses).toHaveLength(0);
    handle?.stop();
  });

  test("stop() sends TTL-0 goodbye records and destroys the responder", () => {
    const { factory, instances } = createStubMdnsFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { makeMdns: factory });
    const [mdns] = instances;
    assertDefined(mdns);
    const before = mdns.responses.length;

    handle?.stop();

    expect(mdns.responses.length).toBeGreaterThan(before);
    const goodbye = mdns.responses[mdns.responses.length - 1];
    assertDefined(goodbye);
    expect(goodbye.res.answers.length).toBeGreaterThanOrEqual(1);
    for (const answer of goodbye.res.answers) expect(answer.ttl).toBe(0);
    expect(mdns.destroyed).toBe(true);
  });

  test("factory/socket errors are non-fatal", () => {
    const throwingFactory: MdnsFactory = () => {
      throw new Error("EADDRINUSE");
    };
    let handle: MdnsResponderHandle | null | undefined;
    expect(() => {
      handle = startMdnsResponder([makeAssistantAdvert()], { makeMdns: throwingFactory });
    }).not.toThrow();
    expect(() => handle?.stop()).not.toThrow();

    const { factory, instances } = createStubMdnsFactory();
    const handle2 = startMdnsResponder([makeGuardianAdvert()], { makeMdns: factory });
    const [mdns] = instances;
    assertDefined(mdns);
    expect(() => mdns.emitError(new Error("EACCES"))).not.toThrow();
    handle2?.stop();
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
  });

  afterEach(() => {
    _resetMdnsResponderForTests();
    _setMdnsFactoryForTests(null);
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

  test("starts the responder when stack.env enables LAN exposure", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, instances } = createStubMdnsFactory();
    const status = reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });
    expect(instances.length).toBeGreaterThanOrEqual(1);
    expect(status.assistant.advertised).toBe(true);
  });

  test("is idempotent for an unchanged env", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, instances } = createStubMdnsFactory();
    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });
    const countAfterFirst = instances.length;
    const [first] = instances;
    assertDefined(first);

    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });

    expect(instances.length).toBe(countAfterFirst); // no new responder created
    expect(first.destroyed).toBe(false); // unchanged handle not stopped
  });

  test("stops the responder when the env returns to loopback", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, instances } = createStubMdnsFactory();
    reconcileMdnsResponder(home, { makeMdns: factory, hostIpv4: ["192.168.1.20"] });
    const [first] = instances;
    assertDefined(first);
    const before = first.responses.length;

    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=127.0.0.1\n");
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
});
