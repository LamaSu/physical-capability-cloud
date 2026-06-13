/**
 * pizza-oracle lifecycle tests — pre-commit → stake → escrow → evidence →
 * user-confirms-delivery, plus the failure paths.
 *
 * Both route plugins are registered on one Fastify instance so the full flow
 * exercises the shared in-memory store (pizza-store.ts). Orders are seeded with
 * `_seedOrderForTests` to keep these tests focused on the oracle lifecycle
 * (the compose engine that normally produces the composition is covered by
 * compose.test.ts).
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { pizzaDemoRoutes } from "../routes/pizza-demo.js";
import { pizzaOracleRoutes } from "../routes/pizza-oracle.js";
import {
  _clearPizzaForTests,
  _expireConfirmationWindow,
  _expireStakeWindow,
  _hasEvent,
  _seedOrderForTests,
  computeCommitmentHash,
} from "../routes/pizza-store.js";

const SHOP = "shop-roma";
const DRIVER = "driver-alex";
const USER = "user_demo";
const IN_GEOFENCE = { lat: 37.77, lng: -122.42 };

function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(pizzaDemoRoutes);
  void app.register(pizzaOracleRoutes);
  return app;
}

beforeEach(() => _clearPizzaForTests());

// ── Flow helpers ─────────────────────────────────────────────────────────────

interface StakingState {
  orderId: string;
  jobId: string;
  commitments: Array<{ partyId: string; stakeUSD: number; partyRole: string }>;
}

/** Seed → confirm → pre-commit. Order ends in `staking`. */
async function toStaking(app: FastifyInstance): Promise<StakingState> {
  const order = _seedOrderForTests();
  const confirm = await app.inject({
    method: "POST",
    url: `/api/demo/orders/${order.orderId}/confirm`,
  });
  expect(confirm.statusCode).toBe(200);
  expect(confirm.json().order.status).toBe("confirmed");

  const pre = await app.inject({
    method: "POST",
    url: `/api/demo/orders/${order.orderId}/pre-commit`,
    payload: {},
  });
  expect(pre.statusCode).toBe(201);
  const body = pre.json();
  return { orderId: order.orderId, jobId: body.jobId, commitments: body.commitments };
}

function stake(
  app: FastifyInstance,
  jobId: string,
  partyId: string,
  stakeUSD: number,
  secret = `secret-${partyId}`,
) {
  return app.inject({
    method: "POST",
    url: `/api/demo/jobs/${jobId}/stake`,
    payload: { partyId, stakeUSD, commitmentHash: computeCommitmentHash(secret, jobId, partyId) },
  });
}

async function stakeAll(app: FastifyInstance, s: StakingState): Promise<void> {
  for (const c of s.commitments) {
    const res = await stake(app, s.jobId, c.partyId, c.stakeUSD);
    expect(res.statusCode).toBe(200);
  }
}

function bundle(
  jobId: string,
  partyId: string,
  opts: { photo?: boolean; geo?: { lat: number; lng: number }; ts?: boolean; bundleId?: string } = {},
) {
  const { photo = true, geo = IN_GEOFENCE, ts = true, bundleId } = opts;
  const evidence: Array<Record<string, unknown>> = [];
  if (photo) evidence.push({ kind: "photo", photoBase64: "iVBORw0KGgoAAAANSUhEUg==" });
  if (geo) evidence.push({ kind: "geolocation", geo: { ...geo, capturedAt: new Date().toISOString() } });
  if (ts) evidence.push({ kind: "timestamp", timestamp: new Date().toISOString() });
  return {
    method: "POST" as const,
    url: `/api/demo/jobs/${jobId}/evidence`,
    payload: { jobId, partyId, evidence, ...(bundleId ? { bundleId } : {}) },
  };
}

/** Drive an order all the way to `awaiting_user_confirmation`. */
async function toAwaitingConfirmation(app: FastifyInstance): Promise<StakingState> {
  const s = await toStaking(app);
  await stakeAll(app, s);
  const shop = await app.inject(bundle(s.jobId, SHOP));
  expect(shop.statusCode).toBe(201);
  expect(shop.json().orderStatus).toBe("awaiting_driver");
  const pickup = await app.inject(bundle(s.jobId, DRIVER));
  expect(pickup.json().phase).toBe("driver_pickup");
  const delivery = await app.inject(bundle(s.jobId, DRIVER));
  expect(delivery.json().phase).toBe("driver_delivered");
  expect(delivery.json().orderStatus).toBe("awaiting_user_confirmation");
  return s;
}

// ── 1. Happy path ────────────────────────────────────────────────────────────

describe("pizza-oracle — happy path", () => {
  it("pre-commit → all stake → escrow → dispatch → evidence → user confirms → settled", async () => {
    const app = makeApp();
    const s = await toStaking(app);

    // Three commitment templates (shop, driver, user), all pending.
    expect(s.commitments).toHaveLength(3);
    expect(s.commitments.map((c) => c.partyRole).sort()).toEqual(["driver", "shop", "user"]);

    await stakeAll(app, s);

    // Escrow locks on the 3rd stake; make-pizza dispatched.
    const com = await app.inject({ method: "GET", url: `/api/demo/jobs/${s.jobId}/commitments` });
    expect(com.json().allStaked).toBe(true);
    expect(_hasEvent("escrow_locked")).toBe(true);

    const ord = await app.inject({ method: "GET", url: `/api/demo/orders/${s.orderId}` });
    expect(ord.json().order.status).toBe("awaiting_shop");
    expect(ord.json().order.escrow.locked).toBe(true);
    expect(ord.json().order.escrow.totalLockedUSD).toBeGreaterThan(0);

    // Shop evidence → oracle verifies → delivery dispatched.
    const shop = await app.inject(bundle(s.jobId, SHOP));
    expect(shop.statusCode).toBe(201);
    expect(shop.json().phase).toBe("shop_complete");
    expect(shop.json().orderStatus).toBe("awaiting_driver");

    // Driver breadcrumb (no photo) just accumulates — no transition.
    const crumb = await app.inject(bundle(s.jobId, DRIVER, { photo: false }));
    expect(crumb.json().phase).toBe("breadcrumb");
    expect(crumb.json().orderStatus).toBe("awaiting_driver");

    // Driver pickup (photo) → in_transit; delivery (photo) → awaiting confirmation.
    const pickup = await app.inject(bundle(s.jobId, DRIVER));
    expect(pickup.json().phase).toBe("driver_pickup");
    expect(pickup.json().orderStatus).toBe("in_transit");

    const delivery = await app.inject(bundle(s.jobId, DRIVER));
    expect(delivery.json().phase).toBe("driver_delivered");
    expect(delivery.json().orderStatus).toBe("awaiting_user_confirmation");
    expect(_hasEvent("awaiting_confirmation")).toBe(true);

    // User confirms → settle.
    const confirm = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${s.orderId}/confirm-delivery`,
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().order.status).toBe("delivered");
    expect(confirm.json().settlement.reason).toBe("user_confirmed");
    expect(confirm.json().settlement.shopPayoutUSD).toBe(15);
    expect(confirm.json().settlement.driverPayoutUSD).toBe(5);
    expect(confirm.json().settlement.reputation.userDelta).toBe(5);
    expect(_hasEvent("delivery_confirmed")).toBe(true);

    // All commitments released.
    const com2 = await app.inject({ method: "GET", url: `/api/demo/jobs/${s.jobId}/commitments` });
    expect(com2.json().commitments.every((c: { status: string }) => c.status === "released")).toBe(true);
  });

  it("emits pre_commit_required to shop, driver and user when pre-commit starts", async () => {
    const app = makeApp();
    await toStaking(app);
    expect(_hasEvent("pre_commit_required")).toBe(true);
    // The store fans out to operator:<shop>, driver:<driver>, order:<id>.
  });
});

// ── 2/3. Stake-window timeouts ───────────────────────────────────────────────

describe("pizza-oracle — stake window", () => {
  it("shop fails to stake within window → order auto-cancels, escrow returns", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    // Driver + user stake; shop does not.
    expect((await stake(app, s.jobId, DRIVER, 5)).statusCode).toBe(200);
    expect((await stake(app, s.jobId, USER, 20)).statusCode).toBe(200);

    _expireStakeWindow(s.jobId);

    const ord = await app.inject({ method: "GET", url: `/api/demo/orders/${s.orderId}` });
    expect(ord.json().order.status).toBe("cancelled");
    expect(ord.json().order.escrow).toBeFalsy(); // escrow never locked
    expect(_hasEvent("stake_window_expired")).toBe(true);
    expect(_hasEvent("escrow_returned")).toBe(true);
  });

  it("driver fails to stake within window → order auto-cancels, escrow returns", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    expect((await stake(app, s.jobId, SHOP, 4)).statusCode).toBe(200);
    expect((await stake(app, s.jobId, USER, 20)).statusCode).toBe(200);

    _expireStakeWindow(s.jobId);

    const ord = await app.inject({ method: "GET", url: `/api/demo/orders/${s.orderId}` });
    expect(ord.json().order.status).toBe("cancelled");
    expect(_hasEvent("stake_window_expired")).toBe(true);
    expect(_hasEvent("escrow_returned")).toBe(true);
  });

  it("staking after the window has closed is rejected", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    _expireStakeWindow(s.jobId); // cancels the order
    const late = await stake(app, s.jobId, SHOP, 4);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("stake_window_closed");
  });
});

// ── 4/5. Evidence validation ─────────────────────────────────────────────────

describe("pizza-oracle — evidence validation", () => {
  it("rejects an evidence bundle missing the required photo → 400", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    await stakeAll(app, s);
    const res = await app.inject(bundle(s.jobId, SHOP, { photo: false }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_photo");
  });

  it("rejects an evidence bundle whose GPS is outside the geofence → 400", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    await stakeAll(app, s);
    const res = await app.inject(bundle(s.jobId, SHOP, { geo: { lat: 0, lng: 0 } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("geo_outside_geofence");
  });

  it("rejects evidence before escrow locks → 409", async () => {
    const app = makeApp();
    const s = await toStaking(app); // staking, escrow not locked
    const res = await app.inject(bundle(s.jobId, SHOP));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("escrow_not_locked");
  });
});

// ── 6. User-confirmation timeout ─────────────────────────────────────────────

describe("pizza-oracle — confirmation window", () => {
  it("user fails to confirm within window → penalty event emitted", async () => {
    const app = makeApp();
    const s = await toAwaitingConfirmation(app);

    _expireConfirmationWindow(s.orderId);

    expect(_hasEvent("user_confirmation_timeout")).toBe(true);
    const ord = await app.inject({ method: "GET", url: `/api/demo/orders/${s.orderId}` });
    expect(ord.json().order.userConfirmation).toBe("timed_out");
    expect(ord.json().order.userPenaltyApplied).toBe(true);
    expect(ord.json().order.settlement.reason).toBe("user_timeout");
    expect(ord.json().order.settlement.reputation.userDelta).toBe(-10);
  });

  it("confirming after the window has expired → 409", async () => {
    const app = makeApp();
    const s = await toAwaitingConfirmation(app);
    _expireConfirmationWindow(s.orderId);
    const res = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${s.orderId}/confirm-delivery`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("confirmation_window_expired");
  });

  it("confirming before delivery is done → 409 wrong_state", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    await stakeAll(app, s);
    const res = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${s.orderId}/confirm-delivery`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("wrong_state");
  });
});

// ── 7/8. Duplicates ──────────────────────────────────────────────────────────

describe("pizza-oracle — duplicates", () => {
  it("duplicate stake by the same party → 409", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    expect((await stake(app, s.jobId, SHOP, 4)).statusCode).toBe(200);
    const dup = await stake(app, s.jobId, SHOP, 4);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("already_staked");
  });

  it("duplicate evidence bundle (same bundleId) → 409", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    await stakeAll(app, s);
    const first = await app.inject(bundle(s.jobId, SHOP, { bundleId: "bundle_dup_1" }));
    expect(first.statusCode).toBe(201);
    const dup = await app.inject(bundle(s.jobId, SHOP, { bundleId: "bundle_dup_1" }));
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("duplicate_evidence");
  });
});

// ── Hash-commit-reveal (fraud detection) ─────────────────────────────────────

describe("pizza-oracle — reveal / fraud detection", () => {
  it("revealing the correct secret marks the commitment revealed (no fraud)", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    await stake(app, s.jobId, SHOP, 4, "shop-secret-xyz");
    const res = await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${s.jobId}/reveal`,
      payload: { partyId: SHOP, secret: "shop-secret-xyz" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fraud).toBe(false);
    expect(res.json().verdict).toBe("revealed");
  });

  it("revealing a wrong secret is detected as fraud → stake slashed", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    await stake(app, s.jobId, SHOP, 4, "the-real-secret");
    const res = await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${s.jobId}/reveal`,
      payload: { partyId: SHOP, secret: "a-different-secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fraud).toBe(true);
    expect(res.json().verdict).toBe("slashed");
    expect(_hasEvent("fraud_detected")).toBe(true);
  });

  it("revealing before staking → 409", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${s.jobId}/reveal`,
      payload: { partyId: SHOP, secret: "whatever" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_staked");
  });
});

// ── Pre-commit guards + listings ─────────────────────────────────────────────

describe("pizza-oracle — pre-commit guards & listings", () => {
  it("pre-commit requires a confirmed order (proposed → 409)", async () => {
    const app = makeApp();
    const order = _seedOrderForTests();
    const res = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${order.orderId}/pre-commit`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("wrong_state");
  });

  it("pre-commit is idempotent — re-calling returns the same job + commitments (200, no re-create)", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    const again = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${s.orderId}/pre-commit`,
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().jobId).toBe(s.jobId);
    expect(again.json().commitments).toHaveLength(3);
  });

  it("lists evidence bundles for a job", async () => {
    const app = makeApp();
    const s = await toStaking(app);
    await stakeAll(app, s);
    await app.inject(bundle(s.jobId, SHOP));
    const res = await app.inject({ method: "GET", url: `/api/demo/jobs/${s.jobId}/evidence` });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().bundles[0].partyId).toBe(SHOP);
    expect(res.json().bundles[0].bundleHash).toMatch(/^sha256:/);
  });

  it("returns 404 for stake/commitments on an unknown job", async () => {
    const app = makeApp();
    const stakeRes = await stake(app, "job_nope", SHOP, 4);
    expect(stakeRes.statusCode).toBe(404);
    const listRes = await app.inject({ method: "GET", url: `/api/demo/jobs/job_nope/commitments` });
    expect(listRes.statusCode).toBe(404);
  });
});
