/**
 * N84, the WP-A part: every operator-channel route is the slug owner's, or the admin's.
 *
 * PR #483 (from master) guards the channel SEND path: a URL guard and a credential
 * allowlist. It does not decide WHO may touch a slug's channels; per steward rule 6
 * that binding rides WP-A (#326, this branch). Here the channel routes are the old
 * unguarded ones, so ANY authenticated key can, for ANY slug it names:
 *
 *   - POST   /api/operators/:slug/channels        attach a channel to someone else's slug;
 *   - GET    /api/operators/:slug/channels        list them, endpoint.url and credentialRef included;
 *   - PATCH  /api/operators/channels/:id          retarget (or disable) a channel found by id;
 *   - DELETE /api/operators/channels/:id          delete a channel found by id;
 *   - POST   /api/operators/:slug/channels/test   make the gateway send to every enabled channel;
 *   - A2A tasks/send, pcc-attach-channel          attach under a slug the caller names;
 *   - A2A tasks/send, pcc-author-integration      attach under a slug the caller names, or under
 *                                                 one derived from a kernel NAME the caller picks;
 *   - GET    /api/operators/:slug/status          returns every channel record, whole. Found while
 *                                                 tracing; it is not in the brief (see the last block).
 *
 * Runs on the real server (createGateway: apiGate, scopeChecker, every route).
 * Nothing here touches the network: sends go to a recording email transport, and the one
 * webhook channel used to prove disclosure is DISABLED, so no dispatch ever reaches it.
 *
 * HOW "A OWNS S" IS STAGED. No record binds a channel slug to an owner on this branch
 * (the channel store is in memory and ChannelRecord carries no owner), so this file makes
 * every record a fix could read agree: A's identity IS the slug (S === A), A registers a
 * kernel NAMED S through the real facade (shop_kernels.operator_address = A), and A makes
 * the first attach through its own key. The one place the file depends on the ownership
 * record is establishOwners() plus ownerAttach(): if the record is created somewhere else,
 * change those two helpers and nothing else.
 *
 * Reading the failing run: every "[neg]" test fails today and every "control:" test
 * passes. The "[N84-OWNER-REPRO]" lines print what each stranger's call actually did.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { getChannelsByOperator, _clearOperatorChannelsForTests } from "../routes/operator-channels.js";
import {
  __setEmailTransportForTests,
  type EmailMessage,
  type EmailTransport,
} from "../services/email-transport.js";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";
const ADMIN_SECRET = "n84-owner-test-admin-secret-0123456789";
process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
delete process.env.BROKER_OPERATORS;
delete process.env.PCC_A2A_AUTH_DISABLED;

// A owns SLUG_A. B is an ordinary key that owns only SLUG_B. C owns SLUG_C (derived-slug case).
const A = "n84-owner-a";
const B = "n84-stranger-b";
const C = "n84-owner-c";
const SLUG_A = A;
const SLUG_B = B;
const SLUG_C = C;

const OWNER_ADDRESS = "orders-a@n84.test";
const ATTACKER_ADDRESS = "attacker-b@n84.test";
const WEBHOOK_URL = "https://hooks.n84.test/owner-a/orders";
const VAULT_REF = "N84_OWNER_A_VAULT_REF";
const PROBE_LABEL = "N84-probe-attach";

let app: FastifyInstance;
let keyA = "";
let keyB = "";
let keyC = "";
let seq = 0;
let ipSeq = 0;

/** Every message the recording transport was asked to send. No provider, no network. */
const sent: EmailMessage[] = [];
const recorder: EmailTransport = {
  provider: "n84-recorder",
  async send(msg) {
    sent.push(msg);
    return { id: `n84-recorded-${sent.length}`, provider: "n84-recorder" };
  },
};

type Res = LightMyRequestResponse;
type Headers = Record<string, string>;

function call(method: string, url: string, key: string | null, extra: Headers = {}, payload?: unknown): Promise<Res> {
  return app.inject({
    method: method as never,
    url,
    remoteAddress: `10.84.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra },
    payload: payload as never,
  });
}
const adminHeaders: Headers = { "x-admin-key": ADMIN_SECRET };
const wrongAdminHeaders: Headers = { "x-admin-key": "n84-not-the-admin-secret" };

interface RpcBody {
  result?: { state?: string; artifacts?: Array<{ data?: Record<string, unknown> }> };
  error?: { code?: number; message?: string };
}
async function rpc(key: string | null, skill: string, params: Record<string, unknown>, extra: Headers = {}) {
  const res = await call(
    "POST",
    "/a2a/tasks/send",
    key,
    { "content-type": "application/json", ...extra },
    JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tasks/send", params: { skill, params } }),
  );
  return { res, body: res.json() as RpcBody };
}
/** Channels an A2A reply says it attached (pcc-attach-channel: attached; pcc-author-integration: channels). */
function reportedAttached(body: RpcBody): number {
  const d = body.result?.artifacts?.[0]?.data;
  const list = (d?.attached ?? d?.channels) as unknown[] | undefined;
  return Array.isArray(list) ? list.length : 0;
}

const chans = (slug: string) => getChannelsByOperator(slug);
const note = (tag: string, facts: Record<string, unknown>) =>
  console.log(`[N84-OWNER-REPRO] ${tag} ${JSON.stringify(facts)}`);

const emailBody = (label: string, address = OWNER_ADDRESS) => ({
  label,
  transport: "email",
  describe: "Email the shop inbox for every new order.",
  endpoint: { address },
});
/** DISABLED, so dispatch never reaches it: it exists only to carry a URL and a credentialRef. */
const webhookBody = (label: string) => ({
  label,
  transport: "webhook",
  describe: "POST the job JSON to the shop's order system.",
  endpoint: { url: WEBHOOK_URL },
  credentialRef: VAULT_REF,
  enabled: false,
});
const a2aChannel = (label: string, address = ATTACKER_ADDRESS) => emailBody(label, address);

/** The owner makes the first attach through its own key. */
async function ownerAttach(key: string, slug: string, body: Record<string, unknown>) {
  const res = await call("POST", `/api/operators/${slug}/channels`, key, {}, body);
  expect(res.statusCode, `precondition: the owner could not attach to its own slug: ${res.body}`).toBe(201);
  return (res.json() as { channel: { id: string; label: string } }).channel;
}

/** A, B and C each register a kernel NAMED for their slug, owned by their identity. */
async function establishOwners(): Promise<void> {
  const { getKernelFacade } = await import("../facades/index.js");
  for (const id of [A, B, C]) {
    const reg = await getKernelFacade().register({ id: `kernel-n84-${id}`, name: id }, id);
    expect(reg.success, JSON.stringify(reg)).toBe(true);
  }
}

interface Ids {
  email: string;
  webhook: string;
}
/** A's slug as the owner leaves it: one live email channel, one disabled webhook with a URL and a credentialRef. */
async function seedOwnerChannels(): Promise<Ids> {
  const email = await ownerAttach(keyA, SLUG_A, emailBody("N84-A-email"));
  const webhook = await ownerAttach(keyA, SLUG_A, webhookBody("N84-A-webhook"));
  return { email: email.id, webhook: webhook.id };
}

/**
 * One probe per channel route. send() makes the call; tookEffect() reads the world and says whether
 * the call DID what it asked: attached, disclosed the URL and credentialRef, retargeted, deleted, sent.
 */
interface Probe {
  name: string;
  send(key: string | null, headers: Headers, ids: Ids): Promise<Res>;
  tookEffect(res: Res, ids: Ids): boolean;
}
const PROBES: Probe[] = [
  {
    name: "attach (POST /api/operators/:slug/channels)",
    send: (k, h) => call("POST", `/api/operators/${SLUG_A}/channels`, k, h, emailBody(PROBE_LABEL, ATTACKER_ADDRESS)),
    tookEffect: () => chans(SLUG_A).some((c) => c.label === PROBE_LABEL),
  },
  {
    name: "list (GET /api/operators/:slug/channels)",
    send: (k, h) => call("GET", `/api/operators/${SLUG_A}/channels`, k, h),
    tookEffect: (res) => res.body.includes(WEBHOOK_URL) || res.body.includes(VAULT_REF),
  },
  {
    name: "patch (PATCH /api/operators/channels/:id)",
    send: (k, h, ids) => call("PATCH", `/api/operators/channels/${ids.email}`, k, h, { endpoint: { address: ATTACKER_ADDRESS } }),
    tookEffect: (_res, ids) =>
      (chans(SLUG_A).find((c) => c.id === ids.email)?.endpoint as { address?: string } | undefined)?.address === ATTACKER_ADDRESS,
  },
  {
    name: "delete (DELETE /api/operators/channels/:id)",
    send: (k, h, ids) => call("DELETE", `/api/operators/channels/${ids.email}`, k, h),
    tookEffect: (_res, ids) => !chans(SLUG_A).some((c) => c.id === ids.email),
  },
  {
    name: "test send (POST /api/operators/:slug/channels/test)",
    send: (k, h) => call("POST", `/api/operators/${SLUG_A}/channels/test`, k, h, {}),
    tookEffect: () => sent.length > 0,
  },
];

beforeAll(async () => {
  const server = await import("../server.js");
  const gw = await server.createGateway(0);
  app = gw.app as unknown as FastifyInstance;
  await app.ready();
  const { provisionApiKey } = await import("../auth/api-key-auth.js");
  keyA = provisionApiKey({ operatorId: A, scopes: ["operator"] }).rawKey;
  keyB = provisionApiKey({ operatorId: B, scopes: ["operator"] }).rawKey;
  keyC = provisionApiKey({ operatorId: C, scopes: ["operator"] }).rawKey;
  await establishOwners();
});

beforeEach(() => {
  _clearOperatorChannelsForTests();
  sent.length = 0;
  __setEmailTransportForTests(recorder);
});

afterAll(async () => {
  __setEmailTransportForTests(undefined);
  await app?.close();
});

// ── Strangers ───────────────────────────────────────────────────────────────

describe("N84 owner binding, HTTP: an ordinary key does nothing to another operator's slug", () => {
  it("[neg] attach: refused (403), nothing written, even when the body names the key's own slug as the owner", async () => {
    const res = await call("POST", `/api/operators/${SLUG_A}/channels`, keyB, {}, {
      ...emailBody("N84-B-attach", ATTACKER_ADDRESS),
      // A slug or owner named in the body is never the record.
      operatorSlug: SLUG_B,
      operatorId: B,
      owner: B,
    });
    const labelsUnderA = chans(SLUG_A).map((c) => c.label);
    const labelsUnderB = chans(SLUG_B).map((c) => c.label);
    note("attach", { status: res.statusCode, labelsUnderOwnerSlug: labelsUnderA, labelsUnderStrangerSlug: labelsUnderB });
    expect(res.statusCode, res.body).toBe(403);
    expect(labelsUnderA).not.toContain("N84-B-attach");
    expect(labelsUnderB).not.toContain("N84-B-attach");
  });

  it("[neg] list: refused (403); the body carries neither endpoint.url nor credentialRef", async () => {
    await seedOwnerChannels();
    const res = await call("GET", `/api/operators/${SLUG_A}/channels`, keyB);
    note("list", {
      status: res.statusCode,
      bodyHasEndpointUrl: res.body.includes(WEBHOOK_URL),
      bodyHasCredentialRef: res.body.includes(VAULT_REF),
      bodyHasAddress: res.body.includes(OWNER_ADDRESS),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain(WEBHOOK_URL);
    expect(res.body).not.toContain(VAULT_REF);
    expect(res.body).not.toContain(OWNER_ADDRESS);
  });

  it("[neg] patch: refused (403); the channel keeps its endpoint, and the owner's next send still goes to the owner", async () => {
    const ids = await seedOwnerChannels();
    const res = await call("PATCH", `/api/operators/channels/${ids.email}`, keyB, {}, {
      endpoint: { address: ATTACKER_ADDRESS },
      enabled: true,
    });
    const stored = chans(SLUG_A).find((c) => c.id === ids.email);
    // What the retarget buys: the owner's own test send, then, goes to whoever PATCHed.
    await call("POST", `/api/operators/${SLUG_A}/channels/test`, keyA, {}, {});
    note("patch", { status: res.statusCode, storedEndpoint: stored?.endpoint, ownerNextSendGoesTo: sent.map((m) => m.to) });
    expect(res.statusCode, res.body).toBe(403);
    expect(stored?.endpoint).toEqual({ address: OWNER_ADDRESS });
    expect(sent.map((m) => m.to)).toEqual([OWNER_ADDRESS]);
  });

  it("[neg] patch: a slug or owner named in the BODY does not stand in for the channel's stored slug", async () => {
    const ids = await seedOwnerChannels();
    const res = await call("PATCH", `/api/operators/channels/${ids.email}`, keyB, {}, {
      operatorSlug: SLUG_B,
      operatorId: B,
      owner: B,
      label: "N84-B-relabelled",
    });
    const stored = chans(SLUG_A).find((c) => c.id === ids.email);
    note("patch-body-slug", {
      status: res.statusCode,
      storedLabel: stored?.label,
      storedSlug: stored?.operatorSlug,
      strangerSlugNowHas: chans(SLUG_B).map((c) => c.label),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(stored?.label).toBe("N84-A-email");
    expect(stored?.operatorSlug).toBe(SLUG_A);
    expect(chans(SLUG_B)).toHaveLength(0);
  });

  it("[neg] delete: refused (403); the channel is still there", async () => {
    const ids = await seedOwnerChannels();
    const res = await call("DELETE", `/api/operators/channels/${ids.email}`, keyB);
    const stillThere = chans(SLUG_A).some((c) => c.id === ids.email);
    note("delete", { status: res.statusCode, channelStillThere: stillThere });
    expect(res.statusCode, res.body).toBe(403);
    expect(stillThere).toBe(true);
  });

  it("[neg] test send: refused (403); the gateway sends nothing", async () => {
    await seedOwnerChannels();
    const res = await call("POST", `/api/operators/${SLUG_A}/channels/test`, keyB, {}, {});
    note("test-send", { status: res.statusCode, sends: sent.length, sentTo: sent.map((m) => m.to) });
    expect(res.statusCode, res.body).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

describe("N84 owner binding, A2A: an ordinary key attaches nothing under another operator's slug", () => {
  it("[neg] pcc-attach-channel naming the owner's slug", async () => {
    await seedOwnerChannels();
    const before = chans(SLUG_A).length;
    const { body } = await rpc(keyB, "pcc-attach-channel", { operatorSlug: SLUG_A, ...a2aChannel("N84-B-a2a-attach") });
    const labels = chans(SLUG_A).map((c) => c.label);
    note("a2a-attach-channel", {
      state: body.result?.state,
      error: body.error?.message,
      reportedAttached: reportedAttached(body),
      channelsUnderOwnerSlug: `${before} -> ${labels.length}`,
    });
    expect(labels).not.toContain("N84-B-a2a-attach");
    expect(chans(SLUG_A)).toHaveLength(before);
    expect(reportedAttached(body)).toBe(0);
  });

  it("[neg] pcc-author-integration with operatorSlug naming the owner's slug", async () => {
    await seedOwnerChannels();
    const before = chans(SLUG_A).length;
    const { body } = await rpc(keyB, "pcc-author-integration", {
      lane: "machine",
      name: "N84 B integration",
      type: "liquid-handling",
      location: { lat: 0, lng: 0 },
      operatorSlug: SLUG_A,
      channels: [a2aChannel("N84-B-author-explicit")],
    });
    const labels = chans(SLUG_A).map((c) => c.label);
    note("a2a-author-integration-explicit-slug", {
      state: body.result?.state,
      error: body.error?.message,
      reportedAttached: reportedAttached(body),
      channelsUnderOwnerSlug: `${before} -> ${labels.length}`,
    });
    expect(labels).not.toContain("N84-B-author-explicit");
    expect(chans(SLUG_A)).toHaveLength(before);
  });

  it("[neg] pcc-author-integration whose kernel NAME derives the owner's slug", async () => {
    // Naming a kernel for someone else's slug (C's) is not owning that slug.
    await ownerAttach(keyC, SLUG_C, emailBody("N84-C-email", "orders-c@n84.test"));
    const before = chans(SLUG_C).length;
    const { body } = await rpc(keyB, "pcc-author-integration", {
      lane: "machine",
      name: C,
      type: "liquid-handling",
      location: { lat: 0, lng: 0 },
      channels: [a2aChannel("N84-B-author-derived")],
    });
    const labels = chans(SLUG_C).map((c) => c.label);
    note("a2a-author-integration-derived-slug", {
      state: body.result?.state,
      error: body.error?.message,
      reportedAttached: reportedAttached(body),
      derivedSlug: (body.result?.artifacts?.[0]?.data as { operatorSlug?: string } | undefined)?.operatorSlug,
      channelsUnderOwnerSlug: `${before} -> ${labels.length}`,
    });
    expect(labels).not.toContain("N84-B-author-derived");
    expect(chans(SLUG_C)).toHaveLength(before);
  });
});

// ── Wrong admin secret, no identity ─────────────────────────────────────────

describe("N84 owner binding: a WRONG admin secret is refused (403), never downgraded to the key's own rights", () => {
  for (const probe of PROBES) {
    it(`[neg] ${probe.name}, with the OWNER's own key`, async () => {
      const ids = await seedOwnerChannels();
      sent.length = 0;
      const res = await probe.send(keyA, wrongAdminHeaders, ids);
      const tookEffect = probe.tookEffect(res, ids);
      note(`wrong-secret ${probe.name}`, { status: res.statusCode, tookEffect });
      expect(res.statusCode, res.body).toBe(403);
      expect(tookEffect).toBe(false);
    });
  }

  it("[neg] A2A pcc-attach-channel, with the OWNER's own key", async () => {
    await seedOwnerChannels();
    const before = chans(SLUG_A).length;
    const { body } = await rpc(keyA, "pcc-attach-channel", { operatorSlug: SLUG_A, ...a2aChannel("N84-A-wrong-secret") }, wrongAdminHeaders);
    note("wrong-secret a2a", { state: body.result?.state, error: body.error?.message, channelsUnderOwnerSlug: `${before} -> ${chans(SLUG_A).length}` });
    expect(chans(SLUG_A).map((c) => c.label)).not.toContain("N84-A-wrong-secret");
    expect(reportedAttached(body)).toBe(0);
  });
});

describe("N84 owner binding: no identity is 401 on every channel route, whatever else the request carries", () => {
  for (const probe of PROBES) {
    it(`control: ${probe.name}`, async () => {
      const ids = await seedOwnerChannels();
      sent.length = 0;
      // The admin secret alone is not an identity: the gate asks for a key first.
      for (const headers of [{}, adminHeaders]) {
        const res = await probe.send(null, headers, ids);
        expect(res.statusCode, res.body).toBe(401);
        expect(probe.tookEffect(res, ids)).toBe(false);
      }
    });
  }

  it("control: A2A pcc-attach-channel with no credentials is refused and attaches nothing", async () => {
    await seedOwnerChannels();
    const before = chans(SLUG_A).length;
    const { body } = await rpc(null, "pcc-attach-channel", { operatorSlug: SLUG_A, ...a2aChannel("N84-anon") });
    expect(body.error).toBeDefined();
    expect(chans(SLUG_A)).toHaveLength(before);
  });
});

// ── Controls: the owner and the admin ───────────────────────────────────────

describe("N84 owner binding, controls: the owner and the admin keep every route", () => {
  for (const probe of PROBES) {
    it(`control: the owner, ${probe.name}`, async () => {
      const ids = await seedOwnerChannels();
      sent.length = 0;
      const res = await probe.send(keyA, {}, ids);
      expect(res.statusCode, res.body).toBeLessThan(300);
      expect(probe.tookEffect(res, ids)).toBe(true);
    });
  }

  for (const probe of PROBES) {
    it(`control: the admin secret (on any ordinary key), ${probe.name}`, async () => {
      const ids = await seedOwnerChannels();
      sent.length = 0;
      const res = await probe.send(keyB, adminHeaders, ids);
      expect(res.statusCode, res.body).toBeLessThan(300);
      expect(probe.tookEffect(res, ids)).toBe(true);
    });
  }

  it("control: the owner attaches through both A2A paths that name its slug", async () => {
    const one = await rpc(keyA, "pcc-attach-channel", { operatorSlug: SLUG_A, ...a2aChannel("N84-A-a2a-attach", OWNER_ADDRESS) });
    expect(one.body.result?.state, JSON.stringify(one.body)).toBe("COMPLETED");
    expect(reportedAttached(one.body)).toBe(1);
    const two = await rpc(keyA, "pcc-author-integration", {
      lane: "machine",
      name: "N84 A integration",
      type: "liquid-handling",
      location: { lat: 0, lng: 0 },
      operatorSlug: SLUG_A,
      channels: [a2aChannel("N84-A-author", OWNER_ADDRESS)],
    });
    expect(two.body.result?.state, JSON.stringify(two.body)).toBe("COMPLETED");
    expect(reportedAttached(two.body)).toBe(1);
    expect(chans(SLUG_A).map((c) => c.label).sort()).toEqual(["N84-A-a2a-attach", "N84-A-author"]);
  });

  it("control: the admin secret reaches the A2A attach for any slug", async () => {
    await seedOwnerChannels();
    const { body } = await rpc(keyB, "pcc-attach-channel", { operatorSlug: SLUG_A, ...a2aChannel("N84-admin-a2a", OWNER_ADDRESS) }, adminHeaders);
    expect(body.result?.state, JSON.stringify(body)).toBe("COMPLETED");
    expect(chans(SLUG_A).map((c) => c.label)).toContain("N84-admin-a2a");
  });

  it("control: an ordinary key still manages ITS OWN slug on every route (the guard is per slug, not admin-only)", async () => {
    const own = await ownerAttach(keyB, SLUG_B, emailBody("N84-B-own", "orders-b@n84.test"));
    const list = await call("GET", `/api/operators/${SLUG_B}/channels`, keyB);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).toContain("N84-B-own");
    const patch = await call("PATCH", `/api/operators/channels/${own.id}`, keyB, {}, { label: "N84-B-own-2" });
    expect(patch.statusCode, patch.body).toBe(200);
    const test = await call("POST", `/api/operators/${SLUG_B}/channels/test`, keyB, {}, {});
    expect(test.statusCode, test.body).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["orders-b@n84.test"]);
    const del = await call("DELETE", `/api/operators/channels/${own.id}`, keyB);
    expect(del.statusCode, del.body).toBe(200);
    expect(chans(SLUG_B)).toHaveLength(0);
  });
});

// ── Found while tracing; not in the brief ───────────────────────────────────

describe("N84 owner binding, extra finding: the status view is a second way to read the channel records", () => {
  it("[neg] GET /api/operators/:slug/status gives an ordinary key neither endpoint.url nor credentialRef", async () => {
    await seedOwnerChannels();
    const res = await call("GET", `/api/operators/${SLUG_A}/status`, keyB);
    note("status", {
      status: res.statusCode,
      bodyHasEndpointUrl: res.body.includes(WEBHOOK_URL),
      bodyHasCredentialRef: res.body.includes(VAULT_REF),
      bodyHasAddress: res.body.includes(OWNER_ADDRESS),
    });
    expect(res.body).not.toContain(WEBHOOK_URL);
    expect(res.body).not.toContain(VAULT_REF);
    expect(res.body).not.toContain(OWNER_ADDRESS);
  });
});
