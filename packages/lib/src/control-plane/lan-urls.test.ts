/**
 * `buildLanUrls` / `collectNonInternalIpv4` — the Phase 2 access-status
 * endpoint's "what do I type on my phone" answer.
 *
 * Pure and interface-list-injectable by design (see the module doc comment),
 * so every case here runs with a plain object literal — no real network
 * interface is ever touched.
 */
import { describe, expect, test } from "bun:test";
import { buildLanUrls, collectNonInternalIpv4, type LanInterfaceMap } from "./lan-urls.ts";

const ETH0_ONLY: LanInterfaceMap = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [{ address: "192.168.1.42", family: "IPv4", internal: false }],
};

describe("collectNonInternalIpv4", () => {
  test("keeps non-internal IPv4 addresses only", () => {
    expect(collectNonInternalIpv4(ETH0_ONLY)).toEqual(["192.168.1.42"]);
  });

  test("drops internal (loopback) entries", () => {
    expect(
      collectNonInternalIpv4({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }),
    ).toEqual([]);
  });

  test("drops IPv6 entries, including the numeric legacy family (4/6)", () => {
    expect(
      collectNonInternalIpv4({
        eth0: [
          { address: "fe80::1", family: "IPv6", internal: false },
          { address: "10.0.0.5", family: 4, internal: false },
          { address: "fe80::2", family: 6, internal: false },
        ],
      }),
    ).toEqual(["10.0.0.5"]);
  });

  test("collects across multiple interfaces, tolerates an undefined entry list", () => {
    expect(
      collectNonInternalIpv4({
        eth0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
        docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
        tun0: undefined,
      }),
    ).toEqual(["192.168.1.5", "172.17.0.1"]);
  });

  test("an interface list with nothing reachable yields an empty array", () => {
    expect(collectNonInternalIpv4({})).toEqual([]);
  });
});

describe("buildLanUrls", () => {
  test("the mDNS name comes first, then every non-internal IPv4 address", () => {
    expect(buildLanUrls({ port: 3800, projectName: "openpalm", interfaces: ETH0_ONLY })).toEqual([
      "http://openpalm.local:3800",
      "http://192.168.1.42:3800",
    ]);
  });

  test("an empty project name still yields the openpalm.local default", () => {
    expect(buildLanUrls({ port: 3800, projectName: "", interfaces: {} })).toEqual([
      "http://openpalm.local:3800",
    ]);
  });

  test("the project name is sanitized into a DNS label, same as mDNS advertisement", () => {
    expect(buildLanUrls({ port: 3800, projectName: "My Lab", interfaces: {} })).toEqual([
      "http://my-lab.local:3800",
    ]);
  });

  test("no reachable interfaces still returns the .local URL alone", () => {
    expect(buildLanUrls({ port: 3800, projectName: "openpalm", interfaces: {} })).toEqual([
      "http://openpalm.local:3800",
    ]);
  });

  test("the port is carried through to every URL, including a custom one", () => {
    expect(buildLanUrls({ port: 4200, projectName: "openpalm", interfaces: ETH0_ONLY })).toEqual([
      "http://openpalm.local:4200",
      "http://192.168.1.42:4200",
    ]);
  });
});
