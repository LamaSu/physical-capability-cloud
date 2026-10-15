import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@pcc/store";
import { getRepos, getStore } from "../db.js";
import {
  ED_A, ED_B, ED_SIGNER, EVM_SIGNER, OWNER, legacyEdProof, registrationFixture, signEd, signerFields,
  type RegistrationFixture,
} from "./helpers/kernel-registration-fixture.js";

describe("kernel upsert owner authority", () => {
  let fixture: RegistrationFixture;
  beforeEach(async () => { fixture = await registrationFixture(); });
  afterEach(async () => { vi.restoreAllMocks(); await fixture.close(); });

  it("keeps the authenticated actor as owner when a new request names another operator", async () => {
    const response = await fixture.register("new-owner", { operatorAddress: "0x2222222222222222222222222222222222222222" });
    expect(response.statusCode).toBe(201);
    expect(fixture.row("new-owner")?.operatorAddress).toBe(OWNER);
  });

  it("refuses a profile change from a key that only claims the recorded owner", async () => {
    expect((await fixture.register("owned-profile")).statusCode).toBe(201);
    const before = fixture.row("owned-profile");
    const response = await fixture.register("owned-profile", { name: "Changed profile", maxAssuranceTier: 3 }, fixture.headers(fixture.sameClaimKey));
    expect(response.statusCode).toBe(403);
    expect(fixture.row("owned-profile")).toEqual(before);
  });

  it("refuses the creating key's later profile change without owner or signer proof", async () => {
    expect((await fixture.register("creating-key")).statusCode).toBe(201);
    const before = fixture.row("creating-key");
    expect((await fixture.register("creating-key", { name: "Changed profile" })).statusCode).toBe(403);
    expect(fixture.row("creating-key")).toEqual(before);
  });

  it("refuses a first signer bind from a key that only claims the recorded owner", async () => {
    expect((await fixture.register("owned-no-signer")).statusCode).toBe(201);
    const before = fixture.row("owned-no-signer");
    const proof = await fixture.proof("owned-no-signer", ED_SIGNER, fixture.sameClaimKey);
    const response = await fixture.register("owned-no-signer", { ...proof, name: "Changed while binding" }, fixture.headers(fixture.sameClaimKey));
    expect(response.statusCode).toBe(403);
    expect(fixture.row("owned-no-signer")).toEqual(before);
  });

  it("leaves a first-bind challenge available when owner authority is refused", async () => {
    expect((await fixture.register("denied-bind-challenge")).statusCode).toBe(201);
    const proof = await fixture.proof("denied-bind-challenge", ED_SIGNER, fixture.sameClaimKey);
    const denied = await fixture.register("denied-bind-challenge", proof, fixture.headers(fixture.sameClaimKey));
    expect(denied.statusCode).toBe(403);
    const challenge = getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`) as { consumed_at: string | null };
    expect(challenge.consumed_at).toBeNull();
    const accepted = await fixture.register("denied-bind-challenge", proof, fixture.adminHeaders);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().kernel.signingKey).toEqual(ED_SIGNER);
  });

  it.each(["update", "bindSignerIfUnregistered"] as const)("rolls back challenge consumption and profile changes if %s fails", async (operation) => {
    expect((await fixture.register("atomic-bind")).statusCode).toBe(201);
    const proof = await fixture.proof("atomic-bind");
    const before = fixture.row("atomic-bind");
    const failure = vi.spyOn(getRepos().kernels, operation).mockImplementationOnce(() => { throw new Error("Injected kernel write failure"); });
    const denied = await fixture.register("atomic-bind", { ...proof, name: "Transactional profile" }, fixture.adminHeaders);
    failure.mockRestore();
    expect(denied.statusCode).toBe(500);
    expect(fixture.row("atomic-bind")).toEqual(before);
    const challenge = getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`) as { consumed_at: string | null };
    expect(challenge.consumed_at).toBeNull();
    const retried = await fixture.register("atomic-bind", { ...proof, name: "Transactional profile" }, fixture.adminHeaders);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().kernel.signingKey).toEqual(ED_SIGNER);
    expect(fixture.row("atomic-bind")?.name).toBe("Transactional profile");
  });

  it("allows the admin secret to update an owned profile", async () => {
    expect((await fixture.register("admin-profile")).statusCode).toBe(201);
    const response = await fixture.register("admin-profile", { name: "Admin profile", maxAssuranceTier: 3 }, fixture.adminHeaders);
    expect(response.statusCode).toBe(200);
    expect(fixture.row("admin-profile")).toMatchObject({ name: "Admin profile", maxAssuranceTier: 3, operatorAddress: OWNER });
  });

  it("allows the admin secret plus a valid proof to bind the first signer", async () => {
    expect((await fixture.register("admin-first-bind")).statusCode).toBe(201);
    const response = await fixture.register("admin-first-bind", await fixture.proof("admin-first-bind"), fixture.adminHeaders);
    expect(response.statusCode).toBe(200);
    expect(response.json().kernel.signingKey).toEqual(ED_SIGNER);
  });

  it("allows a proven owner wallet to update the profile and bind the first signer", async () => {
    expect((await fixture.register("proven-owner")).statusCode).toBe(201);
    const profile = await fixture.register("proven-owner", { name: "Owner profile" }, fixture.provenHeaders);
    expect(profile.statusCode).toBe(200);
    const bind = await fixture.register("proven-owner", { ...await fixture.proof("proven-owner"), name: "Owner signer" }, fixture.provenHeaders);
    expect(bind.statusCode).toBe(200);
    expect(bind.json().kernel.signingKey).toEqual(ED_SIGNER);
  });

  it("requires a valid proof even when the admin requests a first signer bind", async () => {
    expect((await fixture.register("admin-invalid-bind")).statusCode).toBe(201);
    const challenge = await fixture.issue("admin-invalid-bind");
    const before = fixture.row("admin-invalid-bind");
    const response = await fixture.register("admin-invalid-bind", {
      ...signerFields(ED_SIGNER), name: "Changed with invalid proof",
      registrationProof: { challengeId: challenge.challengeId, signature: signEd(challenge.message, ED_B) },
    }, fixture.adminHeaders);
    expect(response.statusCode).toBe(403);
    expect(fixture.row("admin-invalid-bind")).toEqual(before);
  });

  it("allows a fresh proof by the already bound signer to re-register from another authenticated key", async () => {
    expect((await fixture.register("bound-reregister", await fixture.proof("bound-reregister"))).statusCode).toBe(201);
    const response = await fixture.register("bound-reregister", {
      ...await fixture.proof("bound-reregister", ED_SIGNER, fixture.otherKey), name: "Re-registered profile", maxAssuranceTier: 3,
    }, fixture.headers(fixture.otherKey));
    expect(response.statusCode).toBe(200);
    expect(response.json().kernel.signingKey).toEqual(ED_SIGNER);
    expect(fixture.row("bound-reregister")).toMatchObject({ name: "Re-registered profile", maxAssuranceTier: 3, operatorAddress: OWNER });
  });

  it("allows a fresh secp256k1 proof by the bound signer to re-register", async () => {
    expect((await fixture.register("evm-bound-reregister", await fixture.proof("evm-bound-reregister", EVM_SIGNER))).statusCode).toBe(201);
    const response = await fixture.register("evm-bound-reregister", {
      ...await fixture.proof("evm-bound-reregister", EVM_SIGNER, fixture.otherKey), name: "EVM boot profile",
    }, fixture.headers(fixture.otherKey));
    expect(response.statusCode).toBe(200);
    expect(response.json().kernel.signingKey).toEqual(EVM_SIGNER);
    expect(fixture.row("evm-bound-reregister")).toMatchObject({ name: "EVM boot profile", operatorAddress: OWNER });
  });

  it("allows a bound signer's legacy proof to re-register only while the flag allows it", async () => {
    expect((await fixture.register("bound-legacy", await fixture.proof("bound-legacy"))).statusCode).toBe(201);
    const payload = { ...signerFields(ED_SIGNER), signingProof: legacyEdProof("bound-legacy"), name: "Legacy boot" };
    const before = fixture.row("bound-legacy");
    const denied = await fixture.register("bound-legacy", payload, fixture.headers(fixture.otherKey));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("legacy_signing_proof_disabled");
    expect(fixture.row("bound-legacy")).toEqual(before);
    process.env.PCC_KERNEL_LEGACY_SIGNING_PROOF = "allow";
    const allowed = await fixture.register("bound-legacy", payload, fixture.headers(fixture.otherKey));
    expect(allowed.statusCode).toBe(200);
    expect(fixture.row("bound-legacy")?.name).toBe("Legacy boot");
  });

  it("refuses another signer's valid challenge proof on an owned kernel without changing the row", async () => {
    expect((await fixture.register("bound-other-key", await fixture.proof("bound-other-key"))).statusCode).toBe(201);
    const before = fixture.row("bound-other-key");
    const signer = { algorithm: "ed25519" as const, publicKey: `0x${ED_B.publicKeyHex}` };
    const challenge = await fixture.issue("bound-other-key", signer, fixture.sameClaimKey);
    const response = await fixture.register("bound-other-key", {
      ...signerFields(signer), name: "Other signer profile",
      registrationProof: { challengeId: challenge.challengeId, signature: signEd(challenge.message, ED_B) },
    }, fixture.headers(fixture.sameClaimKey));
    expect(response.statusCode).toBe(403);
    expect(fixture.row("bound-other-key")).toEqual(before);
  });

  it.each(["", "0x0000000000000000000000000000000000000000"])("requires the admin secret for an unowned kernel even with its bound signer's proof: %j", async (operatorAddress) => {
    expect((await fixture.register("unowned-bound", await fixture.proof("unowned-bound"))).statusCode).toBe(201);
    getRepos().kernels.update("unowned-bound", { operatorAddress });
    const before = fixture.row("unowned-bound");
    const proof = await fixture.proof("unowned-bound");
    const denied = await fixture.register("unowned-bound", { ...proof, name: "Unowned profile" });
    expect(denied.statusCode).toBe(403);
    expect(fixture.row("unowned-bound")).toEqual(before);
    const accepted = await fixture.register("unowned-bound", { ...proof, name: "Admin assigned profile" }, fixture.adminHeaders);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().kernel.signingKey).toEqual(ED_SIGNER);
    expect(fixture.row("unowned-bound")?.name).toBe("Admin assigned profile");
  });

  it("preserves the set-once signer and profile when an admin proves a different key", async () => {
    expect((await fixture.register("set-once", await fixture.proof("set-once"))).statusCode).toBe(201);
    const before = fixture.row("set-once");
    const signer = { algorithm: "ed25519" as const, publicKey: `0x${ED_B.publicKeyHex}` };
    const challenge = await fixture.issue("set-once", signer);
    const response = await fixture.register("set-once", {
      ...signerFields(signer), name: "Different signer profile",
      registrationProof: { challengeId: challenge.challengeId, signature: signEd(challenge.message, ED_B) },
    }, fixture.adminHeaders);
    expect(response.statusCode).toBe(409);
    expect(fixture.row("set-once")).toEqual(before);
    expect(fixture.row("set-once")?.signingKeyPublicKey).toBe(`0x${ED_A.publicKeyHex}`);
  });
});
