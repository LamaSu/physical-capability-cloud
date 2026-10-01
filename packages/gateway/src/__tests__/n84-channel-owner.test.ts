/**
 * N84, the WP-A part: an operator channel belongs to the identity that attached it.
 *
 * PR #483 (from master) guards the channel SEND path (a URL guard, a credential allowlist). It does not
 * decide WHO may touch a channel; per steward rule 6 that rides WP-A (#326, this branch). Before this fix
 * the channel routes were the old unguarded ones, so ANY authenticated key could, for any slug it named:
 *
 *   - GET    /api/operators/:slug/channels        list every channel: endpoint.url, credentialRef, address;
 *   - PATCH  /api/operators/channels/:id          retarget (or disable) a channel found by id;
 *   - DELETE /api/operators/channels/:id          delete a channel found by id;
 *   - POST   /api/operators/:slug/channels/test   make the gateway send to every enabled channel;
 *   - GET    /api/operators/:slug/status          the same records, whole, and counts that include them;
 *   - A2A tasks/send, pcc-attach-channel and pcc-author-integration: attach under any slug, and the reply
 *                                                 (totalChannelsNow) counts everyone's channels.
 *
 * THE RULING (orchestrator, gateway lane). A slug is a free-form string and nothing records who owns one;
 * nothing durable is added for now (no DDL). So the binding is PER CHANNEL, in memory beside the channels:
 * a channel records `creatorId`, the normalized authenticated actor at attach, never a body field.
 *   - Anyone authenticated may attach under any slug, but the channel is THEIRS: only its creator (or the
 *     admin secret) lists, patches, deletes or test-sends it.
 *   - Everyone else's channels are OMITTED from lists and from status, with no count and no kind. A test
 *     send reaches only the caller's own channels. A by-id write on a channel that is not yours answers as
 *     for an unknown id.
 *   - A channel with no creator (legacy) is the admin's alone. A presented admin secret is never downgraded:
 *     a wrong one is 403 even with the creator's own key. No identity is 401.
 *
 * Runs on the real server (createGateway: apiGate, scopeChecker, every route). Nothing here touches the
 * network: sends go to a recording email transport, and the one webhook channel that carries a URL and a
 * credentialRef is DISABLED, so no dispatch ever reaches it.
 *
 * Reading the failing run: every "[neg]" test fails before the fix and every "control:" test passes. The
 * "[N84-OWNER-REPRO]" lines print what each call actually did.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  attachChannel,
  getChannelsByOperator,
  _clearOperatorChannelsForTests,
} from "../routes/operator-channels.js";
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

// A is the creator of the channels under test. B is an ordinary key. C is a second creator (derived-slug case).
// The slugs are free-form on purpose: none of them is an identity, and none names an owner.
const A = "n84-owner-a";
const B = "n84-stranger-b";
const C = "n84-owner-c";
const SLUG = "n84-pizza-shop";
const SLUG_B = "n84-b-own-shop";
const SLUG_C = "n84-owner-c-shop";
const NAME_C = "N84 Owner C Shop"; // slugifies to SLUG_C

const OWNER_ADDRESS = "orders-a@n84.test";
const STRANGER_ADDRESS = "orders-b@n84.test";
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
interface ChannelJson {
  id: string;
  label: string;
  operatorSlug?: string;
  creatorId?: string;
  endpoint?: Record<string, unknown>;
}

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
const rpcData = (body: RpcBody) => body.result?.artifacts?.[0]?.data;
/** Channels an A2A reply says it attached (pcc-attach-channel: attached; pcc-author-integration: channels). */
function reportedAttached(body: RpcBody): number {
  const d = rpcData(body);
  const list = (d?.attached ?? d?.channels) as unknown[] | undefined;
  return Array.isArray(list) ? list.length : 0;
}

/** The store as the admin sees it (the unfiltered accessor), to prove what was and was not written. */
const chans = (slug: string) => getChannelsByOperator(slug) as ChannelJson[];
const listed = (res: Res): ChannelJson[] => (res.json() as { channels?: ChannelJson[] }).channels ?? [];
const sendResults = (res: Res): unknown[] => (res.json() as { results?: unknown[] }).results ?? [];
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

/** Attach through the HTTP route as `key`. Anyone authenticated may attach under any slug. */
async function attachAs(key: string, slug: string, body: Record<string, unknown>): Promise<ChannelJson> {
  const res = await call("POST", `/api/operators/${slug}/channels`, key, {}, body);
  expect(res.statusCode, `precondition: an authenticated key attaches under any slug: ${res.body}`).toBe(201);
  return (res.json() as { channel: ChannelJson }).channel;
}

interface Ids {
  email: string;
  webhook: string;
}
/** A's channels under SLUG: one live email channel, one disabled webhook with a URL and a credentialRef. */
async function seedOwnerChannels(): Promise<Ids> {
  const email = await attachAs(keyA, SLUG, emailBody("N84-A-email"));
  const webhook = await attachAs(keyA, SLUG, webhookBody("N84-A-webhook"));
  return { email: email.id, webhook: webhook.id };
}
/** B attaches a live email channel of its own under the SAME slug. */
const strangerAttach = (label = "N84-B-email") => attachAs(keyB, SLUG, emailBody(label, STRANGER_ADDRESS));

/** A key for the SAME identity as `operatorId`, spelled differently (inserted directly, as the N46 tests do). */
async function respelledKey(operatorId: string): Promise<string> {
  const { generateApiKey } = await import("../auth/api-key-auth.js");
  const { getRepos } = await import("../db.js");
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `n84-respelled-key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}

/**
 * One probe per route that touches a channel. send() makes the call; tookEffect() reads the world and says
 * whether the call DID what it asked: attached, disclosed the URL and credentialRef, retargeted, deleted, sent.
 */
interface Probe {
  name: string;
  send(key: string | null, headers: Headers, ids: Ids): Promise<Res>;
  tookEffect(res: Res, ids: Ids): boolean;
}
const discloses = (res: Res) => res.body.includes(WEBHOOK_URL) || res.body.includes(VAULT_REF);
const PROBES: Probe[] = [
  {
    name: "attach (POST /api/operators/:slug/channels)",
    send: (k, h) => call("POST", `/api/operators/${SLUG}/channels`, k, h, emailBody(PROBE_LABEL, ATTACKER_ADDRESS)),
    tookEffect: () => chans(SLUG).some((c) => c.label === PROBE_LABEL),
  },
  {
    name: "list (GET /api/operators/:slug/channels)",
    send: (k, h) => call("GET", `/api/operators/${SLUG}/channels`, k, h),
    tookEffect: (res) => discloses(res),
  },
  {
    name: "patch (PATCH /api/operators/channels/:id)",
    send: (k, h, ids) => call("PATCH", `/api/operators/channels/${ids.email}`, k, h, { endpoint: { address: ATTACKER_ADDRESS } }),
    tookEffect: (_res, ids) =>
      (chans(SLUG).find((c) => c.id === ids.email)?.endpoint as { address?: string } | undefined)?.address === ATTACKER_ADDRESS,
  },
  {
    name: "delete (DELETE /api/operators/channels/:id)",
    send: (k, h, ids) => call("DELETE", `/api/operators/channels/${ids.email}`, k, h),
    tookEffect: (_res, ids) => !chans(SLUG).some((c) => c.id === ids.email),
  },
  {
    name: "test send (POST /api/operators/:slug/channels/test)",
    send: (k, h) => call("POST", `/api/operators/${SLUG}/channels/test`, k, h, {}),
    tookEffect: () => sent.length > 0,
  },
  {
    name: "status (GET /api/operators/:slug/status)",
    send: (k, h) => call("GET", `/api/operators/${SLUG}/status`, k, h),
    tookEffect: (res) => discloses(res),
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

/** A detail of A's channels that must not appear anywhere in what B is told. */
const detailsOfA = (ids: Ids) => [WEBHOOK_URL, VAULT_REF, OWNER_ADDRESS, "N84-A-email", "N84-A-webhook", ids.email, ids.webhook];

// ── Strangers: not yours to read, change, delete or test-send ───────────────

describe("N84 creator binding, HTTP: another identity's channels are not yours to read, change, delete or test-send", () => {
  it("[neg] list: A's channels are omitted entirely (200, an empty list), not a byte of their details", async () => {
    const ids = await seedOwnerChannels();
    const res = await call("GET", `/api/operators/${SLUG}/channels`, keyB);
    const shown = listed(res);
    note("list", {
      status: res.statusCode,
      channelsShown: shown.length,
      bodyHasEndpointUrl: res.body.includes(WEBHOOK_URL),
      bodyHasCredentialRef: res.body.includes(VAULT_REF),
      bodyHasAddress: res.body.includes(OWNER_ADDRESS),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(shown).toEqual([]);
    for (const detail of detailsOfA(ids)) expect(res.body, detail).not.toContain(detail);
  });

  it("[neg] patch: refused; the channel keeps its endpoint, and the owner's next send still goes to the owner", async () => {
    const ids = await seedOwnerChannels();
    const res = await call("PATCH", `/api/operators/channels/${ids.email}`, keyB, {}, {
      endpoint: { address: ATTACKER_ADDRESS },
      enabled: true,
    });
    const stored = chans(SLUG).find((c) => c.id === ids.email);
    // What the retarget buys: the owner's own test send, then, goes to whoever PATCHed.
    await call("POST", `/api/operators/${SLUG}/channels/test`, keyA, {}, {});
    note("patch", { status: res.statusCode, storedEndpoint: stored?.endpoint, ownerNextSendGoesTo: sent.map((m) => m.to) });
    expect([403, 404], res.body).toContain(res.statusCode);
    expect(stored?.endpoint).toEqual({ address: OWNER_ADDRESS });
    expect(sent.map((m) => m.to)).toEqual([OWNER_ADDRESS]);
  });

  it("[neg] patch: a slug, owner or creatorId named in the BODY does not stand in for the channel's stored creator", async () => {
    const ids = await seedOwnerChannels();
    const res = await call("PATCH", `/api/operators/channels/${ids.email}`, keyB, {}, {
      operatorSlug: SLUG_B,
      operatorId: B,
      owner: B,
      creatorId: B,
      label: "N84-B-relabelled",
    });
    const stored = chans(SLUG).find((c) => c.id === ids.email);
    note("patch-body-owner", {
      status: res.statusCode,
      storedLabel: stored?.label,
      storedSlug: stored?.operatorSlug,
      storedCreator: stored?.creatorId,
      strangerSlugNowHas: chans(SLUG_B).map((c) => c.label),
    });
    expect([403, 404], res.body).toContain(res.statusCode);
    expect(stored?.label).toBe("N84-A-email");
    expect(stored?.operatorSlug).toBe(SLUG);
    expect(stored?.creatorId).toBe(A);
    expect(chans(SLUG_B)).toHaveLength(0);
    // A body that names the channel's REAL slug and its real creator is no better.
    const again = await call("PATCH", `/api/operators/channels/${ids.email}`, keyB, {}, {
      operatorSlug: SLUG,
      operatorId: A,
      owner: A,
      creatorId: A,
      label: "N84-B-relabelled-again",
    });
    expect([403, 404], again.body).toContain(again.statusCode);
    expect(chans(SLUG).find((c) => c.id === ids.email)?.label).toBe("N84-A-email");
  });

  it("[neg] delete: refused; the channel is still there", async () => {
    const ids = await seedOwnerChannels();
    const res = await call("DELETE", `/api/operators/channels/${ids.email}`, keyB);
    const stillThere = chans(SLUG).some((c) => c.id === ids.email);
    note("delete", { status: res.statusCode, channelStillThere: stillThere });
    expect([403, 404], res.body).toContain(res.statusCode);
    expect(stillThere).toBe(true);
  });

  it("[neg] test send: B has no channel under the slug, so nothing is sent (404, or an empty result)", async () => {
    await seedOwnerChannels();
    const res = await call("POST", `/api/operators/${SLUG}/channels/test`, keyB, {}, {});
    note("test-send", { status: res.statusCode, results: sendResults(res).length, sends: sent.length, sentTo: sent.map((m) => m.to) });
    expect(sent).toHaveLength(0);
    expect(res.statusCode === 404 || (res.statusCode === 200 && sendResults(res).length === 0), res.body).toBe(true);
  });
});

// ── Isolation: anyone may attach under any slug, but the channel is its creator's alone ──

describe("N84 creator binding: anyone may attach under any slug, but the channel is its creator's alone", () => {
  it("[neg] attach: allowed under any slug, and recorded as the CALLER's, never the body's", async () => {
    const res = await call("POST", `/api/operators/${SLUG}/channels`, keyB, {}, {
      ...emailBody("N84-B-attach", STRANGER_ADDRESS),
      creatorId: A,
      owner: A,
      operatorId: A,
      operatorSlug: SLUG_B,
    });
    const stored = chans(SLUG).find((c) => c.label === "N84-B-attach");
    note("attach", {
      status: res.statusCode,
      storedCreator: stored?.creatorId,
      storedSlug: stored?.operatorSlug,
      underBodySlug: chans(SLUG_B).length,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(stored?.operatorSlug).toBe(SLUG);
    expect(stored?.creatorId).toBe(B);
    expect(chans(SLUG_B)).toHaveLength(0);
  });

  it("[neg] A's list omits B's channel: omitted, not redacted, with no trace of it", async () => {
    const ids = await seedOwnerChannels();
    const theirs = await strangerAttach();
    const res = await call("GET", `/api/operators/${SLUG}/channels`, keyA);
    const shown = listed(res);
    note("owner-list-with-stranger-channel", { status: res.statusCode, ids: shown.map((c) => c.id), count: shown.length });
    expect(res.statusCode, res.body).toBe(200);
    expect(shown.map((c) => c.id).sort()).toEqual([ids.email, ids.webhook].sort());
    for (const trace of [theirs.id, theirs.label, STRANGER_ADDRESS]) expect(res.body, trace).not.toContain(trace);
  });

  it("[neg] A's test send never reaches B's channel", async () => {
    await seedOwnerChannels();
    await strangerAttach();
    const res = await call("POST", `/api/operators/${SLUG}/channels/test`, keyA, {}, {});
    note("owner-test-send-with-stranger-channel", { status: res.statusCode, sentTo: sent.map((m) => m.to), results: sendResults(res).length });
    expect(res.statusCode, res.body).toBe(200);
    expect(sent.map((m) => m.to)).toEqual([OWNER_ADDRESS]);
    expect(sendResults(res)).toHaveLength(1);
  });

  it("[neg] B, with a channel of its own under the same slug, sees none of A's channels or details: list, test send, status", async () => {
    const ids = await seedOwnerChannels();
    const mine = await strangerAttach();
    const list = await call("GET", `/api/operators/${SLUG}/channels`, keyB);
    const test = await call("POST", `/api/operators/${SLUG}/channels/test`, keyB, {}, {});
    const status = await call("GET", `/api/operators/${SLUG}/status`, keyB);
    const sBody = status.json() as { channels?: ChannelJson[]; totals?: { channelCount?: number; enabledChannelCount?: number } };
    note("stranger-sees", {
      listIds: listed(list).map((c) => c.id),
      sentTo: sent.map((m) => m.to),
      statusChannelIds: (sBody.channels ?? []).map((c) => c.id),
      statusTotals: sBody.totals,
    });
    expect(listed(list).map((c) => c.id)).toEqual([mine.id]);
    expect(sent.map((m) => m.to)).toEqual([STRANGER_ADDRESS]);
    expect((sBody.channels ?? []).map((c) => c.id)).toEqual([mine.id]);
    expect(sBody.totals?.channelCount).toBe(1);
    expect(sBody.totals?.enabledChannelCount).toBe(1);
    for (const res of [list, test, status]) {
      for (const detail of detailsOfA(ids)) expect(res.body, detail).not.toContain(detail);
    }
  });

  it("[neg] A cannot change or delete B's channel under the same slug: ownership is the channel's own, not the slug's", async () => {
    await seedOwnerChannels();
    const theirs = await strangerAttach();
    const patch = await call("PATCH", `/api/operators/channels/${theirs.id}`, keyA, {}, {
      label: "N84-A-relabelled",
      endpoint: { address: ATTACKER_ADDRESS },
    });
    const del = await call("DELETE", `/api/operators/channels/${theirs.id}`, keyA);
    const stored = chans(SLUG).find((c) => c.id === theirs.id);
    note("owner-vs-stranger-channel", {
      patch: patch.statusCode,
      delete: del.statusCode,
      storedLabel: stored?.label,
      storedEndpoint: stored?.endpoint,
    });
    expect([403, 404], patch.body).toContain(patch.statusCode);
    expect([403, 404], del.body).toContain(del.statusCode);
    expect(stored?.label).toBe("N84-B-email");
    expect(stored?.endpoint).toEqual({ address: STRANGER_ADDRESS });
  });

  it("[neg] the creator cannot be changed through PATCH: a creatorId in the body is ignored, for the creator and for the admin", async () => {
    const ids = await seedOwnerChannels();
    const byOwner = await call("PATCH", `/api/operators/channels/${ids.email}`, keyA, {}, { creatorId: B, label: "N84-A-renamed" });
    const afterOwner = chans(SLUG).find((c) => c.id === ids.email);
    const byAdmin = await call("PATCH", `/api/operators/channels/${ids.email}`, keyB, adminHeaders, { creatorId: B, owner: B });
    const afterAdmin = chans(SLUG).find((c) => c.id === ids.email);
    const bList = await call("GET", `/api/operators/${SLUG}/channels`, keyB);
    note("patch-creator", {
      ownerStatus: byOwner.statusCode,
      creatorAfterOwnerPatch: afterOwner?.creatorId,
      adminStatus: byAdmin.statusCode,
      creatorAfterAdminPatch: afterAdmin?.creatorId,
      strangerListNow: listed(bList).length,
    });
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    expect(afterOwner?.label).toBe("N84-A-renamed");
    expect(afterOwner?.creatorId).toBe(A);
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(afterAdmin?.creatorId).toBe(A);
    expect(listed(bList)).toEqual([]);
  });

  it("control: the admin secret (on any ordinary key) lists and test-sends every creator's channels", async () => {
    const ids = await seedOwnerChannels();
    const theirs = await strangerAttach();
    const list = await call("GET", `/api/operators/${SLUG}/channels`, keyB, adminHeaders);
    const test = await call("POST", `/api/operators/${SLUG}/channels/test`, keyB, adminHeaders, {});
    expect(list.statusCode, list.body).toBe(200);
    expect(listed(list).map((c) => c.id).sort()).toEqual([ids.email, ids.webhook, theirs.id].sort());
    expect(test.statusCode, test.body).toBe(200);
    expect(sent.map((m) => m.to).sort()).toEqual([OWNER_ADDRESS, STRANGER_ADDRESS].sort());
  });

  it("control: the creator is known under a respelled identity too (trimmed, case-folded)", async () => {
    const ids = await seedOwnerChannels();
    const respelled = await respelledKey(` ${A.toUpperCase()} `);
    const list = await call("GET", `/api/operators/${SLUG}/channels`, respelled);
    expect(list.statusCode, list.body).toBe(200);
    expect(listed(list).map((c) => c.id).sort()).toEqual([ids.email, ids.webhook].sort());
    const patch = await call("PATCH", `/api/operators/channels/${ids.email}`, respelled, {}, { label: "N84-A-by-respelled" });
    expect(patch.statusCode, patch.body).toBe(200);
    const test = await call("POST", `/api/operators/${SLUG}/channels/test`, respelled, {}, {});
    expect(test.statusCode, test.body).toBe(200);
    expect(sent.map((m) => m.to)).toEqual([OWNER_ADDRESS]);
  });
});

// ── A2A ─────────────────────────────────────────────────────────────────────

describe("N84 creator binding, A2A: a channel attached through a skill is the caller's alone, and counts only the caller's", () => {
  it("[neg] pcc-attach-channel under another identity's slug: B's channel, B's count, absent from A's list", async () => {
    await seedOwnerChannels();
    const { body } = await rpc(keyB, "pcc-attach-channel", { operatorSlug: SLUG, ...a2aChannel("N84-B-a2a-attach", STRANGER_ADDRESS) });
    const mine = chans(SLUG).find((c) => c.label === "N84-B-a2a-attach");
    const aList = await call("GET", `/api/operators/${SLUG}/channels`, keyA);
    note("a2a-attach-channel", {
      state: body.result?.state,
      error: body.error?.message,
      reportedAttached: reportedAttached(body),
      totalChannelsNow: rpcData(body)?.totalChannelsNow,
      storedCreator: mine?.creatorId,
      ownerListLabels: listed(aList).map((c) => c.label),
    });
    expect(body.result?.state, JSON.stringify(body)).toBe("COMPLETED");
    expect(reportedAttached(body)).toBe(1);
    expect(rpcData(body)?.totalChannelsNow).toBe(1); // A's two channels are not B's to count
    expect(mine?.creatorId).toBe(B);
    expect(listed(aList).map((c) => c.label)).not.toContain("N84-B-a2a-attach");
  });

  it("[neg] pcc-author-integration with operatorSlug naming another identity's slug: the same", async () => {
    await seedOwnerChannels();
    const { body } = await rpc(keyB, "pcc-author-integration", {
      lane: "machine",
      name: "N84 B integration",
      type: "liquid-handling",
      location: { lat: 0, lng: 0 },
      operatorSlug: SLUG,
      channels: [a2aChannel("N84-B-author-explicit", STRANGER_ADDRESS)],
    });
    const mine = chans(SLUG).find((c) => c.label === "N84-B-author-explicit");
    const aList = await call("GET", `/api/operators/${SLUG}/channels`, keyA);
    note("a2a-author-integration-explicit-slug", {
      state: body.result?.state,
      error: body.error?.message,
      reportedAttached: reportedAttached(body),
      storedCreator: mine?.creatorId,
      ownerListLabels: listed(aList).map((c) => c.label),
    });
    expect(body.result?.state, JSON.stringify(body)).toBe("COMPLETED");
    expect(reportedAttached(body)).toBe(1);
    expect(mine?.creatorId).toBe(B);
    expect(listed(aList).map((c) => c.label)).not.toContain("N84-B-author-explicit");
  });

  it("[neg] pcc-author-integration whose kernel NAME derives another identity's slug: the same", async () => {
    const theirs = await attachAs(keyC, SLUG_C, emailBody("N84-C-email", "orders-c@n84.test"));
    const { body } = await rpc(keyB, "pcc-author-integration", {
      lane: "machine",
      name: NAME_C,
      type: "liquid-handling",
      location: { lat: 0, lng: 0 },
      channels: [a2aChannel("N84-B-author-derived", STRANGER_ADDRESS)],
    });
    const mine = chans(SLUG_C).find((c) => c.label === "N84-B-author-derived");
    const cList = await call("GET", `/api/operators/${SLUG_C}/channels`, keyC);
    note("a2a-author-integration-derived-slug", {
      state: body.result?.state,
      error: body.error?.message,
      derivedSlug: (rpcData(body) as { operatorSlug?: string } | undefined)?.operatorSlug,
      storedCreator: mine?.creatorId,
      ownerListIds: listed(cList).map((c) => c.id),
    });
    expect((rpcData(body) as { operatorSlug?: string } | undefined)?.operatorSlug).toBe(SLUG_C);
    expect(mine?.creatorId).toBe(B);
    expect(listed(cList).map((c) => c.id)).toEqual([theirs.id]);
  });
});

// ── Wrong admin secret, no identity ─────────────────────────────────────────

describe("N84 creator binding: a WRONG admin secret is refused (403), never downgraded to the key's own rights", () => {
  for (const probe of PROBES) {
    it(`[neg] ${probe.name}, with the creator's own key`, async () => {
      const ids = await seedOwnerChannels();
      sent.length = 0;
      const res = await probe.send(keyA, wrongAdminHeaders, ids);
      const tookEffect = probe.tookEffect(res, ids);
      note(`wrong-secret ${probe.name}`, { status: res.statusCode, tookEffect });
      expect(res.statusCode, res.body).toBe(403);
      expect(tookEffect).toBe(false);
    });
  }

  it("[neg] A2A pcc-attach-channel, with the creator's own key", async () => {
    await seedOwnerChannels();
    const before = chans(SLUG).length;
    const { body } = await rpc(keyA, "pcc-attach-channel", { operatorSlug: SLUG, ...a2aChannel("N84-A-wrong-secret") }, wrongAdminHeaders);
    note("wrong-secret a2a-attach", { state: body.result?.state, error: body.error?.message, channels: `${before} -> ${chans(SLUG).length}` });
    expect(body.error, JSON.stringify(body)).toBeDefined();
    expect(chans(SLUG).map((c) => c.label)).not.toContain("N84-A-wrong-secret");
    expect(reportedAttached(body)).toBe(0);
  });

  it("[neg] A2A pcc-author-integration, with the creator's own key: nothing is registered or attached", async () => {
    const { body } = await rpc(keyA, "pcc-author-integration", {
      lane: "machine",
      name: "N84 wrong-secret integration",
      type: "liquid-handling",
      location: { lat: 0, lng: 0 },
      operatorSlug: SLUG,
      channels: [a2aChannel("N84-A-author-wrong-secret")],
    }, wrongAdminHeaders);
    note("wrong-secret a2a-author-integration", { state: body.result?.state, error: body.error?.message, attached: chans(SLUG).length });
    expect(body.error, JSON.stringify(body)).toBeDefined();
    expect(chans(SLUG)).toHaveLength(0);
  });
});

describe("N84 creator binding: no identity is 401 on every channel route, whatever else the request carries", () => {
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
    const before = chans(SLUG).length;
    const { body } = await rpc(null, "pcc-attach-channel", { operatorSlug: SLUG, ...a2aChannel("N84-anon") });
    expect(body.error).toBeDefined();
    expect(chans(SLUG)).toHaveLength(before);
  });
});

// ── Legacy: a channel with no creator is the admin's alone ──────────────────

describe("N84 creator binding: a channel with no creator (legacy) is the admin's alone", () => {
  it("[neg] an ordinary key neither lists, patches, deletes nor test-sends it", async () => {
    const legacy = attachChannel(SLUG, emailBody("N84-legacy", "legacy@n84.test"), null);
    const list = await call("GET", `/api/operators/${SLUG}/channels`, keyA);
    // The send is tried first, so it is judged while the channel still exists.
    const test = await call("POST", `/api/operators/${SLUG}/channels/test`, keyA, {}, {});
    const patch = await call("PATCH", `/api/operators/channels/${legacy.id}`, keyA, {}, { label: "N84-legacy-renamed" });
    const del = await call("DELETE", `/api/operators/channels/${legacy.id}`, keyA);
    const stored = chans(SLUG).find((c) => c.id === legacy.id);
    note("legacy", {
      listed: listed(list).length,
      patch: patch.statusCode,
      delete: del.statusCode,
      test: test.statusCode,
      sentTo: sent.map((m) => m.to),
      storedLabel: stored?.label,
    });
    expect(listed(list)).toEqual([]);
    expect([403, 404], patch.body).toContain(patch.statusCode);
    expect([403, 404], del.body).toContain(del.statusCode);
    expect(test.statusCode === 404 || (test.statusCode === 200 && sendResults(test).length === 0), test.body).toBe(true);
    expect(sent).toHaveLength(0);
    expect(stored?.label).toBe("N84-legacy");
  });

  it("control: the admin secret lists, patches, test-sends and deletes it", async () => {
    const legacy = attachChannel(SLUG, emailBody("N84-legacy", "legacy@n84.test"), null);
    const list = await call("GET", `/api/operators/${SLUG}/channels`, keyA, adminHeaders);
    expect(listed(list).map((c) => c.id)).toEqual([legacy.id]);
    const patch = await call("PATCH", `/api/operators/channels/${legacy.id}`, keyA, adminHeaders, { label: "N84-legacy-renamed" });
    expect(patch.statusCode, patch.body).toBe(200);
    const test = await call("POST", `/api/operators/${SLUG}/channels/test`, keyA, adminHeaders, {});
    expect(test.statusCode, test.body).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["legacy@n84.test"]);
    const del = await call("DELETE", `/api/operators/channels/${legacy.id}`, keyA, adminHeaders);
    expect(del.statusCode, del.body).toBe(200);
    expect(chans(SLUG)).toHaveLength(0);
  });
});

// ── Controls: the creator and the admin keep every route ────────────────────

describe("N84 creator binding, controls: the creator and the admin keep every route", () => {
  for (const probe of PROBES) {
    it(`control: the creator, ${probe.name}`, async () => {
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

  it("control: the creator attaches through both A2A paths, and each reply counts the creator's own channels", async () => {
    const one = await rpc(keyA, "pcc-attach-channel", { operatorSlug: SLUG, ...a2aChannel("N84-A-a2a-attach", OWNER_ADDRESS) });
    expect(one.body.result?.state, JSON.stringify(one.body)).toBe("COMPLETED");
    expect(reportedAttached(one.body)).toBe(1);
    expect(rpcData(one.body)?.totalChannelsNow).toBe(1);
    const two = await rpc(keyA, "pcc-author-integration", {
      lane: "machine",
      name: "N84 A integration",
      type: "liquid-handling",
      location: { lat: 0, lng: 0 },
      operatorSlug: SLUG,
      channels: [a2aChannel("N84-A-author", OWNER_ADDRESS)],
    });
    expect(two.body.result?.state, JSON.stringify(two.body)).toBe("COMPLETED");
    expect(reportedAttached(two.body)).toBe(1);
    expect(chans(SLUG).map((c) => c.label).sort()).toEqual(["N84-A-a2a-attach", "N84-A-author"]);
  });

  it("control: the admin secret reaches the A2A attach for any slug", async () => {
    await seedOwnerChannels();
    const { body } = await rpc(keyB, "pcc-attach-channel", { operatorSlug: SLUG, ...a2aChannel("N84-admin-a2a", OWNER_ADDRESS) }, adminHeaders);
    expect(body.result?.state, JSON.stringify(body)).toBe("COMPLETED");
    expect(chans(SLUG).map((c) => c.label)).toContain("N84-admin-a2a");
    // The admin's reply counts every creator's channels (A's two, and this one).
    expect(rpcData(body)?.totalChannelsNow).toBe(3);
  });

  it("control: an ordinary key still manages ITS OWN channels on every route (the binding is per channel, not admin-only)", async () => {
    const own = await attachAs(keyB, SLUG_B, emailBody("N84-B-own", STRANGER_ADDRESS));
    const list = await call("GET", `/api/operators/${SLUG_B}/channels`, keyB);
    expect(list.statusCode, list.body).toBe(200);
    expect(listed(list).map((c) => c.id)).toEqual([own.id]);
    const patch = await call("PATCH", `/api/operators/channels/${own.id}`, keyB, {}, { label: "N84-B-own-2" });
    expect(patch.statusCode, patch.body).toBe(200);
    const test = await call("POST", `/api/operators/${SLUG_B}/channels/test`, keyB, {}, {});
    expect(test.statusCode, test.body).toBe(200);
    expect(sent.map((m) => m.to)).toEqual([STRANGER_ADDRESS]);
    const del = await call("DELETE", `/api/operators/channels/${own.id}`, keyB);
    expect(del.statusCode, del.body).toBe(200);
    expect(chans(SLUG_B)).toHaveLength(0);
  });
});

// ── Status: the same records, whole (the adk lane's R3 reworks this route) ──

describe("N84 creator binding, status route: only the caller's own channels, and counts and readiness computed from them", () => {
  it("[neg] B's status of a slug that holds only A's channels shows none of them, and reports no channel at all", async () => {
    const ids = await seedOwnerChannels();
    const res = await call("GET", `/api/operators/${SLUG}/status`, keyB);
    const s = res.json() as {
      channels?: ChannelJson[];
      totals?: { channelCount?: number; enabledChannelCount?: number };
      missing?: string[];
    };
    note("status-stranger", {
      status: res.statusCode,
      channels: (s.channels ?? []).length,
      totals: s.totals,
      missingChannelSlot: (s.missing ?? []).some((m) => /channel \(slot 3\)/.test(m)),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(s.channels).toEqual([]);
    expect(s.totals?.channelCount).toBe(0);
    expect(s.totals?.enabledChannelCount).toBe(0);
    // Readiness is computed from B's own channels: B has none, so the channel slot is reported missing.
    expect((s.missing ?? []).some((m) => /channel \(slot 3\)/.test(m))).toBe(true);
    for (const detail of detailsOfA(ids)) expect(res.body, detail).not.toContain(detail);
  });

  it("[neg] A's status counts only A's channels, however many B has attached under the slug", async () => {
    await seedOwnerChannels();
    await strangerAttach("N84-B-one");
    await strangerAttach("N84-B-two");
    const res = await call("GET", `/api/operators/${SLUG}/status`, keyA);
    const s = res.json() as { channels?: ChannelJson[]; totals?: { channelCount?: number; enabledChannelCount?: number } };
    note("status-owner-with-stranger-channels", { channels: (s.channels ?? []).map((c) => c.label), totals: s.totals });
    expect(res.statusCode, res.body).toBe(200);
    expect((s.channels ?? []).map((c) => c.label).sort()).toEqual(["N84-A-email", "N84-A-webhook"]);
    expect(s.totals?.channelCount).toBe(2);
    expect(s.totals?.enabledChannelCount).toBe(1);
    expect(res.body).not.toContain(STRANGER_ADDRESS);
  });

  it("control: A's status carries A's channels in full", async () => {
    await seedOwnerChannels();
    const res = await call("GET", `/api/operators/${SLUG}/status`, keyA);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(WEBHOOK_URL);
    expect(res.body).toContain(VAULT_REF);
    expect(res.body).toContain(OWNER_ADDRESS);
  });

  it("control: the admin secret's status counts every creator's channels", async () => {
    await seedOwnerChannels();
    await strangerAttach();
    const res = await call("GET", `/api/operators/${SLUG}/status`, keyB, adminHeaders);
    const s = res.json() as { totals?: { channelCount?: number; enabledChannelCount?: number } };
    expect(res.statusCode, res.body).toBe(200);
    expect(s.totals?.channelCount).toBe(3);
    expect(s.totals?.enabledChannelCount).toBe(2);
  });
});
