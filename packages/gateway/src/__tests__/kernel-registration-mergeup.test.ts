import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@pcc/store";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getStore } from "../db.js";
import {
  ED_SIGNER, OWNER, registrationFixture, type RegistrationFixture,
} from "./helpers/kernel-registration-fixture.js";

const ownerBody = (id: string) => ({
  error: "FORBIDDEN",
  message: `Kernel '${id}' requires owner authority or its bound signing key`,
});
const EXPLICIT_REQUIRED = {
  error: "explicit_credential_required",
  message: "This decision needs an API key or a session key in the Authorization header; the sign-in cookie alone can't authorize it.",
};
const CARRIERS = ["cookie", "none", "key", "bearer-session"] as const;

describe("kernel registration merge-up", () => {
  let fixture: RegistrationFixture;
  beforeEach(async () => { fixture = await registrationFixture(); });
  afterEach(async () => { await fixture.close(); });

  const ownerHeaders = (carrier: typeof CARRIERS[number]) => ({
    ...fixture.provenHeaders,
    "x-test-proven-wallet-via": "siwe-session",
    "x-test-proven-wallet-carrier": carrier,
  });
  const challengeRow = (challengeId: string) => getStore().db.get(sql`
    SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challengeId}
  `);

  it("M-E1: a claimed-only node creates with consent, restarts with fresh consent, then refuses an unproven upsert", async () => {
    const id = "merge-node-flow";
    const initialProof = await fixture.proof(id);
    const created = await fixture.register(id, initialProof);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().kernel.signingKey).toEqual(ED_SIGNER);
    expect(fixture.row(id)?.operatorAddress).toBe(OWNER);

    const restartProof = await fixture.proof(id);
    expect(restartProof.registrationProof.challengeId).not.toBe(initialProof.registrationProof.challengeId);
    const restarted = await fixture.register(id, { ...restartProof, name: "Restarted node" });
    expect(restarted.statusCode, restarted.body).toBe(200);
    expect(restarted.json().kernel.signingKey).toEqual(ED_SIGNER);
    expect(fixture.row(id)?.name).toBe("Restarted node");

    const before = fixture.row(id);
    const denied = await fixture.register(id, { name: "Unproven restart" });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toEqual(ownerBody(id));
    expect(fixture.row(id)).toEqual(before);
  });

  it("M-E2: a non-wallet owner without a signer requires the admin for profile writes", async () => {
    const id = "merge-email-owner";
    const email = "ops@example.com";
    const key = provisionApiKey({ operatorId: email }).rawKey;
    const headers = fixture.headers(key);
    const created = await fixture.register(id, {}, headers);
    expect(created.statusCode, created.body).toBe(201);
    expect(fixture.row(id)).toMatchObject({
      operatorAddress: email, signingAddress: null, signingKeyAlgorithm: null, signingKeyPublicKey: null,
    });
    const before = fixture.row(id);
    for (const requestHeaders of [headers, {
      ...headers, "x-test-proven-wallet": OWNER, "x-test-proven-wallet-via": "self-link:agent",
    }]) {
      const denied = await fixture.register(id, { name: "Unapproved profile" }, requestHeaders);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json()).toEqual(ownerBody(id));
      expect(fixture.row(id)).toEqual(before);
    }
    const updated = await fixture.register(id, { name: "Admin profile" }, fixture.adminHeaders);
    expect(updated.statusCode, updated.body).toBe(200);
    expect(fixture.row(id)).toMatchObject({ name: "Admin profile", operatorAddress: email });
  });

  describe.each(CARRIERS)("M-E3: owner proof carried by %s", (carrier) => {
    const explicit = carrier === "key" || carrier === "bearer-session";

    it.each(["update", "create"] as const)("gates exact-location %s on an explicit credential", async (operation) => {
      const id = `merge-exact-${operation}`;
      if (operation === "update") {
        const created = await fixture.register(id);
        expect(created.statusCode, created.body).toBe(201);
      }
      const before = fixture.row(id);
      const response = await fixture.register(id, {
        name: "Exact profile", locationVisibility: "exact", location: { lat: 37.7, lng: -122.4 },
      }, ownerHeaders(carrier));
      expect(response.statusCode, response.body).toBe(explicit ? operation === "create" ? 201 : 200 : 403);
      if (explicit) {
        expect(fixture.row(id)).toMatchObject({
          operatorAddress: OWNER, name: "Exact profile", location: { lat: 37.7, lng: -122.4, visibility: "exact" },
        });
      } else {
        expect(response.json()).toEqual(EXPLICIT_REQUIRED);
        expect(fixture.row(id)).toEqual(before);
        if (operation === "create") expect(fixture.row(id)).toBeUndefined();
      }
    });

    it.each(["bind", "create"] as const)("gates signer %s before consuming fresh consent", async (operation) => {
      const id = `merge-signer-${operation}`;
      if (operation === "bind") {
        const created = await fixture.register(id);
        expect(created.statusCode, created.body).toBe(201);
        expect(fixture.row(id)?.signingKeyPublicKey).toBeNull();
      }
      const before = fixture.row(id);
      const proof = await fixture.proof(id);
      expect(challengeRow(proof.registrationProof.challengeId)).toEqual({ consumed_at: null });
      const response = await fixture.register(id, { ...proof, name: "Signing profile" }, ownerHeaders(carrier));
      expect(response.statusCode, response.body).toBe(explicit ? operation === "create" ? 201 : 200 : 403);
      if (explicit) {
        expect(response.json().kernel.signingKey).toEqual(ED_SIGNER);
        expect(fixture.row(id)).toMatchObject({ operatorAddress: OWNER, signingKeyPublicKey: ED_SIGNER.publicKey });
        expect(challengeRow(proof.registrationProof.challengeId)).toEqual({ consumed_at: expect.any(String) });
      } else {
        expect(response.json()).toEqual(EXPLICIT_REQUIRED);
        expect(fixture.row(id)).toEqual(before);
        if (operation === "bind") expect(fixture.row(id)?.signingKeyPublicKey).toBeNull();
        else expect(fixture.row(id)).toBeUndefined();
        expect(challengeRow(proof.registrationProof.challengeId)).toEqual({ consumed_at: null });
      }
    });
  });

  it("M-E3: a cookie proof can change the name without changing visibility", async () => {
    const id = "merge-cookie-name";
    expect((await fixture.register(id)).statusCode).toBe(201);
    const before = fixture.row(id);
    const response = await fixture.register(id, { name: "Cookie profile" }, ownerHeaders("cookie"));
    expect(response.statusCode, response.body).toBe(200);
    expect(fixture.row(id)?.name).toBe("Cookie profile");
    expect(fixture.row(id)?.location).toEqual(before?.location);
  });

  it("M-E3: a cookie proof can make an exact location approximate", async () => {
    const id = "merge-cookie-approximate";
    expect((await fixture.register(id, { locationVisibility: "exact" }, ownerHeaders("key"))).statusCode).toBe(201);
    expect(fixture.row(id)?.location).toMatchObject({ visibility: "exact" });
    const response = await fixture.register(id, { locationVisibility: "approximate" }, ownerHeaders("cookie"));
    expect(response.statusCode, response.body).toBe(200);
    expect(fixture.row(id)?.location).toEqual({ lat: 0, lng: 0 });
  });

  it("M-E3: cookie signer consent from another principal gets the explicit-credential refusal before verification", async () => {
    const id = "merge-cookie-other-principal";
    expect((await fixture.register(id)).statusCode).toBe(201);
    const before = fixture.row(id);
    const proof = await fixture.proof(id, ED_SIGNER, fixture.otherKey);
    const response = await fixture.register(id, proof, ownerHeaders("cookie"));
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual(EXPLICIT_REQUIRED);
    expect(fixture.row(id)).toEqual(before);
    expect(fixture.row(id)?.signingKeyPublicKey).toBeNull();
    expect(challengeRow(proof.registrationProof.challengeId)).toEqual({ consumed_at: null });
  });
});
