import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CapabilityNode, CapabilityRequest } from "@pcc/spec";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getRepos } from "../db.js";
import { __resetRateLimitState } from "../middleware/rate-limiter.js";
import { getJobOffersStore } from "../services/job-offers-store.js";
import { namesAdminOnlyRequestField, publicRequest, servedRequest } from "../services/request-public.js";

const adminSecret = `n356-${randomUUID()}`;
const W = "0x" + "ab".repeat(20);
const R = "0x" + "cd".repeat(20);

type Caller = { name: string; headers: Record<string, string>; admin: boolean };

function expectNoRequesterFields(request: unknown, body: string): void {
  expect(request).not.toHaveProperty("requesterEmail");
  expect(request).not.toHaveProperty("requesterWallet");
  expect(body.toLowerCase()).not.toContain("buyer@example.com");
  expect(body.toLowerCase()).not.toContain("cd".repeat(20));
}

function expectBothRequesterFields(request: unknown): void {
  expect(request).toHaveProperty("requesterEmail", "buyer@example.com");
  expect(request).toHaveProperty("requesterWallet", R);
}

function snapshot(id: string) {
  const row = getRepos().requests.findById(id);
  expect(row).toBeDefined();
  return JSON.parse(JSON.stringify(row));
}

describe("request replies and requester writes for the admin", () => {
  let app: FastifyInstance;
  let previousDbPath: string | undefined;
  let previousAdminKey: string | undefined;
  let plainHeaders: Record<string, string>;
  let callers: Caller[];

  beforeAll(async () => {
    previousDbPath = process.env.PCC_DB_PATH;
    previousAdminKey = process.env.PCC_ADMIN_KEY;
    process.env.PCC_DB_PATH = ":memory:";
    process.env.PCC_ADMIN_KEY = adminSecret;
    const { createGateway } = await import("../server.js");
    ({ app } = await createGateway(0));
    await app.ready();

    const plainKey = provisionApiKey({ operatorId: "member@example.com", scopes: ["*"] });
    const sessionKey = provisionApiKey({ operatorId: W, scopes: ["*"], metadata: { source: "siwe-session" } });
    const adminKey = provisionApiKey({ operatorId: "admin-n356", scopes: ["admin"] });
    const adminStarKey = provisionApiKey({ operatorId: "admin-star-n356", scopes: ["admin", "*"] });
    const cookieSession = createSession("0x" + "11".repeat(20));
    const bearerSession = createSession("0x" + "22".repeat(20));
    plainHeaders = { authorization: `Bearer ${plainKey.rawKey}` };
    callers = [
      { name: "plain", headers: plainHeaders, admin: false },
      { name: "siwe", headers: { authorization: `Bearer ${sessionKey.rawKey}` }, admin: false },
      { name: "admin key", headers: { authorization: `Bearer ${adminKey.rawKey}` }, admin: true },
      { name: "admin header", headers: { ...plainHeaders, "x-admin-key": adminSecret }, admin: true },
      { name: "wrong admin header", headers: { ...plainHeaders, "x-admin-key": `wrong-admin-${randomUUID()}` }, admin: false },
      { name: "cookie session", headers: { cookie: `pcc_session=${app.signCookie(cookieSession)}` }, admin: false },
      { name: "bearer session", headers: { authorization: `Bearer ${bearerSession}` }, admin: false },
      { name: "admin and every scope", headers: { authorization: `Bearer ${adminStarKey.rawKey}` }, admin: false },
      { name: "admin key, wrong header", headers: { authorization: `Bearer ${adminKey.rawKey}`, "x-admin-key": `wrong-admin-${randomUUID()}` }, admin: false },
      { name: "admin key, empty header", headers: { authorization: `Bearer ${adminKey.rawKey}`, "x-admin-key": "" }, admin: false },
    ];
  }, 120_000);

  beforeEach(() => { __resetRateLimitState(); });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (previousDbPath === undefined) delete process.env.PCC_DB_PATH;
      else process.env.PCC_DB_PATH = previousDbPath;
      if (previousAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
      else process.env.PCC_ADMIN_KEY = previousAdminKey;
    }
  });

  function createSession(walletAddress: string): string {
    const token = randomUUID();
    const now = Date.now();
    getRepos().sessions.insert({
      id: token,
      token,
      walletAddress,
      createdAt: new Date(now).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
    });
    return token;
  }

  async function createRequest(
    requesterFields: Pick<CapabilityRequest, "requesterEmail" | "requesterWallet"> = {
      requesterEmail: "buyer@example.com",
      requesterWallet: R,
    },
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: plainHeaders,
      payload: {
        title: "N356 desk robot",
        description: "Build a small desk robot with a servo head and an arm wave.",
        budget: 500,
        currency: "USDC",
        deadline: "2026-12-31T23:59:59Z",
        urgency: "standard",
        ...requesterFields,
      },
    });
    expect(response.statusCode).toBe(201);
    const request = response.json<{ request: CapabilityRequest }>().request;
    expect(request.capabilityDag.length).toBeGreaterThan(0);
    return { id: request.id, request, response };
  }

  it("N356 U1: public replies omit both requester fields in a new object and preserve the input", () => {
    const request: CapabilityRequest = {
      id: "req-n356-unit",
      title: "N356 desk robot",
      description: "Build a small desk robot with a servo head and an arm wave.",
      requesterEmail: "buyer@example.com",
      requesterWallet: R,
      budget: 500,
      currency: "USDC",
      deadline: "2026-12-31T23:59:59Z",
      urgency: "standard",
      status: "decomposed",
      capabilityDag: [],
      totalEstimatedCost: 0,
      totalEstimatedHours: 0,
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    };
    const before = structuredClone(request);
    const result = publicRequest(request);
    const expected = {
      id: "req-n356-unit",
      title: "N356 desk robot",
      description: "Build a small desk robot with a servo head and an arm wave.",
      budget: 500,
      currency: "USDC",
      deadline: "2026-12-31T23:59:59Z",
      urgency: "standard",
      status: "decomposed",
      capabilityDag: [],
      totalEstimatedCost: 0,
      totalEstimatedHours: 0,
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    };
    expect(result).toEqual(expected);
    expect(result).not.toBe(request);
    expect(result).not.toHaveProperty("requesterEmail");
    expect(result).not.toHaveProperty("requesterWallet");
    expect(request).toEqual(before);

    const plain = { headers: {}, raw: { rawHeaders: [] } } as unknown as FastifyRequest;
    const admin = {
      headers: { "x-admin-key": adminSecret },
      raw: { rawHeaders: ["x-admin-key", adminSecret] },
    } as unknown as FastifyRequest;
    expect(servedRequest(plain, request)).toEqual(expected);
    expect(servedRequest(admin, request)).toBe(request);
    expect(request).toEqual(before);
  });

  it("N356 U2: a PUT names an admin requester field by its own key whatever its value", () => {
    for (const body of [
      { requesterEmail: "x@example.com" },
      { requesterWallet: R },
      { requesterEmail: null },
      { requesterWallet: undefined },
      { title: "t", requesterEmail: "" },
    ]) expect(namesAdminOnlyRequestField(body)).toBe(true);
    for (const body of [
      {}, { title: "t" }, null, undefined, "requesterEmail", 42, [],
      Object.create({ requesterEmail: "x" }),
    ]) expect(namesAdminOnlyRequestField(body)).toBe(false);
  });

  it("N356 G1: listed replies carry both requester fields only for each admin caller", async () => {
    const { id } = await createRequest();
    for (const caller of callers) {
      const response = await app.inject({ method: "GET", url: "/api/requests", headers: caller.headers });
      expect(response.statusCode, caller.name).toBe(200);
      const { requests, count } = response.json<{ requests: CapabilityRequest[]; count: number }>();
      expect(count).toBe(requests.length);
      const request = requests.find((entry) => entry.id === id);
      expect(request, caller.name).toBeDefined();
      if (caller.admin) expectBothRequesterFields(request);
      else for (const entry of requests) expectNoRequesterFields(entry, response.body);
    }
  });

  it("N356 G2: a request detail reply carries both requester fields only for each admin caller", async () => {
    const { id } = await createRequest();
    for (const caller of callers) {
      const response = await app.inject({ method: "GET", url: `/api/requests/${id}`, headers: caller.headers });
      expect(response.statusCode, caller.name).toBe(200);
      const { request } = response.json();
      expect(request.id).toBe(id);
      if (caller.admin) expectBothRequesterFields(request);
      else expectNoRequesterFields(request, response.body);
    }
  });

  it("N356 G3: a decompose reply carries both requester fields only for each admin caller", async () => {
    const { id } = await createRequest();
    for (const caller of callers) {
      const response = await app.inject({ method: "POST", url: `/api/requests/${id}/decompose`, headers: caller.headers });
      expect(response.statusCode, caller.name).toBe(200);
      const { request } = response.json();
      expect(request.id).toBe(id);
      if (caller.admin) expectBothRequesterFields(request);
      else expectNoRequesterFields(request, response.body);
    }
  });

  it("N356 G4: a publish reply carries both requester fields only for each admin caller", async () => {
    const { id } = await createRequest();
    for (const caller of callers) {
      const response = await app.inject({ method: "POST", url: `/api/requests/${id}/publish`, headers: caller.headers });
      expect(response.statusCode, caller.name).toBe(200);
      const { request } = response.json();
      expect(request.id).toBe(id);
      if (caller.admin) expectBothRequesterFields(request);
      else expectNoRequesterFields(request, response.body);
    }
  });

  it("N356 G5: a PUT reply carries both requester fields only for each admin caller", async () => {
    const { id } = await createRequest();
    for (const caller of callers) {
      const title = `N356 renamed by ${caller.name}`;
      const response = await app.inject({ method: "PUT", url: `/api/requests/${id}`, headers: caller.headers, payload: { title } });
      expect(response.statusCode, caller.name).toBe(200);
      const { request } = response.json();
      expect(request.title).toBe(title);
      if (caller.admin) expectBothRequesterFields(request);
      else expectNoRequesterFields(request, response.body);
    }
  });

  it("N356 G6: a request holding one requester field serves it only to the admin", async () => {
    const adminKeyCaller = callers.find((caller) => caller.name === "admin key")!;
    for (const requesterFields of [
      { requesterEmail: "buyer@example.com", requesterWallet: R },
      { requesterWallet: R },
      { requesterEmail: "buyer@example.com" },
    ]) {
      const { id } = await createRequest(requesterFields);
      for (const caller of callers.filter((entry) => !entry.admin)) {
        const list = await app.inject({ method: "GET", url: "/api/requests", headers: caller.headers });
        expect(list.statusCode, caller.name).toBe(200);
        for (const request of list.json().requests) expectNoRequesterFields(request, list.body);
        const detail = await app.inject({ method: "GET", url: `/api/requests/${id}`, headers: caller.headers });
        expect(detail.statusCode, caller.name).toBe(200);
        expectNoRequesterFields(detail.json().request, detail.body);
      }
      const detail = await app.inject({ method: "GET", url: `/api/requests/${id}`, headers: adminKeyCaller.headers });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().request).toMatchObject(requesterFields);
    }
  });

  it("N356 F1: only each admin caller may filter requests by requesterEmail, before any stored read", async () => {
    const { id } = await createRequest();
    for (const caller of callers.filter((entry) => entry.admin)) {
      const response = await app.inject({ method: "GET", url: "/api/requests?requesterEmail=buyer%40example.com", headers: caller.headers });
      expect(response.statusCode, caller.name).toBe(200);
      const { requests } = response.json<{ requests: CapabilityRequest[] }>();
      const created = requests.find((entry) => entry.id === id);
      expect(created).toBeDefined();
      expectBothRequesterFields(created);
      for (const request of requests) expect(request.requesterEmail).toBe("buyer@example.com");
    }
    const findAll = vi.spyOn(getRepos().requests, "findAll");
    try {
      for (const caller of callers.filter((entry) => !entry.admin)) {
        for (const query of ["?requesterEmail=buyer%40example.com", "?requesterEmail=", "?requesterEmail=nobody%40example.com", "?requesterEmail=buyer%40example.com&requesterEmail=nobody%40example.com"]) {
          const response = await app.inject({ method: "GET", url: `/api/requests${query}`, headers: caller.headers });
          expect(response.statusCode, `${caller.name} ${query}`).toBe(403);
          expect(response.body).toBe('{"error":"forbidden","reason":"requester_filter_admin_only"}');
          expect(findAll).not.toHaveBeenCalled();
        }
      }
    } finally {
      findAll.mockRestore();
    }
    const response = await app.inject({ method: "GET", url: "/api/requests", headers: plainHeaders });
    expect(response.statusCode).toBe(200);
  });

  it("N356 C1: the creator reply carries both requester fields as sent by the plain caller", async () => {
    const { response, request } = await createRequest();
    expect(response.statusCode).toBe(201);
    expectBothRequesterFields(request);
  });

  it("N356 S1: public list and detail replies omit requester fields while stored fields stay available to admin", async () => {
    const { id } = await createRequest();
    const before = snapshot(id);
    for (const caller of callers.filter((entry) => !entry.admin)) {
      const list = await app.inject({ method: "GET", url: "/api/requests", headers: caller.headers });
      expect(list.statusCode).toBe(200);
      for (const request of list.json().requests) expectNoRequesterFields(request, list.body);
      const detail = await app.inject({ method: "GET", url: `/api/requests/${id}`, headers: caller.headers });
      expect(detail.statusCode).toBe(200);
      expectNoRequesterFields(detail.json().request, detail.body);
      expect(snapshot(id)).toEqual(before);
    }
    const adminKeyCaller = callers.find((caller) => caller.name === "admin key")!;
    const detail = await app.inject({ method: "GET", url: `/api/requests/${id}`, headers: adminKeyCaller.headers });
    expect(detail.statusCode).toBe(200);
    expectBothRequesterFields(detail.json().request);
    expect(snapshot(id)).toEqual(before);
  });

  it("N356 I1: a caller whose claimed identity equals the requester's is not the admin", async () => {
    const { id } = await createRequest();
    const before = snapshot(id);
    const requesterKey = provisionApiKey({ operatorId: "buyer@example.com", scopes: ["*"] });
    const identityCallers: Caller[] = [
      { name: "requester email key", headers: { authorization: `Bearer ${requesterKey.rawKey}` }, admin: false },
      { name: "requester wallet session", headers: { cookie: `pcc_session=${app.signCookie(createSession(R))}` }, admin: false },
    ];
    for (const caller of identityCallers) {
      const list = await app.inject({ method: "GET", url: "/api/requests", headers: caller.headers });
      expect(list.statusCode, caller.name).toBe(200);
      for (const request of list.json().requests) expectNoRequesterFields(request, list.body);
      const detail = await app.inject({ method: "GET", url: `/api/requests/${id}`, headers: caller.headers });
      expect(detail.statusCode, caller.name).toBe(200);
      expectNoRequesterFields(detail.json().request, detail.body);

      const findAll = vi.spyOn(getRepos().requests, "findAll");
      try {
        const filtered = await app.inject({ method: "GET", url: "/api/requests?requesterEmail=buyer%40example.com", headers: caller.headers });
        expect(filtered.statusCode, caller.name).toBe(403);
        expect(filtered.body).toBe('{"error":"forbidden","reason":"requester_filter_admin_only"}');
        expect(findAll).not.toHaveBeenCalled();
      } finally {
        findAll.mockRestore();
      }

      const response = await app.inject({
        method: "PUT",
        url: `/api/requests/${id}`,
        headers: caller.headers,
        payload: { requesterWallet: "0x" + "ef".repeat(20) },
      });
      expect(response.statusCode, caller.name).toBe(403);
      expect(response.body).toBe('{"error":"forbidden","reason":"requester_fields_admin_only"}');
      expect(snapshot(id)).toEqual(before);
    }
  });

  it("N356 P1: a nonadmin PUT may not name either requester field, including null, and writes nothing", async () => {
    const { id } = await createRequest();
    const before = snapshot(id);
    const bodies = [
      { requesterEmail: "new@example.com" },
      { requesterWallet: "0x" + "ef".repeat(20) },
      { requesterEmail: null },
      { requesterWallet: null },
      { title: "N356 not applied", requesterEmail: "new@example.com" },
    ];
    for (const caller of callers.filter((entry) => !entry.admin)) {
      for (const payload of bodies) {
        const response = await app.inject({ method: "PUT", url: `/api/requests/${id}`, headers: caller.headers, payload });
        expect(response.statusCode, caller.name).toBe(403);
        expect(response.body).toBe('{"error":"forbidden","reason":"requester_fields_admin_only"}');
        expect(snapshot(id)).toEqual(before);
      }
    }
  });

  it("N356 P2: a nonadmin PUT body that names only other request fields passes the requester-field freeze", async () => {
    const { id } = await createRequest();
    for (const caller of callers.filter((entry) => !entry.admin)) {
      const title = `N356 title by ${caller.name}`;
      const response = await app.inject({ method: "PUT", url: `/api/requests/${id}`, headers: caller.headers, payload: { title } });
      expect(response.statusCode, caller.name).toBe(200);
      expect(getRepos().requests.findById(id)?.title).toBe(title);
    }
  });

  it("N356 P3: each admin caller may set both requester fields in a PUT body", async () => {
    const { id } = await createRequest();
    const updates = [
      { name: "admin key", requesterEmail: "admin-key-new@example.com", requesterWallet: "0x" + "ef".repeat(20) },
      { name: "admin header", requesterEmail: "admin-header-new@example.com", requesterWallet: "0x" + "12".repeat(20) },
    ];
    for (const update of updates) {
      const caller = callers.find((entry) => entry.name === update.name)!;
      const payload = { requesterEmail: update.requesterEmail, requesterWallet: update.requesterWallet };
      const response = await app.inject({ method: "PUT", url: `/api/requests/${id}`, headers: caller.headers, payload });
      expect(response.statusCode, caller.name).toBe(200);
      expect(response.json().request).toMatchObject(payload);
      expect(getRepos().requests.findById(id)).toMatchObject(payload);
    }
  });

  it("N356 P4: a forbidden PUT naming requesterEmail is refused before any stored read or write", async () => {
    const { id } = await createRequest();
    const findById = vi.spyOn(getRepos().requests, "findById");
    const update = vi.spyOn(getRepos().requests, "update");
    try {
      for (const target of [id, "req-n356-unknown"]) {
        const response = await app.inject({
          method: "PUT",
          url: `/api/requests/${target}`,
          headers: plainHeaders,
          payload: { requesterEmail: "new@example.com" },
        });
        expect(response.statusCode).toBe(403);
        expect(response.body).toBe('{"error":"forbidden","reason":"requester_fields_admin_only"}');
        expect(findById).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      }
    } finally {
      findById.mockRestore();
      update.mockRestore();
    }
  });

  it("N356 B1: a public publish reply omits requester fields while produced offers keep the requester", async () => {
    const { id } = await createRequest();
    const node: CapabilityNode = {
      id: "node-matched",
      requestId: id,
      name: "CNC finishing 6061",
      description: "CNC finish a 6061 aluminium bracket",
      capabilityType: "cnc-3axis",
      category: "fabrication",
      estimatedCost: 60,
      estimatedHours: 2,
      dependencies: [],
      parallel: false,
      status: "pending",
      materials: [],
      evidenceRequirements: ["photo_of_completed_work"],
      matchStatus: "matched",
      matchedCapabilityId: "cap-kernel_mtaon2df_ry6r-cnc-3axis",
      matchedKernelId: "kernel_mtaon2df_ry6r",
    };
    getRepos().requests.update(id, { capabilityDag: [node], status: "decomposed" });
    const response = await app.inject({ method: "POST", url: `/api/requests/${id}/publish`, headers: plainHeaders });
    expect(response.statusCode).toBe(200);
    const { request, jobOffers } = response.json();
    expectNoRequesterFields(request, response.body);
    expect(jobOffers.created).toHaveLength(1);
    expect(getJobOffersStore().get(jobOffers.created[0].offerId)?.posterDid).toBe("buyer@example.com");
  });
});
