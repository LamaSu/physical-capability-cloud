/**
 * N84 — operator-channel SSRF + HMAC signing oracle (Gate A row, LIVE).
 *
 * Written BEFORE any fix: this file reproduces the two holes in
 * routes/operator-channels.ts against the real, default code path and then
 * pins the behaviour the fix must have.
 *
 *   Hole 1 — SSRF. Any key can POST /api/operators/<any slug>/channels with a
 *     webhook URL of its choice and then POST .../channels/test. sendWebhook
 *     did fetch(url, { method: "POST" }) with no private-address guard, so the
 *     gateway would reach loopback, the internal network or cloud metadata.
 *
 *   Hole 2 — signing oracle. credentialRef named ANY PCC_VAULT_* env secret
 *     (resolveSecret). The gateway HMAC-signed a caller-influenced body with it
 *     and sent the signature to the caller's URL: a signing oracle over server
 *     secrets, and a secret-existence oracle (signed vs unsigned).
 *
 * Groups:
 *   A  reproduction against a REAL listener on 127.0.0.1 (loopback only; every
 *      target is an IP literal, so no DNS and no traffic leaves the machine).
 *   B  the URL guard as a unit: isBlockedAddress tables, checkOutboundUrl forms,
 *      attach-time refusal through the HTTP route (400 invalid_channel_url).
 *   C  the send-time decision logic with an INJECTED resolver and transport
 *      (no real DNS, no real sockets): hostname resolving to a private address,
 *      redirect to a private address, DNS rebinding, public control.
 *
 * The guard module (services/outbound-url-guard.ts) does not exist at the
 * commit where this file is first written, which is the point of reproducing
 * first; groups B and C load it lazily so group A still collects and runs
 * against today's code and shows the real evidence.
 *
 * Nothing here talks to a real secret: the vault value is a synthetic string
 * set for the duration of a test and restored afterwards.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import {
  attachChannel,
  dispatchToChannels,
  getChannelsByOperator,
  operatorChannelsRoutes,
  _clearOperatorChannelsForTests,
} from "../routes/operator-channels.js";

type Guard = typeof import("../services/outbound-url-guard.js");
async function loadGuard(): Promise<Guard> {
  return await import("../services/outbound-url-guard.js");
}

// ── shared fixtures ──────────────────────────────────────────────────────────

const SENTINEL_ENV = "PCC_VAULT_N84_SENTINEL";
const SENTINEL_VALUE = "n84-synthetic-secret";
const PUBLIC_V4 = "93.184.216.34";

/** Env vars this file touches; saved before and restored after every test. */
const ENV_KEYS = [SENTINEL_ENV, "PCC_CHANNEL_CREDENTIALS", "NODE_ENV"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env[SENTINEL_ENV];
  delete process.env.PCC_CHANNEL_CREDENTIALS;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A recording HTTP listener on 127.0.0.1 (random port): the "victim". */
const hits: Hit[] = [];
let listener: http.Server;
let port = 0;

beforeAll(async () => {
  listener = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.statusCode = 200;
      res.setHeader("x-request-id", "n84-listener");
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  port = (listener.address() as AddressInfo).port;
});

afterAll(async () => {
  listener.closeAllConnections?.();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

beforeEach(() => {
  hits.length = 0;
  _clearOperatorChannelsForTests();
});

const hmacHeader = (body: string) =>
  `sha256=${createHmac("sha256", SENTINEL_VALUE).update(body).digest("hex")}`;

// ── Group A: reproduction against a real loopback listener ───────────────────

describe("N84 repro (default code path, real listener on 127.0.0.1)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(operatorChannelsRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it("[neg] SSRF: an ordinary key cannot attach a loopback webhook and make the gateway POST to it", async () => {
    const slug = "n84-ssrf-victim";
    const attach = await app.inject({
      method: "POST",
      url: `/api/operators/${slug}/channels`,
      payload: {
        label: "attacker hook",
        transport: "webhook",
        describe: "SSRF probe: POST to a loopback listener",
        endpoint: { url: `http://127.0.0.1:${port}/hook` },
      },
    });
    const send = await app.inject({
      method: "POST",
      url: `/api/operators/${slug}/channels/test`,
      payload: {},
    });
    console.log(
      `[N84-REPRO] ssrf attachStatus=${attach.statusCode} listenerHits=${hits.length} ` +
        `hits=${JSON.stringify(hits.map((h) => ({ method: h.method, url: h.url })))} ` +
        `sendResults=${JSON.stringify(send.json().results)}`,
    );
    expect(hits, "the gateway reached the loopback listener (SSRF)").toHaveLength(0);
    expect(attach.statusCode).toBe(400);
    expect(attach.json().error).toBe("invalid_channel_url");
    expect(getChannelsByOperator(slug)).toHaveLength(0);
  });

  it("[neg] signing oracle: the gateway must not HMAC-sign a caller-influenced body with a PCC_VAULT_* secret", async () => {
    process.env[SENTINEL_ENV] = SENTINEL_VALUE;
    const slug = "n84-oracle-victim";
    // label/describe are embedded in the body sendWebhook signs, so the caller
    // chooses part of the signed bytes.
    const marker = `ATTACKER-CHOSEN-${randomBytes(4).toString("hex")}`;
    const attach = await app.inject({
      method: "POST",
      url: `/api/operators/${slug}/channels`,
      payload: {
        label: marker,
        transport: "webhook",
        describe: `oracle probe ${marker}`,
        credentialRef: "n84_sentinel",
        endpoint: { url: `http://127.0.0.1:${port}/oracle` },
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/operators/${slug}/channels/test`,
      payload: {},
    });
    const signed = hits.filter((h) => h.headers["x-pcc-signature"] === hmacHeader(h.body));
    console.log(
      `[N84-REPRO] oracle attachStatus=${attach.statusCode} listenerHits=${hits.length} ` +
        `validSignaturesUnderSentinel=${signed.length} ` +
        `bodyContainsAttackerMarker=${signed.some((h) => h.body.includes(marker))} ` +
        `sigPrefix=${String(hits[0]?.headers["x-pcc-signature"] ?? "none").slice(0, 21)}`,
    );
    expect(signed, "the listener received a signature made with the vault secret").toHaveLength(0);
    expect(hits).toHaveLength(0);
    expect(attach.statusCode).toBe(400);
  });

  it("[neg] a stored channel whose URL points at loopback (pre-fix data) is NOT sent at send time", async () => {
    const slug = "n84-legacy-url";
    const ch = attachChannel(slug, {
      label: "legacy",
      transport: "webhook",
      describe: "stored before the fix, URL later points at loopback",
      endpoint: { url: "https://hooks.n84.test/legacy" },
    });
    // getChannelsByOperator hands out the live record, so this simulates a
    // record that was stored when no URL guard existed.
    ch.endpoint = { url: `http://127.0.0.1:${port}/legacy` };
    const res = await dispatchToChannels(slug, {
      jobId: "j_n84",
      contextRef: "ctx",
      summary: "legacy channel",
    });
    console.log(
      `[N84-REPRO] legacy-url listenerHits=${hits.length} results=${JSON.stringify(res)}`,
    );
    expect(hits, "the gateway reached the loopback listener from a stored record").toHaveLength(0);
    expect(res).toHaveLength(1);
    expect(res[0]!.delivered).toBe(false);
  });

  it("[neg] PATCH cannot swap a vetted URL for a loopback one (the update path is not a bypass)", async () => {
    const slug = "n84-patch-victim";
    const created = await app.inject({
      method: "POST",
      url: `/api/operators/${slug}/channels`,
      payload: {
        label: "vetted",
        transport: "webhook",
        describe: "created with a public https URL, then PATCHed",
        endpoint: { url: "https://hooks.n84.test/vetted" },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().channel.id as string;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/operators/channels/${id}`,
      payload: { endpoint: { url: `http://127.0.0.1:${port}/patched` } },
    });
    // Only trigger the send when the swap was accepted: after the fix the
    // refused PATCH leaves the vetted public URL in place, and sending to that
    // would be a real DNS lookup, which a test must never do.
    if (patched.statusCode < 400) {
      await app.inject({
        method: "POST",
        url: `/api/operators/${slug}/channels/test`,
        payload: {},
      });
    }
    console.log(`[N84-REPRO] patch patchStatus=${patched.statusCode} listenerHits=${hits.length}`);
    expect(hits, "the gateway reached the loopback listener after a PATCH swap").toHaveLength(0);
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error).toBe("invalid_channel_url");
    expect(getChannelsByOperator(slug)[0]!.endpoint).toEqual({ url: "https://hooks.n84.test/vetted" });
  });
});

// ── Group B: the URL guard as a unit ─────────────────────────────────────────

/** Every entry must be reported blocked by isBlockedAddress. [why, address] */
const BLOCKED_ADDRESSES: ReadonlyArray<readonly [string, string]> = [
  ["cloud metadata", "169.254.169.254"],
  ["link-local", "169.254.0.1"],
  ["loopback", "127.0.0.1"],
  ["loopback (other host)", "127.255.255.254"],
  ["IPv6 loopback", "::1"],
  ["IPv6 loopback, long form", "0:0:0:0:0:0:0:1"],
  ["RFC1918 10/8", "10.0.0.1"],
  ["RFC1918 10/8 (top)", "10.255.255.255"],
  ["RFC1918 172.16/12", "172.16.0.1"],
  ["RFC1918 172.16/12 (top)", "172.31.255.255"],
  ["RFC1918 192.168/16", "192.168.0.1"],
  ["RFC1918 192.168/16 (top)", "192.168.255.255"],
  ["CGNAT 100.64/10", "100.64.0.1"],
  ["CGNAT metadata (Alibaba)", "100.100.100.200"],
  ["CGNAT 100.64/10 (top)", "100.127.255.255"],
  ["unspecified", "0.0.0.0"],
  ["this-network 0/8", "0.1.2.3"],
  ["IPv6 unspecified", "::"],
  ["IPv6 unspecified, long form", "0:0:0:0:0:0:0:0"],
  ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ["IPv4-mapped loopback, hex groups", "::ffff:7f00:1"],
  ["IPv4-mapped loopback, long form", "0:0:0:0:0:ffff:7f00:1"],
  ["IPv4-mapped RFC1918", "::ffff:10.0.0.1"],
  ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
  ["IPv4-mapped metadata, hex groups", "::ffff:a9fe:a9fe"],
  ["IPv4-translated (SIIT) loopback", "::ffff:0:7f00:1"],
  ["IPv4-compatible loopback", "::127.0.0.1"],
  ["IPv4-compatible loopback, hex groups", "::7f00:1"],
  ["IPv4-compatible RFC1918", "::10.0.0.1"],
  ["NAT64 loopback", "64:ff9b::7f00:1"],
  ["NAT64 metadata", "64:ff9b::a9fe:a9fe"],
  ["NAT64 RFC1918, dotted", "64:ff9b::10.0.0.1"],
  ["NAT64 192.168", "64:ff9b::192.168.0.1"],
  ["NAT64 local-use prefix", "64:ff9b:1::1"],
  ["ULA fc00::/7", "fc00::1"],
  ["ULA fd00::/8 (AWS IMDS v6)", "fd00:ec2::254"],
  ["ULA fc00::/7 (top)", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["IPv6 link-local fe80::/10", "fe80::1"],
  ["IPv6 link-local with iid", "fe80::a00:27ff:fe4e:66a1"],
  ["IPv6 link-local (top)", "febf::1"],
  ["IPv6 site-local (deprecated)", "fec0::1"],
  ["multicast", "224.0.0.1"],
  ["multicast (top)", "239.255.255.250"],
  ["IPv6 multicast", "ff02::1"],
  ["IPv6 multicast (global scope)", "ff0e::1"],
  ["limited broadcast", "255.255.255.255"],
  ["reserved 240/4", "240.0.0.1"],
  ["benchmarking 198.18/15", "198.18.0.1"],
  ["benchmarking 198.18/15 (top)", "198.19.255.255"],
  ["IETF protocol assignments 192.0.0/24", "192.0.0.1"],
  ["TEST-NET-1", "192.0.2.1"],
  ["TEST-NET-2", "198.51.100.1"],
  ["TEST-NET-3", "203.0.113.1"],
  ["6to4 relay anycast", "192.88.99.1"],
  ["Azure platform address", "168.63.129.16"],
  ["IPv6 documentation", "2001:db8::1"],
  ["IPv6 6to4 (embeds IPv4)", "2002:7f00:1::"],
  ["IPv6 Teredo / IETF assignments 2001::/23", "2001::1"],
  ["IPv6 discard-only", "100::1"],
];

/** Public addresses: must NOT be blocked (controls against an over-broad guard). */
const PUBLIC_ADDRESSES: ReadonlyArray<string> = [
  "8.8.8.8",
  "1.1.1.1",
  PUBLIC_V4,
  "11.0.0.1",
  "172.15.255.255",
  "172.32.0.1",
  "100.63.255.255",
  "100.128.0.1",
  "169.253.255.255",
  "169.255.0.1",
  "192.167.255.255",
  "192.169.0.1",
  "198.17.255.255",
  "198.20.0.1",
  "223.255.255.255",
  "126.255.255.255",
  "128.0.0.1",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "2a00:1450:4001:81b::200e",
  "::ffff:8.8.8.8",
  "::ffff:808:808",
  "64:ff9b::808:808",
  "64:ff9b::8.8.8.8",
];

/** Anything that is not a canonical IP must fail closed (be reported blocked). */
const UNPARSEABLE: ReadonlyArray<readonly [string, unknown]> = [
  ["empty", ""],
  ["space", " "],
  ["word", "garbage"],
  ["three octets", "1.2.3"],
  ["five octets", "1.2.3.4.5"],
  ["octet > 255", "256.1.1.1"],
  ["last octet > 255", "1.2.3.256"],
  ["leading zero (octal ambiguity)", "010.0.0.1"],
  ["hex octet", "0x7f.0.0.1"],
  ["bare decimal dword", "2130706433"],
  ["short form", "127.1"],
  ["trailing space", "1.2.3.4 "],
  ["leading newline", "\n127.0.0.1"],
  ["bracketed IPv6 (URL syntax, not an address)", "[::1]"],
  ["IPv6 zone id", "::1%eth0"],
  ["link-local with zone id", "fe80::1%eth0"],
  ["triple colon", ":::"],
  ["two compressions", "1::2::3"],
  ["group too long", "12345::"],
  ["non-hex group", "g::1"],
  ["mapped with short dotted quad", "::ffff:1.2.3"],
  ["mapped with bad octet", "::ffff:256.1.1.1"],
  ["undefined", undefined],
  ["null", null],
  ["number", 2130706433],
  ["object", {}],
];

/** Boundary table: first/last address inside each range, plus the neighbours outside it. */
interface RangeCase {
  name: string;
  first: string;
  last: string;
  /** just below the range; omit where the neighbour is itself blocked or reserved */
  before?: string;
  /** just above the range; omit where the neighbour is itself blocked or reserved */
  after?: string;
}
const RANGES: ReadonlyArray<RangeCase> = [
  { name: "this-network 0.0.0.0/8", first: "0.0.0.0", last: "0.255.255.255", after: "1.0.0.0" },
  { name: "RFC1918 10.0.0.0/8", first: "10.0.0.0", last: "10.255.255.255", before: "9.255.255.255", after: "11.0.0.0" },
  { name: "CGNAT 100.64.0.0/10", first: "100.64.0.0", last: "100.127.255.255", before: "100.63.255.255", after: "100.128.0.0" },
  { name: "loopback 127.0.0.0/8", first: "127.0.0.0", last: "127.255.255.255", before: "126.255.255.255", after: "128.0.0.0" },
  { name: "Azure platform 168.63.129.16/32", first: "168.63.129.16", last: "168.63.129.16", before: "168.63.129.15", after: "168.63.129.17" },
  { name: "link-local 169.254.0.0/16", first: "169.254.0.0", last: "169.254.255.255", before: "169.253.255.255", after: "169.255.0.0" },
  { name: "RFC1918 172.16.0.0/12", first: "172.16.0.0", last: "172.31.255.255", before: "172.15.255.255", after: "172.32.0.0" },
  { name: "IETF assignments 192.0.0.0/24", first: "192.0.0.0", last: "192.0.0.255", before: "191.255.255.255", after: "192.0.1.0" },
  { name: "TEST-NET-1 192.0.2.0/24", first: "192.0.2.0", last: "192.0.2.255", before: "192.0.1.255", after: "192.0.3.0" },
  { name: "6to4 relay 192.88.99.0/24", first: "192.88.99.0", last: "192.88.99.255", before: "192.88.98.255", after: "192.88.100.0" },
  { name: "RFC1918 192.168.0.0/16", first: "192.168.0.0", last: "192.168.255.255", before: "192.167.255.255", after: "192.169.0.0" },
  { name: "benchmarking 198.18.0.0/15", first: "198.18.0.0", last: "198.19.255.255", before: "198.17.255.255", after: "198.20.0.0" },
  { name: "TEST-NET-2 198.51.100.0/24", first: "198.51.100.0", last: "198.51.100.255", before: "198.51.99.255", after: "198.51.101.0" },
  { name: "TEST-NET-3 203.0.113.0/24", first: "203.0.113.0", last: "203.0.113.255", before: "203.0.112.255", after: "203.0.114.0" },
  { name: "multicast 224.0.0.0/4", first: "224.0.0.0", last: "239.255.255.255", before: "223.255.255.255" },
  { name: "reserved 240.0.0.0/4 + broadcast", first: "240.0.0.0", last: "255.255.255.255" },
  { name: "IPv6 discard-only 100::/64", first: "100::", last: "100::ffff:ffff:ffff:ffff", after: "100:0:0:1::" },
  { name: "IPv6 IETF assignments 2001::/23", first: "2001::", last: "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff", before: "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", after: "2001:200::" },
  { name: "IPv6 documentation 2001:db8::/32", first: "2001:db8::", last: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", before: "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", after: "2001:db9::" },
  { name: "IPv6 6to4 2002::/16", first: "2002::", last: "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff", before: "2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", after: "2003::" },
  { name: "IPv6 documentation 3fff::/20", first: "3fff::", last: "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff", before: "3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", after: "3fff:1000::" },
  { name: "NAT64 local-use 64:ff9b:1::/48", first: "64:ff9b:1::", last: "64:ff9b:1:ffff:ffff:ffff:ffff:ffff" },
  { name: "ULA fc00::/7", first: "fc00::", last: "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", before: "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
  { name: "link-local fe80::/10", first: "fe80::", last: "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", before: "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
  { name: "site-local fec0::/10", first: "fec0::", last: "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
  { name: "IPv6 multicast ff00::/8", first: "ff00::", last: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
];

describe("outbound-url-guard: isBlockedAddress", () => {
  it.each(BLOCKED_ADDRESSES)("[neg] blocks %s (%s)", async (_why, address) => {
    const { isBlockedAddress } = await loadGuard();
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(PUBLIC_ADDRESSES)("control: does not block public address %s", async (address) => {
    const { isBlockedAddress } = await loadGuard();
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each(UNPARSEABLE)("[neg] fails closed on non-canonical input: %s", async (_why, input) => {
    const { isBlockedAddress } = await loadGuard();
    expect(isBlockedAddress(input as string)).toBe(true);
  });

  describe("range boundaries", () => {
    for (const r of RANGES) {
      it(`[neg] ${r.name}: first and last address are blocked`, async () => {
        const { isBlockedAddress } = await loadGuard();
        expect(isBlockedAddress(r.first), `first ${r.first}`).toBe(true);
        expect(isBlockedAddress(r.last), `last ${r.last}`).toBe(true);
      });
      if (r.before) {
        it(`control: ${r.name}: the address just below (${r.before}) is not blocked`, async () => {
          const { isBlockedAddress } = await loadGuard();
          expect(isBlockedAddress(r.before!)).toBe(false);
        });
      }
      if (r.after) {
        it(`control: ${r.name}: the address just above (${r.after}) is not blocked`, async () => {
          const { isBlockedAddress } = await loadGuard();
          expect(isBlockedAddress(r.after!)).toBe(false);
        });
      }
    }
  });
});

/** URLs checkOutboundUrl must refuse. [why, url, expected reason or undefined] */
const REFUSED_URLS: ReadonlyArray<readonly [string, string, string | undefined]> = [
  ["cloud metadata", "https://169.254.169.254/latest/meta-data/", "blocked_address"],
  ["cloud metadata over http", "http://169.254.169.254/latest/meta-data/iam/security-credentials/", "blocked_address"],
  ["the loopback listener itself", "http://127.0.0.1:8080/hook", "blocked_address"],
  ["IPv6 loopback literal", "https://[::1]/hook", "blocked_address"],
  ["IPv6 loopback literal with port", "http://[::1]:8080/hook", "blocked_address"],
  ["RFC1918 10.x", "https://10.1.2.3/hook", "blocked_address"],
  ["RFC1918 172.16.x", "https://172.16.5.5/hook", "blocked_address"],
  ["RFC1918 172.31.x", "https://172.31.255.254/hook", "blocked_address"],
  ["RFC1918 192.168.x", "https://192.168.1.10/hook", "blocked_address"],
  ["CGNAT 100.64/10", "https://100.64.0.1/hook", "blocked_address"],
  ["unspecified 0.0.0.0", "https://0.0.0.0/hook", "blocked_address"],
  ["IPv4-mapped IPv6 loopback (dotted)", "https://[::ffff:127.0.0.1]/hook", "blocked_address"],
  ["IPv4-mapped IPv6 loopback (hex)", "https://[::ffff:7f00:1]/hook", "blocked_address"],
  ["IPv6 ULA fc00::/7", "https://[fc00::1]/hook", "blocked_address"],
  ["IPv6 ULA fd00::/8", "https://[fd12:3456:789a::1]/hook", "blocked_address"],
  ["IPv6 link-local fe80::/10", "https://[fe80::1]/hook", "blocked_address"],
  ["NAT64 embedding the metadata address", "https://[64:ff9b::a9fe:a9fe]/hook", "blocked_address"],
  ["decimal IPv4 spelling", "http://2130706433/", "blocked_address"],
  ["octal IPv4 spelling", "http://0177.0.0.1/", "blocked_address"],
  ["hex IPv4 spelling", "http://0x7f.0.0.1/", "blocked_address"],
  ["hex dword IPv4 spelling", "http://0x7f000001/", "blocked_address"],
  ["short IPv4 spelling", "http://127.1/", "blocked_address"],
  ["metadata decimal spelling", "http://2852039166/latest/meta-data/", "blocked_address"],
  ["percent-encoded dot", "http://127.0.0.1%2e/", undefined],
  ["localhost", "https://localhost/hook", "internal_hostname"],
  ["LOCALHOST with trailing dot", "https://LocalHost./hook", "internal_hostname"],
  ["*.localhost", "https://foo.localhost/hook", "internal_hostname"],
  ["metadata.google.internal", "http://metadata.google.internal/computeMetadata/v1/", "internal_hostname"],
  ["*.internal", "https://svc.internal/hook", "internal_hostname"],
  ["*.local", "https://printer.local/hook", "internal_hostname"],
  ["single-label host", "https://redis/hook", "internal_hostname"],
  ["userinfo (user and password)", "https://user:pass@hooks.example.com/hook", "userinfo_not_allowed"],
  ["userinfo (user only)", "https://user@hooks.example.com/hook", "userinfo_not_allowed"],
  ["userinfo used to disguise the host", "https://hooks.example.com@127.0.0.1/hook", undefined],
  ["ftp scheme", "ftp://hooks.example.com/hook", "scheme_not_allowed"],
  ["file scheme", "file:///etc/passwd", "scheme_not_allowed"],
  ["gopher scheme", "gopher://hooks.example.com/_x", "scheme_not_allowed"],
  ["not a URL", "not a url", "invalid_url"],
  ["empty string", "", "invalid_url"],
  ["bare host without a scheme", "hooks.example.com/hook", undefined],
  ["IPv4 literal with an invalid octet", "http://1.2.3.256/", "invalid_url"],
];

/** Non-string inputs are refused too. */
const REFUSED_NON_STRINGS: ReadonlyArray<readonly [string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["number", 42],
  ["object", { href: "https://hooks.example.com/" }],
  ["array", ["https://hooks.example.com/"]],
];

describe("outbound-url-guard: checkOutboundUrl (creation-time, syntactic)", () => {
  it.each(REFUSED_URLS)("[neg] refuses %s: %s", async (_why, url, reason) => {
    const { checkOutboundUrl } = await loadGuard();
    const r = checkOutboundUrl(url);
    expect(r.ok, `expected ${url} to be refused`).toBe(false);
    if (!r.ok && reason) expect(r.reason).toBe(reason);
  });

  it.each(REFUSED_NON_STRINGS)("[neg] refuses a non-string url (%s)", async (_why, value) => {
    const { checkOutboundUrl } = await loadGuard();
    const r = checkOutboundUrl(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });

  it("[neg] refuses an over-long URL", async () => {
    const { checkOutboundUrl } = await loadGuard();
    const r = checkOutboundUrl(`https://hooks.example.com/${"a".repeat(4096)}`);
    expect(r.ok).toBe(false);
  });

  it.each([
    ["public https hostname", "https://hooks.example.com/hook"],
    ["public https hostname with port, path and query", "https://hooks.example.com:8443/a/b?x=1#frag"],
    ["public IPv4 literal", "https://8.8.8.8/hook"],
    ["public IPv6 literal", "https://[2606:4700:4700::1111]/hook"],
    ["reserved .test hostname (resolved later, by the injected resolver)", "https://hooks.n84.test/hook"],
    ["public IPv4-mapped IPv6 literal", "https://[::ffff:8.8.8.8]/hook"],
  ])("control: accepts %s", async (_why, url) => {
    const { checkOutboundUrl } = await loadGuard();
    const r = checkOutboundUrl(url);
    expect(r.ok, `expected ${url} to be accepted`).toBe(true);
  });

  it("allows http: only when NODE_ENV is exactly test or development", async () => {
    const { checkOutboundUrl } = await loadGuard();
    const url = "http://hooks.example.com/hook";
    for (const env of ["test", "development"]) {
      process.env.NODE_ENV = env;
      expect(checkOutboundUrl(url).ok, `NODE_ENV=${env}`).toBe(true);
    }
    for (const env of ["production", "prod", "staging", "Test", "DEVELOPMENT", ""]) {
      process.env.NODE_ENV = env;
      const r = checkOutboundUrl(url);
      expect(r.ok, `NODE_ENV=${JSON.stringify(env)}`).toBe(false);
      if (!r.ok) expect(r.reason).toBe("scheme_not_allowed");
    }
    delete process.env.NODE_ENV; // unset behaves as production: fail closed
    const unset = checkOutboundUrl(url);
    expect(unset.ok).toBe(false);
  });

  it("https is accepted in every environment", async () => {
    const { checkOutboundUrl } = await loadGuard();
    for (const env of ["production", "test", "development", ""]) {
      process.env.NODE_ENV = env;
      expect(checkOutboundUrl("https://hooks.example.com/hook").ok, `NODE_ENV=${JSON.stringify(env)}`).toBe(true);
    }
  });

  it("never lets a blocked literal through in any environment (http allowance does not relax the ranges)", async () => {
    const { checkOutboundUrl } = await loadGuard();
    for (const env of ["test", "development"]) {
      process.env.NODE_ENV = env;
      expect(checkOutboundUrl("http://127.0.0.1/hook").ok).toBe(false);
      expect(checkOutboundUrl("http://169.254.169.254/").ok).toBe(false);
      expect(checkOutboundUrl("http://localhost/hook").ok).toBe(false);
    }
  });
});

describe("attach-time refusal (HTTP route and programmatic attach)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(operatorChannelsRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const attachForms: ReadonlyArray<readonly [string, string]> = [
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["IPv6 loopback", "https://[::1]/hook"],
    ["RFC1918", "https://10.0.0.5:9100/print"],
    ["decimal IPv4", "http://2130706433/"],
    ["octal IPv4", "http://0177.0.0.1/"],
    ["hex IPv4", "http://0x7f.0.0.1/"],
    ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/hook"],
    ["localhost", "https://localhost/hook"],
    ["userinfo", "https://user:pass@hooks.example.com/hook"],
  ];

  it.each(attachForms)("[neg] POST with %s answers 400 invalid_channel_url and writes nothing", async (_why, url) => {
    const slug = "n84-refuse";
    const res = await app.inject({
      method: "POST",
      url: `/api/operators/${slug}/channels`,
      payload: {
        label: "probe",
        transport: "webhook",
        describe: "attach-time refusal probe",
        endpoint: { url },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_channel_url");
    expect(getChannelsByOperator(slug)).toHaveLength(0);
    const list = await app.inject({ method: "GET", url: `/api/operators/${slug}/channels` });
    expect(list.json().channels).toHaveLength(0);
  });

  it("[neg] programmatic attachChannel (A2A path) throws code invalid_channel_url", () => {
    let thrown: unknown;
    try {
      attachChannel("n84-refuse-direct", {
        label: "probe",
        transport: "webhook",
        describe: "attach-time refusal probe",
        endpoint: { url: "https://169.254.169.254/latest/meta-data/" },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "attachChannel must throw").toBeDefined();
    expect(thrown).toMatchObject({ code: "invalid_channel_url" });
    expect(getChannelsByOperator("n84-refuse-direct")).toHaveLength(0);
  });

  it("[neg] PATCH to a non-webhook channel's transport cannot smuggle a stored private URL into a webhook", async () => {
    const slug = "n84-patch-transport";
    // an sms channel never dials its endpoint, so the URL field is not checked at attach
    const ch = attachChannel(slug, {
      label: "sms",
      transport: "sms",
      describe: "sms channel carrying a stray url field",
      endpoint: { phoneE164: "+14155551234", url: "https://10.0.0.5/print" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/operators/channels/${ch.id}`,
      payload: { transport: "webhook" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_channel_url");
    expect(getChannelsByOperator(slug)[0]!.transport).toBe("sms");
  });

  it("control: a webhook with a public https URL is still accepted (201)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/n84-ok/channels",
      payload: {
        label: "ok",
        transport: "webhook",
        describe: "a perfectly ordinary public https webhook",
        endpoint: { url: "https://hooks.n84.test/ok" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(getChannelsByOperator("n84-ok")).toHaveLength(1);
  });

  it("control: non-webhook transports and a webhook with no url are still accepted", () => {
    expect(() =>
      attachChannel("n84-ok2", { label: "m", transport: "manual", describe: "dashboard only" }),
    ).not.toThrow();
    expect(() =>
      attachChannel("n84-ok2", { label: "w", transport: "webhook", describe: "url added later by the agent" }),
    ).not.toThrow();
  });
});

// ── Group C: the send-time decision logic, injected resolver + transport ─────

interface TransportCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  addresses: ReadonlyArray<{ address: string; family: number }> | null;
  lookup: (host: string, options: object, cb: (...args: unknown[]) => void) => void;
}

/** A transport that records calls and answers without opening a socket. */
function fakeTransport(respond: (call: TransportCall) => { status: number; headers?: Record<string, string> }) {
  const calls: TransportCall[] = [];
  const transport = async (req: any) => {
    const call: TransportCall = {
      url: req.url.href,
      method: req.method,
      headers: req.headers,
      body: req.body,
      addresses: req.addresses,
      lookup: req.lookup,
    };
    calls.push(call);
    const r = respond(call);
    return { status: r.status, headers: r.headers ?? {}, bytesRead: 0, truncated: false };
  };
  return { transport, calls };
}

/** A resolver backed by a table; unknown names fail like NXDOMAIN. */
function fakeResolver(table: Record<string, string[]>) {
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    const answers = table[host];
    if (!answers) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return answers.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 }));
  };
  return { resolve, asked };
}

const POST_INIT = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ hello: "n84" }),
};

describe("guarded send: injected resolver + transport (no real DNS, no sockets)", () => {
  const HOST = "hooks.n84.test";
  const URL_ = `https://${HOST}/hook`;

  const PRIVATE_ANSWERS: ReadonlyArray<readonly [string, string]> = [
    ["loopback", "127.0.0.1"],
    ["RFC1918 10/8", "10.0.0.5"],
    ["RFC1918 172.16/12", "172.16.9.9"],
    ["RFC1918 192.168/16", "192.168.1.1"],
    ["cloud metadata", "169.254.169.254"],
    ["CGNAT", "100.64.0.1"],
    ["unspecified", "0.0.0.0"],
    ["IPv6 loopback", "::1"],
    ["IPv6 ULA", "fc00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["NAT64 metadata", "64:ff9b::a9fe:a9fe"],
  ];

  it.each(PRIVATE_ANSWERS)("[neg] a hostname that RESOLVES to a private address (%s) is refused; nothing is dialed", async (_why, answer) => {
    const g = await loadGuard();
    const { resolve } = fakeResolver({ [HOST]: [answer] });
    const { transport, calls } = fakeTransport(() => ({ status: 200 }));
    await expect(g.guardedFetch(URL_, POST_INIT, { resolve, transport })).rejects.toMatchObject({
      code: "blocked_destination",
    });
    expect(calls).toHaveLength(0);
  });

  it("[neg] one private answer among public ones vetoes the whole send (ANY, not first)", async () => {
    const g = await loadGuard();
    for (const answers of [[PUBLIC_V4, "10.0.0.5"], ["10.0.0.5", PUBLIC_V4], [PUBLIC_V4, "2606:4700:4700::1111", "fe80::1"]]) {
      const { resolve } = fakeResolver({ [HOST]: answers });
      const { transport, calls } = fakeTransport(() => ({ status: 200 }));
      await expect(g.guardedFetch(URL_, POST_INIT, { resolve, transport })).rejects.toMatchObject({
        code: "blocked_destination",
      });
      expect(calls, `answers=${answers.join(",")}`).toHaveLength(0);
    }
  });

  it("[neg] an IP-literal URL in a blocked range is refused before any resolution or dial", async () => {
    const g = await loadGuard();
    const { resolve, asked } = fakeResolver({});
    const { transport, calls } = fakeTransport(() => ({ status: 200 }));
    for (const url of ["https://127.0.0.1/hook", "https://[::1]/hook", "https://169.254.169.254/x", "http://2130706433/"]) {
      await expect(g.guardedFetch(url, POST_INIT, { resolve, transport })).rejects.toMatchObject({
        code: "invalid_url",
      });
    }
    expect(calls).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });

  it("control: a hostname that resolves to a public address IS sent, pinned to the validated address", async () => {
    const g = await loadGuard();
    const { resolve } = fakeResolver({ [HOST]: [PUBLIC_V4] });
    const { transport, calls } = fakeTransport(() => ({ status: 200, headers: { "x-request-id": "r-1" } }));
    const res = await g.guardedFetch(URL_, POST_INIT, { resolve, transport });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers["x-request-id"]).toBe("r-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers).toEqual(POST_INIT.headers);
    expect(calls[0]!.body).toBe(POST_INIT.body);
    expect(calls[0]!.addresses).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });

  it("control: a public IPv6 answer and a public IP literal are sent too", async () => {
    const g = await loadGuard();
    const { resolve } = fakeResolver({ [HOST]: ["2606:4700:4700::1111"] });
    const { transport, calls } = fakeTransport(() => ({ status: 204 }));
    expect((await g.guardedFetch(URL_, POST_INIT, { resolve, transport })).ok).toBe(true);
    expect((await g.guardedFetch("https://8.8.8.8/hook", POST_INIT, { resolve, transport })).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.addresses).toBeNull(); // literal: nothing to resolve or pin
  });

  it("a non-2xx answer is reported as such, not thrown (the status is for the operator)", async () => {
    const g = await loadGuard();
    const { resolve } = fakeResolver({ [HOST]: [PUBLIC_V4] });
    const { transport } = fakeTransport(() => ({ status: 503 }));
    const res = await g.guardedFetch(URL_, POST_INIT, { resolve, transport });
    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
  });

  it.each([300, 301, 302, 303, 304, 307, 308])(
    "[neg] a %i answer is a failure and its Location (a private address) is never requested",
    async (status) => {
      const g = await loadGuard();
      const { resolve, asked } = fakeResolver({ [HOST]: [PUBLIC_V4], "169.254.169.254": ["169.254.169.254"] });
      const { transport, calls } = fakeTransport(() => ({
        status,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }));
      await expect(g.guardedFetch(URL_, POST_INIT, { resolve, transport })).rejects.toMatchObject({
        code: "redirect_not_followed",
        status,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(URL_);
      expect(asked).toEqual([HOST]);
    },
  );

  it("[neg] a redirect to a relative or public Location is not followed either", async () => {
    const g = await loadGuard();
    const { resolve } = fakeResolver({ [HOST]: [PUBLIC_V4] });
    for (const location of ["/elsewhere", "https://other.example.com/hook"]) {
      const { transport, calls } = fakeTransport(() => ({ status: 302, headers: { location } }));
      await expect(g.guardedFetch(URL_, POST_INIT, { resolve, transport })).rejects.toMatchObject({
        code: "redirect_not_followed",
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("[neg] DNS failure and empty answers refuse the send; nothing is dialed", async () => {
    const g = await loadGuard();
    const { transport, calls } = fakeTransport(() => ({ status: 200 }));
    await expect(g.guardedFetch(URL_, POST_INIT, { resolve: fakeResolver({}).resolve, transport })).rejects.toMatchObject({
      code: "dns_failure",
    });
    await expect(g.guardedFetch(URL_, POST_INIT, { resolve: fakeResolver({ [HOST]: [] }).resolve, transport })).rejects.toMatchObject({
      code: "dns_failure",
    });
    expect(calls).toHaveLength(0);
  });

  it("[neg] DNS rebinding: one resolution per send, and the dialer can only ever be handed the validated answer", async () => {
    const g = await loadGuard();
    let n = 0;
    const asked: string[] = [];
    // First answer is public, every later answer is the metadata address.
    const resolve = async (host: string) => {
      asked.push(host);
      return n++ === 0
        ? [{ address: PUBLIC_V4, family: 4 as const }]
        : [{ address: "169.254.169.254", family: 4 as const }];
    };
    const dialed: Array<{ address: string; family: number }> = [];
    const transport = async (req: any) => {
      // What the socket layer would see if it asked for this hostname again.
      await new Promise<void>((done) =>
        req.lookup(HOST, { all: true }, (_err: unknown, list: Array<{ address: string; family: number }>) => {
          if (Array.isArray(list)) dialed.push(...list);
          done();
        }),
      );
      return { status: 200, headers: {}, bytesRead: 0, truncated: false };
    };
    const res = await g.guardedFetch(URL_, POST_INIT, { resolve, transport });
    expect(res.ok).toBe(true);
    expect(asked).toEqual([HOST]); // not re-resolved at connect time
    expect(dialed).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });

  it("[neg] the connect-time lookup itself refuses a blocked address (second layer, independent of the pre-check)", async () => {
    const g = await loadGuard();
    const ask = (addresses: Array<{ address: string; family: 4 | 6 }>, options: object) =>
      new Promise<{ err: unknown; args: unknown[] }>((resolve) => {
        g.createPinnedLookup(addresses)("x.test", options as never, ((err: unknown, ...args: unknown[]) =>
          resolve({ err, args })) as never);
      });
    const blocked = await ask([{ address: "10.0.0.5", family: 4 }], { all: true });
    expect(blocked.err).toBeTruthy();
    const mixed = await ask([{ address: PUBLIC_V4, family: 4 }, { address: "169.254.169.254", family: 4 }], { all: true });
    expect(mixed.err).toBeTruthy();
    const single = await ask([{ address: "10.0.0.5", family: 4 }], {});
    expect(single.err).toBeTruthy();
    // control: public answers come back in both lookup calling conventions
    const all = await ask([{ address: PUBLIC_V4, family: 4 }], { all: true });
    expect(all.err).toBeNull();
    expect(all.args[0]).toEqual([{ address: PUBLIC_V4, family: 4 }]);
    const one = await ask([{ address: PUBLIC_V4, family: 4 }], {});
    expect(one.err).toBeNull();
    expect(one.args).toEqual([PUBLIC_V4, 4]);
    // family filtering: a v6-only request cannot be served from a v4-only pin
    const wrongFamily = await ask([{ address: PUBLIC_V4, family: 4 }], { family: 6 });
    expect(wrongFamily.err).toBeTruthy();
  });

  it("the send is bounded: a transport that never answers times out", async () => {
    const g = await loadGuard();
    const { resolve } = fakeResolver({ [HOST]: [PUBLIC_V4] });
    const hang = (() => new Promise(() => undefined)) as never;
    await expect(
      g.guardedFetch(URL_, { ...POST_INIT, timeoutMs: 40 }, { resolve, transport: hang }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("the send is bounded: a resolver that never answers times out", async () => {
    const g = await loadGuard();
    const { transport, calls } = fakeTransport(() => ({ status: 200 }));
    const hang = (() => new Promise(() => undefined)) as never;
    await expect(
      g.guardedFetch(URL_, { ...POST_INIT, timeoutMs: 40 }, { resolve: hang, transport }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toHaveLength(0);
  });

  describe("through dispatchToChannels (the production call path, injected deps)", () => {
    beforeEach(async () => {
      // nothing in this block may reach real DNS or a real socket
      const g = await loadGuard();
      g._setOutboundDepsForTests({
        resolve: fakeResolver({}).resolve,
        transport: fakeTransport(() => ({ status: 200 })).transport,
      });
    });
    afterEach(async () => {
      const g = await loadGuard();
      g._setOutboundDepsForTests(null);
    });

    it("[neg] a stored webhook whose hostname now resolves to a private address is not sent", async () => {
      const g = await loadGuard();
      const { resolve } = fakeResolver({ "rebind.n84.test": ["10.0.0.5"] });
      const { transport, calls } = fakeTransport(() => ({ status: 200 }));
      g._setOutboundDepsForTests({ resolve, transport });
      attachChannel("n84-rebind", {
        label: "rebind",
        transport: "webhook",
        describe: "hostname flips to a private address after attach",
        endpoint: { url: "https://rebind.n84.test/hook" },
      });
      const res = await dispatchToChannels("n84-rebind", { jobId: "j1", contextRef: "c", summary: "s" });
      expect(calls).toHaveLength(0);
      expect(res).toHaveLength(1);
      expect(res[0]!.delivered).toBe(false);
      expect(res[0]!.error).toBe("send_failed");
    });

    it("[neg] a webhook that answers with a redirect to a private address reports a failure and the target is never requested", async () => {
      const g = await loadGuard();
      const { resolve } = fakeResolver({ "hooks.n84.test": [PUBLIC_V4] });
      const { transport, calls } = fakeTransport(() => ({
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }));
      g._setOutboundDepsForTests({ resolve, transport });
      attachChannel("n84-redirect", {
        label: "redirector",
        transport: "webhook",
        describe: "answers 302 to the metadata address",
        endpoint: { url: "https://hooks.n84.test/hook" },
      });
      const res = await dispatchToChannels("n84-redirect", { jobId: "j2", contextRef: "c", summary: "s" });
      expect(calls).toHaveLength(1);
      expect(res[0]!.delivered).toBe(false);
      expect(JSON.stringify(res)).not.toContain("169.254.169.254");
    });

    it("control: a webhook whose host resolves to a public address IS sent with the signed-less JSON envelope", async () => {
      const g = await loadGuard();
      const { resolve } = fakeResolver({ "hooks.n84.test": [PUBLIC_V4] });
      const { transport, calls } = fakeTransport(() => ({ status: 200, headers: { "x-request-id": "req-77" } }));
      g._setOutboundDepsForTests({ resolve, transport });
      attachChannel("n84-public", {
        label: "public",
        transport: "webhook",
        describe: "an ordinary public webhook",
        endpoint: { url: "https://hooks.n84.test/hook" },
      });
      const res = await dispatchToChannels("n84-public", { jobId: "j3", contextRef: "ctx", summary: "hello" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.headers["content-type"]).toBe("application/json");
      expect(calls[0]!.headers["x-pcc-signature"]).toBeUndefined();
      const body = JSON.parse(calls[0]!.body!);
      expect(body.source).toBe("pcc.capability.network");
      expect(body.operator).toBe("n84-public");
      expect(body.job).toEqual({ jobId: "j3", contextRef: "ctx", summary: "hello" });
      expect(res).toEqual([{ channelId: expect.stringMatching(/^ch_/), transport: "webhook", delivered: true, ref: "req-77" }]);
    });

    it("a public webhook that answers 500 is reported undelivered with its status", async () => {
      const g = await loadGuard();
      const { resolve } = fakeResolver({ "hooks.n84.test": [PUBLIC_V4] });
      const { transport } = fakeTransport(() => ({ status: 500 }));
      g._setOutboundDepsForTests({ resolve, transport });
      attachChannel("n84-500", {
        label: "five hundred",
        transport: "webhook",
        describe: "answers 500",
        endpoint: { url: "https://hooks.n84.test/hook" },
      });
      const res = await dispatchToChannels("n84-500", { jobId: "j4", contextRef: "c", summary: "s" });
      expect(res[0]!.delivered).toBe(false);
      expect(res[0]!.warning).toBe("HTTP 500");
    });
  });
});
