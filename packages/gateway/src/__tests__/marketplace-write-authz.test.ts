/**
 * WP-C (coord-watch #2608, refvertical #2586): the supplies-marketplace WRITES
 * need a PRESENT actor. apiGate's "/api/marketplace/" public prefix is not
 * method-aware, so these handlers must refuse on their own.
 *
 *   POST   /api/marketplace/listings      -> 401 without an actor; seller = actor
 *   PUT    /api/marketplace/listings/:id  -> 401 without an actor; seller only
 *   DELETE /api/marketplace/listings/:id  -> 401 without an actor; seller only
 *   POST   /api/marketplace/orders        -> 401 without an actor; buyer = actor
 *   audit actor = the authenticated principal, never the body's sellerId/buyerId
 *
 * Driven over HTTP through the REAL apiGate and real API keys, importing only
 * modules that exist on the pre-change code, so it runs unchanged there to
 * prove polarity (every [neg] case fails on the base).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { marketplaceRoutes } from "../routes/marketplace.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { auditService } from "../services/audit-service.js";
import { closeStore, initStore } from "../db.js";

let app: FastifyInstance;
let sellerKey: string;
let otherKey: string;
const SELLER = "mkt-seller-operator";
const OTHER = "mkt-other-operator";
const VICTIM = "mkt-victim-seller";

const asSeller = () => ({ authorization: `Bearer ${sellerKey}` });
const asOther = () => ({ authorization: `Bearer ${otherKey}` });

let seq = 0;
const uname = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

function listingBody(extra: Record<string, unknown> = {}) {
  return { name: uname("Resin"), category: "materials", pricePerUnit: 12, unit: "kg", ...extra };
}

async function listings(): Promise<Array<{ id: string; name: string; sellerId: string; pricePerUnit: number; createdAt: string }>> {
  const res = await app.inject({ method: "GET", url: "/api/marketplace/listings" });
  expect(res.statusCode).toBe(200);
  return res.json().listings;
}

async function sellerListing(): Promise<{ id: string; name: string; createdAt: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/marketplace/listings",
    headers: asSeller(),
    payload: listingBody(),
  });
  expect(res.statusCode).toBe(201);
  return res.json().listing;
}

async function ordersFor(listingId: string): Promise<Array<{ buyerId: string }>> {
  const res = await app.inject({ method: "GET", url: "/api/marketplace/orders" });
  return (res.json().orders as Array<{ listingId: string; buyerId: string }>).filter((o) => o.listingId === listingId);
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  sellerKey = provisionApiKey({ operatorId: SELLER, scopes: ["operator"] }).rawKey;
  otherKey = provisionApiKey({ operatorId: OTHER, scopes: ["operator"] }).rawKey;
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(marketplaceRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

describe("POST /api/marketplace/listings", () => {
  it("[neg] no actor -> 401: nothing listed, and nothing audited AS the named seller", async () => {
    const body = listingBody({ sellerId: VICTIM });
    const res = await app.inject({ method: "POST", url: "/api/marketplace/listings", payload: body });
    expect(res.statusCode).toBe(401);
    expect((await listings()).some((l) => l.name === body.name)).toBe(false);
    expect(auditService.query({ eventType: "marketplace.listing_created", actor: VICTIM })).toEqual([]);
  });

  it("[neg] the seller is the authenticated actor: a body sellerId naming someone else -> 403, nothing listed", async () => {
    const body = listingBody({ sellerId: VICTIM });
    const res = await app.inject({ method: "POST", url: "/api/marketplace/listings", headers: asOther(), payload: body });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("seller_mismatch");
    expect((await listings()).some((l) => l.name === body.name)).toBe(false);
  });

  it("[neg] an authenticated listing is recorded and audited as its actor, never a body/default seller", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/marketplace/listings",
      headers: asSeller(),
      payload: listingBody(),
    });
    expect(res.statusCode).toBe(201);
    const listing = res.json().listing;
    expect(listing.sellerId).toBe(SELLER);
    const audited = auditService
      .query({ eventType: "marketplace.listing_created" })
      .filter((e) => e.resourceId === listing.id);
    expect(audited.map((e) => e.actor)).toEqual([SELLER]);
  });

  it("a body sellerId equal to the actor is accepted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/marketplace/listings",
      headers: asSeller(),
      payload: listingBody({ sellerId: SELLER }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().listing.sellerId).toBe(SELLER);
  });
});

describe("PUT / DELETE /api/marketplace/listings/:id", () => {
  it("[neg] no actor -> 401 for PUT and DELETE; the listing is unchanged and still listed", async () => {
    const listing = await sellerListing();
    const put = await app.inject({
      method: "PUT",
      url: `/api/marketplace/listings/${listing.id}`,
      payload: { pricePerUnit: 0.01 },
    });
    expect(put.statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: `/api/marketplace/listings/${listing.id}` });
    expect(del.statusCode).toBe(401);
    const now = (await listings()).find((l) => l.id === listing.id);
    expect(now?.pricePerUnit).toBe(12);
  });

  it("[neg] a NON-seller cannot PUT or DELETE: 403, unchanged and still listed", async () => {
    const listing = await sellerListing();
    const put = await app.inject({
      method: "PUT",
      url: `/api/marketplace/listings/${listing.id}`,
      headers: asOther(),
      payload: { pricePerUnit: 0.01, sellerId: OTHER },
    });
    expect(put.statusCode).toBe(403);
    expect(put.json().error).toBe("not_listing_seller");
    const del = await app.inject({ method: "DELETE", url: `/api/marketplace/listings/${listing.id}`, headers: asOther() });
    expect(del.statusCode).toBe(403);
    const now = (await listings()).find((l) => l.id === listing.id);
    expect(now?.pricePerUnit).toBe(12);
    expect(now?.sellerId).toBe(SELLER);
  });

  it("[neg] the seller cannot reassign the listing to another seller: 403, seller unchanged", async () => {
    const listing = await sellerListing();
    const put = await app.inject({
      method: "PUT",
      url: `/api/marketplace/listings/${listing.id}`,
      headers: asSeller(),
      payload: { sellerId: OTHER },
    });
    expect(put.statusCode).toBe(403);
    expect(put.json().error).toBe("seller_mismatch");
    expect((await listings()).find((l) => l.id === listing.id)?.sellerId).toBe(SELLER);
  });

  it("the seller can update (createdAt is kept) and then delete its own listing", async () => {
    const listing = await sellerListing();
    const put = await app.inject({
      method: "PUT",
      url: `/api/marketplace/listings/${listing.id}`,
      headers: asSeller(),
      payload: { pricePerUnit: 15, createdAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().listing.pricePerUnit).toBe(15);
    expect(put.json().listing.createdAt).toBe(listing.createdAt);
    const del = await app.inject({ method: "DELETE", url: `/api/marketplace/listings/${listing.id}`, headers: asSeller() });
    expect(del.statusCode).toBe(200);
    expect((await listings()).some((l) => l.id === listing.id)).toBe(false);
  });

  it("a seeded listing whose seller no key holds cannot be changed by an authenticated stranger", async () => {
    const seeded = (await listings()).find((l) => l.sellerId.startsWith("supplier-"));
    expect(seeded).toBeTruthy();
    const put = await app.inject({
      method: "PUT",
      url: `/api/marketplace/listings/${seeded!.id}`,
      headers: asOther(),
      payload: { pricePerUnit: 0.01 },
    });
    expect(put.statusCode).toBe(403);
  });
});

describe("POST /api/marketplace/orders", () => {
  it("[neg] no actor -> 401: no order, nothing audited AS the named buyer", async () => {
    const listing = await sellerListing();
    const res = await app.inject({
      method: "POST",
      url: "/api/marketplace/orders",
      payload: { listingId: listing.id, quantity: 2, buyerId: VICTIM },
    });
    expect(res.statusCode).toBe(401);
    expect(await ordersFor(listing.id)).toEqual([]);
    expect(auditService.query({ eventType: "marketplace.order_placed", actor: VICTIM })).toEqual([]);
  });

  it("[neg] the buyer is the authenticated actor: a body buyerId naming someone else -> 403, no order", async () => {
    const listing = await sellerListing();
    const res = await app.inject({
      method: "POST",
      url: "/api/marketplace/orders",
      headers: asOther(),
      payload: { listingId: listing.id, quantity: 2, buyerId: VICTIM },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("buyer_mismatch");
    expect(await ordersFor(listing.id)).toEqual([]);
  });

  it("[neg] an authenticated order's buyer and audit actor are the actor, never a body/default buyer", async () => {
    const listing = await sellerListing();
    const res = await app.inject({
      method: "POST",
      url: "/api/marketplace/orders",
      headers: asOther(),
      payload: { listingId: listing.id, quantity: 3 },
    });
    expect(res.statusCode).toBe(201);
    const order = res.json().order;
    expect(order.buyerId).toBe(OTHER);
    expect(order.sellerId).toBe(SELLER);
    const audited = auditService
      .query({ eventType: "marketplace.order_placed" })
      .filter((e) => e.resourceId === order.id);
    expect(audited.map((e) => e.actor)).toEqual([OTHER]);
  });
});
