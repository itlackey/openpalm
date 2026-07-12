# c7-mdns-records: mdns-responder: validate IPv4 for A records + RFC 6762 legacy-unicast replies

_Severity: major+minor. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🟠 `packages/lib/src/control-plane/mdns-responder.ts:341` (r3566892051)

ipv4ToBytes produces a malformed A record for any non-IPv4 advert address (IPv6 literal / hostname) → corrupt DNS multicast on the LAN. ipv4ToBytes does address.split('.').map(part=>Number.parseInt(part,10)&0xff) with no validation. isLoopback only matches 127.0.0.1/localhost/::1, so fd00::5 passes gating, and resolveAdvertAddresses returns [v] verbatim for any specific (non-''/0.0.0.0/::) bind. So OP_BIND_ADDRESS=fd00::5 → split('.')=['fd00::5'] → parseInt='NaN' → &0xff=0 → rdata [0] with rdlength=1 (not 4); a hostname yields [0,0]. This malformed A record is multicast on every announce/answer. Fix: validate that the address is a dotted-quad IPv4 before encoding (skip non-IPv4 addresses, or emit an AAAA record for IPv6).

### 🟡 `packages/lib/src/control-plane/mdns-responder.ts:505` (r3566892362)

Legacy (non-5353-source) unicast replies violate RFC 6762 §6.7 → conventional one-shot resolvers reject them. The legacy=rinfo.port!==MDNS_PORT branch builds its reply with the same buildMdnsAnswer/buildPacket used for multicast (only the query id differs), so for a one-shot legacy-unicast query it: does not echo the question (buildHeader hardcodes qdcount=0); sets the cache-flush bit (buildARecord uses CLASS_IN|CACHE_FLUSH_BIT=0x8001); uses TTL 120 instead of ≤10s. A LAN client doing a one-shot query from an ephemeral port discards a response with no question echo and/or the top class bit set. Fix: for legacy-unicast replies, echo the question (qdcount=1), clear the cache-flush bit (CLASS_IN), and use a short TTL (≤10s), per RFC 6762 §6.7.

## Verification gates

- `bun run lib:test`
