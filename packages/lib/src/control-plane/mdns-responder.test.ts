/**
 * #488 — Guardian/assistant LAN mDNS self-advertisement (host control-plane
 * responder in @openpalm/lib).
 *
 * Spec: .github/roadmap/0.13.0/specs/488.md §2.1.
 *
 * Idioms mirrored: bind-warning.test.ts (plain env-record in/out assertions),
 * network-partitioning.test.ts (socket-free fixture style), and the injected-deps
 * pattern used across lib (e.g. apply-stack-di.test.ts, project-rename.test.ts).
 * No real sockets anywhere — the responder tests use a stub socket factory
 * (MdnsSocketLike) and hand-rolled Uint8Array DNS packet fixtures.
 *
 * RED REASON: the module ./mdns-responder.js does not exist yet — every test
 * in this file fails at import.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMdnsAnnouncement,
  buildMdnsAnswer,
  buildMdnsGoodbye,
  deriveMdnsNames,
  reconcileMdnsResponder,
  resolveMdnsAdvertisements,
  resolveMdnsStatus,
  sanitizeDnsLabel,
  parseDnsQuestions,
  startMdnsResponder,
  _resetMdnsResponderForTests,
  _setMdnsSocketFactoryForTests,
  type DnsQuestion,
  type MdnsAdvertisement,
  type MdnsRemoteInfo,
  type MdnsResponderHandle,
  type MdnsSocketFactory,
  type MdnsSocketLike,
} from "./mdns-responder.js";

// ── DNS wire-format fixture helpers (independent hand-rolled encoder/decoder —
//    NOT the implementation under test) ──────────────────────────────────────

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const TYPE_ANY = 255;
const CLASS_IN = 1;
const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const HTTP_SERVICE = "_http._tcp.local";

function encodeName(name: string): number[] {
  const bytes: number[] = [];
  for (const label of name.split(".")) {
    if (label.length === 0) continue;
    bytes.push(label.length);
    for (let i = 0; i < label.length; i++) bytes.push(label.charCodeAt(i));
  }
  bytes.push(0);
  return bytes;
}

function buildHeader(
  id: number,
  flags: number,
  qdcount: number,
  ancount = 0,
  nscount = 0,
  arcount = 0,
): number[] {
  return [
    (id >> 8) & 0xff,
    id & 0xff,
    (flags >> 8) & 0xff,
    flags & 0xff,
    (qdcount >> 8) & 0xff,
    qdcount & 0xff,
    (ancount >> 8) & 0xff,
    ancount & 0xff,
    (nscount >> 8) & 0xff,
    nscount & 0xff,
    (arcount >> 8) & 0xff,
    arcount & 0xff,
  ];
}

function buildQuestion(name: string, type: number, qclass = CLASS_IN): number[] {
  return [...encodeName(name), (type >> 8) & 0xff, type & 0xff, (qclass >> 8) & 0xff, qclass & 0xff];
}

function buildQueryPacket(
  name: string,
  type: number,
  opts: { id?: number; flags?: number } = {},
): Uint8Array {
  const id = opts.id ?? 0;
  const flags = opts.flags ?? 0;
  const header = buildHeader(id, flags, 1);
  const question = buildQuestion(name, type);
  return new Uint8Array([...header, ...question]);
}

/** Safe indexed byte read — every buffer here is one this file built or the
 * implementation returned, so an out-of-range read only ever means a fixture
 * bug, and a 0 fallback keeps the decoder assertion-free (no `!`). */
function byteAt(buf: Uint8Array, index: number): number {
  return buf[index] ?? 0;
}

/** Narrows `value` to non-undefined without a non-null assertion. */
function assertDefined<T>(value: T | undefined, message = "expected value to be defined"): asserts value is T {
  if (value === undefined) throw new Error(message);
}

function readU16(buf: Uint8Array, off: number): number {
  return (byteAt(buf, off) << 8) | byteAt(buf, off + 1);
}

function readU32(buf: Uint8Array, off: number): number {
  return (
    (byteAt(buf, off) << 24) |
    (byteAt(buf, off + 1) << 16) |
    (byteAt(buf, off + 2) << 8) |
    byteAt(buf, off + 3)
  ) >>> 0;
}

function decodeNameAt(buf: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  while (pos < buf.length) {
    const len = byteAt(buf, pos);
    if (len === 0) {
      pos += 1;
      break;
    }
    pos += 1;
    let label = "";
    for (let i = 0; i < len; i++) label += String.fromCharCode(byteAt(buf, pos + i));
    labels.push(label);
    pos += len;
  }
  return { name: labels.join("."), next: pos };
}

function decodeTxtRdata(buf: Uint8Array): string {
  const parts: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const len = byteAt(buf, pos);
    pos += 1;
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(byteAt(buf, pos + i));
    parts.push(s);
    pos += len;
  }
  return parts.join(";");
}

type DecodedRecord = { name: string; type: number; qclass: number; ttl?: number; rdata?: Uint8Array };
type DecodedPacket = {
  id: number;
  flags: number;
  qdcount: number;
  ancount: number;
  nscount: number;
  arcount: number;
  questions: DecodedRecord[];
  answers: DecodedRecord[];
  authorities: DecodedRecord[];
  additionals: DecodedRecord[];
};

/**
 * Decode a full mDNS/DNS message (header + question + RR sections). Assumes
 * no name compression, matching the spec's encoder contract ("no name
 * compression ... keeps the encoder ~trivial"). This is a test-owned decoder,
 * independent of the implementation under test.
 */
function decodeMdnsPacket(buf: Uint8Array): DecodedPacket {
  const id = readU16(buf, 0);
  const flags = readU16(buf, 2);
  const qdcount = readU16(buf, 4);
  const ancount = readU16(buf, 6);
  const nscount = readU16(buf, 8);
  const arcount = readU16(buf, 10);
  let pos = 12;

  const questions: DecodedRecord[] = [];
  for (let i = 0; i < qdcount; i++) {
    const { name, next } = decodeNameAt(buf, pos);
    const type = readU16(buf, next);
    const qclass = readU16(buf, next + 2);
    questions.push({ name, type, qclass });
    pos = next + 4;
  }

  function decodeRR(): DecodedRecord {
    const { name, next } = decodeNameAt(buf, pos);
    const type = readU16(buf, next);
    const qclass = readU16(buf, next + 2);
    const ttl = readU32(buf, next + 4);
    const rdlength = readU16(buf, next + 8);
    const rdataStart = next + 10;
    const rdata = buf.slice(rdataStart, rdataStart + rdlength);
    pos = rdataStart + rdlength;
    return { name, type, qclass, ttl, rdata };
  }

  const answers = Array.from({ length: ancount }, () => decodeRR());
  const authorities = Array.from({ length: nscount }, () => decodeRR());
  const additionals = Array.from({ length: arcount }, () => decodeRR());

  return { id, flags, qdcount, ancount, nscount, arcount, questions, answers, authorities, additionals };
}

function makeAssistantAdvert(overrides: Partial<MdnsAdvertisement> = {}): MdnsAdvertisement {
  return {
    service: "assistant",
    name: "openpalm.local",
    port: 3800,
    addresses: ["192.168.1.20"],
    ...overrides,
  };
}

function makeGuardianAdvert(overrides: Partial<MdnsAdvertisement> = {}): MdnsAdvertisement {
  return {
    service: "guardian",
    name: "openpalm-guardian.local",
    port: 3830,
    addresses: ["192.168.1.20"],
    ...overrides,
  };
}

// ── Stub socket (records bind/addMembership/send/close; emits message/error) ─

class StubSocket implements MdnsSocketLike {
  bindCalls: Array<{ port: number; address: string }> = [];
  memberships: string[] = [];
  ttlCalls: number[] = [];
  sends: Array<{ msg: Uint8Array; port: number; address: string }> = [];
  closed = false;
  unrefCalled = false;
  private messageHandler?: (msg: Uint8Array, rinfo: MdnsRemoteInfo) => void;
  private errorHandler?: (err: Error) => void;

  bind(port: number, address: string, cb?: () => void): void {
    this.bindCalls.push({ port, address });
    cb?.();
  }
  addMembership(mcastAddr: string): void {
    this.memberships.push(mcastAddr);
  }
  setMulticastTTL(ttl: number): void {
    this.ttlCalls.push(ttl);
  }
  send(msg: Uint8Array, port: number, address: string): void {
    this.sends.push({ msg, port, address });
  }
  close(): void {
    this.closed = true;
  }
  on(event: "message", cb: (msg: Uint8Array, rinfo: MdnsRemoteInfo) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "message" | "error", cb: never): void {
    if (event === "message") this.messageHandler = cb as (msg: Uint8Array, rinfo: MdnsRemoteInfo) => void;
    else this.errorHandler = cb as (err: Error) => void;
  }
  unref(): void {
    this.unrefCalled = true;
  }
  emitMessage(msg: Uint8Array, rinfo: MdnsRemoteInfo): void {
    this.messageHandler?.(msg, rinfo);
  }
  emitError(err: Error): void {
    this.errorHandler?.(err);
  }
}

function createStubSocketFactory(): { factory: MdnsSocketFactory; sockets: StubSocket[] } {
  const sockets: StubSocket[] = [];
  const factory: MdnsSocketFactory = () => {
    const socket = new StubSocket();
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

// ── 1-6: name derivation ──────────────────────────────────────────────────

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

// ── 7-14: gating truth table ─────────────────────────────────────────────

describe("resolveMdnsAdvertisements", () => {
  const HOST_IPV4 = ["192.168.1.20"];

  test("empty env advertises nothing", () => {
    expect(resolveMdnsAdvertisements({}, HOST_IPV4)).toEqual([]);
  });

  test("explicit loopback values advertise nothing", () => {
    expect(
      resolveMdnsAdvertisements(
        { OP_BIND_ADDRESS: "127.0.0.1", OP_ASSISTANT_BIND_ADDRESS: "localhost" },
        HOST_IPV4,
      ),
    ).toEqual([]);
  });

  test("OP_BIND_ADDRESS=0.0.0.0 advertises the guardian name only (direct ingress on)", () => {
    const adverts = resolveMdnsAdvertisements(
      { OP_BIND_ADDRESS: "0.0.0.0", GUARDIAN_DIRECT_INGRESS: "true" },
      HOST_IPV4,
    );
    expect(adverts).toEqual([
      { service: "guardian", name: "openpalm-guardian.local", port: 3830, addresses: HOST_IPV4 },
    ]);
  });

  // PR #564 P2-1: a LAN-visible guardian bind must NOT be advertised while the
  // direct-ingress listener is disabled — else mDNS points the LAN at a 3830
  // listener that 404s (the shared-guardian preset leaves ingress off).
  test("OP_BIND_ADDRESS=0.0.0.0 advertises NOTHING when GUARDIAN_DIRECT_INGRESS is off/absent", () => {
    expect(resolveMdnsAdvertisements({ OP_BIND_ADDRESS: "0.0.0.0" }, HOST_IPV4)).toEqual([]);
    expect(
      resolveMdnsAdvertisements({ OP_BIND_ADDRESS: "0.0.0.0", GUARDIAN_DIRECT_INGRESS: "false" }, HOST_IPV4),
    ).toEqual([]);
    // Only a literal 'true' opens ingress (mirrors guardian server.ts).
    expect(
      resolveMdnsAdvertisements({ OP_BIND_ADDRESS: "0.0.0.0", GUARDIAN_DIRECT_INGRESS: "1" }, HOST_IPV4),
    ).toEqual([]);
  });

  test("resolveMdnsStatus reports guardian advertised:false when a LAN bind has ingress off", () => {
    expect(resolveMdnsStatus({ OP_BIND_ADDRESS: "0.0.0.0" }, HOST_IPV4).guardian.advertised).toBe(false);
    expect(
      resolveMdnsStatus({ OP_BIND_ADDRESS: "0.0.0.0", GUARDIAN_DIRECT_INGRESS: "true" }, HOST_IPV4).guardian.advertised,
    ).toBe(true);
  });

  // PR #564 retest P2-5: a bind-gated service with no encodable IPv4 address
  // (IPv6/hostname-only) must report advertised:false — never a phantom true.
  test("resolveMdnsStatus reports advertised:false for an IPv6-only bind (no A record emitted)", () => {
    const status = resolveMdnsStatus(
      { OP_BIND_ADDRESS: "2001:db8::10", GUARDIAN_DIRECT_INGRESS: "true" },
      HOST_IPV4,
    );
    expect(status.guardian.advertised).toBe(false);
    // And the advertisement list is genuinely empty for that bind.
    expect(
      resolveMdnsAdvertisements({ OP_BIND_ADDRESS: "2001:db8::10", GUARDIAN_DIRECT_INGRESS: "true" }, HOST_IPV4),
    ).toEqual([]);
  });

  test("resolveMdnsStatus reports advertised:false for an assistant hostname bind", () => {
    expect(
      resolveMdnsStatus({ OP_ASSISTANT_BIND_ADDRESS: "my-host.lan" }, HOST_IPV4).assistant.advertised,
    ).toBe(false);
  });

  test("OP_ASSISTANT_BIND_ADDRESS=0.0.0.0 advertises the assistant name only", () => {
    const adverts = resolveMdnsAdvertisements({ OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" }, HOST_IPV4);
    expect(adverts).toEqual([
      { service: "assistant", name: "openpalm.local", port: 3800, addresses: HOST_IPV4 },
    ]);
  });

  test("both non-loopback advertises both; custom ports respected", () => {
    const adverts = resolveMdnsAdvertisements(
      {
        OP_BIND_ADDRESS: "0.0.0.0",
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
      { OP_BIND_ADDRESS: "192.168.1.5", GUARDIAN_DIRECT_INGRESS: "true" },
      HOST_IPV4,
    );
    expect(adverts).toEqual([
      { service: "guardian", name: "openpalm-guardian.local", port: 3830, addresses: ["192.168.1.5"] },
    ]);
  });

  test('OP_MDNS=off disables everything even with non-loopback binds', () => {
    for (const off of ["off", "0", "false"]) {
      const adverts = resolveMdnsAdvertisements(
        { OP_BIND_ADDRESS: "0.0.0.0", OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0", OP_MDNS: off },
        HOST_IPV4,
      );
      expect(adverts).toEqual([]);
    }
  });

  // PR #564 r3566892051: a specific non-IPv4 bind (IPv6 literal / hostname)
  // must not be encoded into an A record — it would emit malformed rdata
  // (NaN&0xff bytes, wrong rdlength). Skip it instead.
  test("a specific IPv6 bind is skipped (no malformed A record)", () => {
    expect(
      resolveMdnsAdvertisements({ OP_BIND_ADDRESS: "fd00::5", GUARDIAN_DIRECT_INGRESS: "true" }, HOST_IPV4),
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
      { service: "assistant", name: "openpalm.local", port: 3800, addresses: ["192.168.1.7"] },
    ]);
  });

  test("wildcard bind filters host addresses to IPv4 only", () => {
    const adverts = resolveMdnsAdvertisements(
      { OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" },
      ["192.168.1.20", "fe80::1", "not-an-ip"],
    );
    expect(adverts).toEqual([
      { service: "assistant", name: "openpalm.local", port: 3800, addresses: ["192.168.1.20"] },
    ]);
  });
});

describe("resolveMdnsStatus", () => {
  test("reports names/ports with advertised flags", () => {
    const status = resolveMdnsStatus({});
    expect(status).toEqual({
      assistant: { name: "openpalm.local", port: 3800, advertised: false },
      guardian: { name: "openpalm-guardian.local", port: 3830, advertised: false },
    });
  });
});

// ── 15-25: DNS wire format ────────────────────────────────────────────────

describe("parseDnsQuestions", () => {
  test("decodes a standard A question", () => {
    const packet = buildQueryPacket("OpenPalm.local", TYPE_A);
    expect(parseDnsQuestions(packet)).toEqual([{ name: "openpalm.local", type: TYPE_A, qclass: CLASS_IN }]);
  });

  test("returns null for a response packet (QR=1)", () => {
    const packet = buildQueryPacket("openpalm.local", TYPE_A, { flags: 0x8000 });
    expect(parseDnsQuestions(packet)).toBeNull();
  });

  test("returns null for truncated/malformed packets without throwing", () => {
    expect(() => parseDnsQuestions(new Uint8Array())).not.toThrow();
    expect(parseDnsQuestions(new Uint8Array())).toBeNull();

    const headerOnly = new Uint8Array(buildHeader(0, 0, 1));
    expect(() => parseDnsQuestions(headerOnly)).not.toThrow();
    expect(parseDnsQuestions(headerOnly)).toBeNull();

    const full = buildQueryPacket("openpalm.local", TYPE_A);
    const cutMidName = full.slice(0, full.length - 6);
    expect(() => parseDnsQuestions(cutMidName)).not.toThrow();
    expect(parseDnsQuestions(cutMidName)).toBeNull();
  });

  test("handles a compression pointer without looping forever", () => {
    // Self-referencing pointer: the question name at offset 12 is a 2-byte
    // pointer (0xC0, 0x0C) pointing back at offset 12 — itself.
    const header = buildHeader(0, 0, 1);
    const question = [0xc0, 0x0c, 0x00, TYPE_A, 0x00, CLASS_IN];
    const packet = new Uint8Array([...header, ...question]);
    let result: unknown;
    expect(() => {
      result = parseDnsQuestions(packet);
    }).not.toThrow();
    expect(result).toBeNull();
  });
});

describe("buildMdnsAnswer", () => {
  test("answers an A query for an advertised name", () => {
    const advert = makeAssistantAdvert();
    const questions: DnsQuestion[] = [{ name: "openpalm.local", type: TYPE_A, qclass: CLASS_IN }];
    const packet = buildMdnsAnswer(questions, [advert]);
    expect(packet).not.toBeNull();
    const decoded = decodeMdnsPacket(packet as Uint8Array);
    expect(decoded.id).toBe(0);
    // QR (0x8000) + AA (0x0400) both set.
    expect(decoded.flags & 0x8400).toBe(0x8400);
    expect(decoded.ancount).toBeGreaterThanOrEqual(1);
    const answer = decoded.answers.find((a) => a.type === TYPE_A);
    assertDefined(answer);
    assertDefined(answer.rdata);
    expect((answer.qclass & 0x8000) !== 0).toBe(true); // cache-flush bit
    expect(answer.qclass & 0x7fff).toBe(CLASS_IN);
    expect(answer.ttl).toBe(120);
    expect(Array.from(answer.rdata)).toEqual([192, 168, 1, 20]);
    expect(answer.name.toLowerCase()).toBe("openpalm.local");
  });

  test("answers TYPE_ANY queries for an advertised name", () => {
    const advert = makeAssistantAdvert();
    const questions: DnsQuestion[] = [{ name: "openpalm.local", type: TYPE_ANY, qclass: CLASS_IN }];
    const packet = buildMdnsAnswer(questions, [advert]);
    expect(packet).not.toBeNull();
    const decoded = decodeMdnsPacket(packet as Uint8Array);
    expect(decoded.answers.some((a) => a.type === TYPE_A)).toBe(true);
  });

  test("returns null for an unknown name", () => {
    const advert = makeAssistantAdvert();
    const questions: DnsQuestion[] = [{ name: "unknown.local", type: TYPE_A, qclass: CLASS_IN }];
    expect(buildMdnsAnswer(questions, [advert])).toBeNull();
  });

  test("matches names case-insensitively", () => {
    const advert = makeAssistantAdvert();
    const questions: DnsQuestion[] = [{ name: "OpenPalm.LOCAL", type: TYPE_A, qclass: CLASS_IN }];
    expect(buildMdnsAnswer(questions, [advert])).not.toBeNull();
  });

  test("answers a PTR query for _http._tcp.local with SRV/TXT/A additionals", () => {
    const advert = makeAssistantAdvert();
    const questions: DnsQuestion[] = [{ name: HTTP_SERVICE, type: TYPE_PTR, qclass: CLASS_IN }];
    const packet = buildMdnsAnswer(questions, [advert]);
    expect(packet).not.toBeNull();
    const decoded = decodeMdnsPacket(packet as Uint8Array);

    const ptr = decoded.answers.find((a) => a.type === TYPE_PTR);
    assertDefined(ptr);
    assertDefined(ptr.rdata);
    expect(ptr.name.toLowerCase()).toBe(HTTP_SERVICE);
    const instanceName = decodeNameAt(ptr.rdata, 0).name.toLowerCase();
    expect(instanceName).toBe(`openpalm.${HTTP_SERVICE}`);

    const srv = decoded.additionals.find((a) => a.type === TYPE_SRV);
    assertDefined(srv);
    assertDefined(srv.rdata);
    expect(srv.name.toLowerCase()).toBe(instanceName);
    const srvPort = readU16(srv.rdata, 4);
    expect(srvPort).toBe(3800);
    const srvTarget = decodeNameAt(srv.rdata, 6).name.toLowerCase();
    expect(srvTarget).toBe("openpalm.local");

    const txt = decoded.additionals.find((a) => a.type === TYPE_TXT);
    assertDefined(txt);
    assertDefined(txt.rdata);
    expect(decodeTxtRdata(txt.rdata)).toContain("path=/");

    const aRec = decoded.additionals.find(
      (a) => a.type === TYPE_A && a.name.toLowerCase() === "openpalm.local",
    );
    assertDefined(aRec);
    assertDefined(aRec.rdata);
    expect(Array.from(aRec.rdata)).toEqual([192, 168, 1, 20]);
  });

  test("preserves the query ID and answers unicast for legacy (non-5353 source) queries", () => {
    const advert = makeAssistantAdvert();
    const questions: DnsQuestion[] = [{ name: "openpalm.local", type: TYPE_A, qclass: CLASS_IN }];
    const packet = buildMdnsAnswer(questions, [advert], { queryId: 0x1234 });
    expect(packet).not.toBeNull();
    const decoded = decodeMdnsPacket(packet as Uint8Array);
    expect(decoded.id).toBe(0x1234);
  });

  // PR #564 r3566892362: legacy-unicast replies (RFC 6762 §6.7) must echo the
  // question, clear the cache-flush bit, and use a short (≤10s) TTL — otherwise
  // conventional one-shot resolvers reject them.
  const CACHE_FLUSH = 0x8000;
  test("legacy-unicast reply echoes the question (qdcount=1)", () => {
    const advert = makeAssistantAdvert();
    const questions: DnsQuestion[] = [{ name: "openpalm.local", type: TYPE_A, qclass: CLASS_IN }];
    const packet = buildMdnsAnswer(questions, [advert], { queryId: 0x1234, legacy: true });
    const decoded = decodeMdnsPacket(packet as Uint8Array);
    expect(decoded.qdcount).toBe(1);
    expect(decoded.questions[0].name.toLowerCase()).toBe("openpalm.local");
    expect(decoded.questions[0].type).toBe(TYPE_A);
  });

  test("legacy-unicast A record clears the cache-flush bit and uses a short TTL", () => {
    const advert = makeAssistantAdvert();
    const questions: DnsQuestion[] = [{ name: "openpalm.local", type: TYPE_A, qclass: CLASS_IN }];
    const packet = buildMdnsAnswer(questions, [advert], { queryId: 0x1234, legacy: true });
    const decoded = decodeMdnsPacket(packet as Uint8Array);
    const a = decoded.answers.find((r) => r.type === TYPE_A);
    assertDefined(a);
    expect(a.qclass & CACHE_FLUSH).toBe(0); // cache-flush bit cleared
    expect(a.qclass & 0x7fff).toBe(CLASS_IN);
    expect(a.ttl).toBeLessThanOrEqual(10);
  });

  test("multicast reply keeps qdcount=0, cache-flush set, TTL 120", () => {
    const advert = makeAssistantAdvert();
    const questions: DnsQuestion[] = [{ name: "openpalm.local", type: TYPE_A, qclass: CLASS_IN }];
    const packet = buildMdnsAnswer(questions, [advert]);
    const decoded = decodeMdnsPacket(packet as Uint8Array);
    expect(decoded.qdcount).toBe(0);
    const a = decoded.answers.find((r) => r.type === TYPE_A);
    assertDefined(a);
    expect(a.qclass & CACHE_FLUSH).toBe(CACHE_FLUSH);
    expect(a.ttl).toBe(120);
  });
});

describe("buildMdnsAnnouncement / buildMdnsGoodbye", () => {
  test("buildMdnsGoodbye emits TTL 0 records for every advert", () => {
    const packet = buildMdnsGoodbye([makeAssistantAdvert(), makeGuardianAdvert()]);
    expect(packet).not.toBeNull();
    const decoded = decodeMdnsPacket(packet as Uint8Array);
    expect(decoded.answers.length).toBeGreaterThanOrEqual(2);
    for (const answer of decoded.answers) {
      expect(answer.ttl).toBe(0);
    }
  });

  test("buildMdnsAnnouncement produces at least one A answer per advert", () => {
    const packet = buildMdnsAnnouncement([makeAssistantAdvert(), makeGuardianAdvert()]);
    expect(packet).not.toBeNull();
    const decoded = decodeMdnsPacket(packet as Uint8Array);
    const aNames = decoded.answers.filter((a) => a.type === TYPE_A).map((a) => a.name.toLowerCase());
    expect(aNames).toContain("openpalm.local");
    expect(aNames).toContain("openpalm-guardian.local");
  });
});

// ── 26-31: responder lifecycle (stub socket factory) ─────────────────────

describe("startMdnsResponder", () => {
  test("returns null and opens no socket when there is nothing to advertise", () => {
    const { factory, sockets } = createStubSocketFactory();
    const handle = startMdnsResponder([], { createSocket: factory });
    expect(handle).toBeNull();
    expect(sockets).toHaveLength(0);
  });

  test("binds 5353, joins 224.0.0.251, and announces", () => {
    const { factory, sockets } = createStubSocketFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { createSocket: factory });
    expect(handle).not.toBeNull();
    expect(sockets).toHaveLength(1);
    const [socket] = sockets;
    assertDefined(socket);
    expect(socket.bindCalls).toHaveLength(1);
    const [bindCall] = socket.bindCalls;
    assertDefined(bindCall);
    expect(bindCall.port).toBe(MDNS_PORT);
    expect(socket.memberships).toContain(MDNS_ADDR);
    expect(socket.sends.length).toBeGreaterThanOrEqual(1);
    const [firstSend] = socket.sends;
    assertDefined(firstSend);
    expect(firstSend.address).toBe(MDNS_ADDR);
    expect(firstSend.port).toBe(MDNS_PORT);
    handle?.stop();
  });

  test("responder answers a matching query received on the socket", () => {
    const { factory, sockets } = createStubSocketFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { createSocket: factory });
    const [socket] = sockets;
    assertDefined(socket);
    socket.sends.length = 0; // clear the startup announcement(s)

    socket.emitMessage(buildQueryPacket("openpalm.local", TYPE_A), { address: "192.168.1.50", port: MDNS_PORT });

    expect(socket.sends.length).toBeGreaterThanOrEqual(1);
    const response = socket.sends[socket.sends.length - 1];
    assertDefined(response);
    expect(response.address).toBe(MDNS_ADDR);
    expect(response.port).toBe(MDNS_PORT);
    const decoded = decodeMdnsPacket(response.msg);
    const answer = decoded.answers.find((a) => a.type === TYPE_A);
    assertDefined(answer);
    assertDefined(answer.rdata);
    expect(Array.from(answer.rdata)).toEqual([192, 168, 1, 20]);
    handle?.stop();
  });

  test("ignores non-matching and malformed messages", () => {
    const { factory, sockets } = createStubSocketFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { createSocket: factory });
    const [socket] = sockets;
    assertDefined(socket);
    socket.sends.length = 0;

    socket.emitMessage(buildQueryPacket("unknown.local", TYPE_A), { address: "192.168.1.50", port: MDNS_PORT });
    expect(socket.sends).toHaveLength(0);

    socket.emitMessage(new Uint8Array([1, 2, 3]), { address: "192.168.1.50", port: MDNS_PORT });
    expect(socket.sends).toHaveLength(0);

    handle?.stop();
  });

  test("stop() sends goodbye and closes the socket", () => {
    const { factory, sockets } = createStubSocketFactory();
    const handle = startMdnsResponder([makeAssistantAdvert()], { createSocket: factory });
    const [socket] = sockets;
    assertDefined(socket);
    const sendsBefore = socket.sends.length;

    handle?.stop();

    expect(socket.sends.length).toBeGreaterThan(sendsBefore);
    const goodbye = socket.sends[socket.sends.length - 1];
    assertDefined(goodbye);
    const decoded = decodeMdnsPacket(goodbye.msg);
    expect(decoded.answers.length).toBeGreaterThanOrEqual(1);
    for (const answer of decoded.answers) {
      expect(answer.ttl).toBe(0);
    }
    expect(socket.closed).toBe(true);
  });

  test("socket errors are non-fatal", () => {
    const throwingFactory: MdnsSocketFactory = () => {
      throw new Error("EADDRINUSE");
    };
    let handle: MdnsResponderHandle | null | undefined;
    expect(() => {
      handle = startMdnsResponder([makeAssistantAdvert()], { createSocket: throwingFactory });
    }).not.toThrow();
    // Either the handle is inert (null) or stop() on it is still safe.
    expect(() => handle?.stop()).not.toThrow();

    const { factory, sockets } = createStubSocketFactory();
    const handle2 = startMdnsResponder([makeAssistantAdvert()], { createSocket: factory });
    const [socket] = sockets;
    assertDefined(socket);
    expect(() => socket.emitError(new Error("EACCES"))).not.toThrow();
    handle2?.stop();
  });
});

// ── 32-36: reconcile ──────────────────────────────────────────────────────

describe("reconcileMdnsResponder", () => {
  const homes: string[] = [];

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "openpalm-mdns-"));
    mkdirSync(join(home, "knowledge", "env"), { recursive: true });
    homes.push(home);
    return home;
  }

  function writeStackEnv(home: string, content: string): void {
    writeFileSync(join(home, "knowledge", "env", "stack.env"), content);
  }

  beforeEach(() => {
    _resetMdnsResponderForTests();
    _setMdnsSocketFactoryForTests(null);
  });

  afterEach(() => {
    _resetMdnsResponderForTests();
    _setMdnsSocketFactoryForTests(null);
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("starts nothing for a loopback stack.env", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_BIND_ADDRESS=127.0.0.1\n");
    const { factory, sockets } = createStubSocketFactory();
    const status = reconcileMdnsResponder(home, { createSocket: factory, hostIpv4: ["192.168.1.20"] });
    expect(sockets).toHaveLength(0);
    expect(status.assistant.advertised).toBe(false);
    expect(status.guardian.advertised).toBe(false);
  });

  test("starts the responder when stack.env enables LAN exposure", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, sockets } = createStubSocketFactory();
    const status = reconcileMdnsResponder(home, { createSocket: factory, hostIpv4: ["192.168.1.20"] });
    expect(sockets.length).toBeGreaterThanOrEqual(1);
    expect(status.assistant.advertised).toBe(true);
  });

  test("is idempotent for an unchanged env", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, sockets } = createStubSocketFactory();
    reconcileMdnsResponder(home, { createSocket: factory, hostIpv4: ["192.168.1.20"] });
    const socketCountAfterFirst = sockets.length;
    const [firstSocket] = sockets;
    assertDefined(firstSocket);

    reconcileMdnsResponder(home, { createSocket: factory, hostIpv4: ["192.168.1.20"] });

    expect(sockets.length).toBe(socketCountAfterFirst); // no new socket opened
    expect(firstSocket.closed).toBe(false); // no stop() on the unchanged handle
  });

  test("stops the responder when the env returns to loopback", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, sockets } = createStubSocketFactory();
    reconcileMdnsResponder(home, { createSocket: factory, hostIpv4: ["192.168.1.20"] });
    const [firstSocket] = sockets;
    assertDefined(firstSocket);
    const sendsBefore = firstSocket.sends.length;

    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=127.0.0.1\n");
    const status = reconcileMdnsResponder(home, { createSocket: factory, hostIpv4: ["192.168.1.20"] });

    expect(firstSocket.sends.length).toBeGreaterThan(sendsBefore); // goodbye sent
    expect(firstSocket.closed).toBe(true);
    expect(status.assistant.advertised).toBe(false);
  });

  test("process.env OP_MDNS=0 force-disables reconcile regardless of stack.env", () => {
    const home = makeHome();
    writeStackEnv(home, "OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n");
    const { factory, sockets } = createStubSocketFactory();
    const status = reconcileMdnsResponder(home, {
      createSocket: factory,
      hostIpv4: ["192.168.1.20"],
      processEnv: { OP_MDNS: "0" },
    });
    expect(sockets).toHaveLength(0);
    expect(status.assistant.advertised).toBe(false);
  });
});
