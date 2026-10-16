import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@pcc/store";
import { randomUUID } from "node:crypto";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getRepos, getStore } from "../db.js";
import { kernelSigningProofMessage } from "@pcc/kernel";
import { issueKernelRegistrationChallenge, verifyKernelRegistrationProof } from "../auth/kernel-registration.js";
import {
  ED_A, ED_B, ED_SIGNER, EVM_A, EVM_B, EVM_SIGNER, legacyEdProof,
  registrationFixture, signEd, signerFields, type RegistrationFixture,
} from "./helpers/kernel-registration-fixture.js";

describe("kernel registration challenges", () => {
  let fixture: RegistrationFixture;
  beforeEach(async () => { fixture = await registrationFixture(); });
  afterEach(async () => { vi.useRealTimers(); await fixture.close(); });

  it("requires authentication to issue a challenge", async () => {
    const response = await fixture.app.inject({ method: "POST", url: "/api/kernels/registration-challenges", payload: { kernelId: "authenticated", signer: ED_SIGNER } });
    expect(response.statusCode).toBe(401);
  });

  it("refuses direct challenge issuance without an API key or wallet session", () => {
    expect(() => issueKernelRegistrationChallenge({ kernelId: "anonymous-issuer", signer: ED_SIGNER }, {
      admin: false, provenWallet: null, claimed: null,
    })).toThrowError(expect.objectContaining({
      name: "ForbiddenError", message: "Kernel registration proof is invalid, expired, or already consumed",
    }));
    expect(getStore().db.get(sql`SELECT id FROM kernel_registration_challenges`)).toBeUndefined();
  });

  it.each([{ scopes: [] }, { scopes: ["requestor"] }])("allows an authenticated API key with scopes $scopes to issue a challenge", async ({ scopes }) => {
    const key = provisionApiKey({ operatorId: "challenge-requestor", scopes }).rawKey;
    const response = await fixture.app.inject({
      method: "POST", url: "/api/kernels/registration-challenges", headers: fixture.headers(key),
      payload: { kernelId: "scope-independent-challenge", signer: ED_SIGNER },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().challengeId).toEqual(expect.any(String));
  });

  it("allows a wallet session without API key scopes to issue a challenge", async () => {
    const now = Date.now();
    const session = getRepos().sessions.insert({
      id: randomUUID(), walletAddress: EVM_A.address, token: randomUUID(),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
    })!;
    const response = await fixture.app.inject({
      method: "POST", url: "/api/kernels/registration-challenges", headers: { authorization: `Bearer ${session.token}` },
      payload: { kernelId: "session-challenge", signer: ED_SIGNER },
    });
    expect(response.statusCode).toBe(201);
    const challengeId = response.json().challengeId as string;
    const stored = getStore().db.get(sql`SELECT created_by_key_id FROM kernel_registration_challenges WHERE id = ${challengeId}`) as { created_by_key_id: string | null };
    expect(stored.created_by_key_id).toBeNull();
  });

  it.each(["/api/kernels/registration-challenges", "/api/kernels/*"])("enforces a governance scope row %s requiring admin on authenticated challenge requests", async (routePattern) => {
    getRepos().governance.insertEndpointScope({
      id: "challenge-scope-row", method: "POST", routePattern,
      requiredScopes: ["admin"], description: "Challenge scope test fixture",
    });
    const key = provisionApiKey({ operatorId: "scope-free-requestor", scopes: [] }).rawKey;
    const denied = await fixture.app.inject({
      method: "POST", url: "/api/kernels/registration-challenges", headers: fixture.headers(key),
      payload: { kernelId: "governance-challenge", signer: ED_SIGNER },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("insufficient_scope");
    expect(denied.json().required_scopes).toEqual(["admin"]);
    expect(getStore().db.get(sql`SELECT id FROM kernel_registration_challenges`)).toBeUndefined();
    const adminKey = provisionApiKey({ operatorId: "scope-admin-requestor", scopes: ["admin"] }).rawKey;
    const challenge = await fixture.issue("governance-challenge", ED_SIGNER, adminKey);
    expect(challenge.challengeId).toEqual(expect.any(String));
  });

  it.each([
    { label: "null body", body: null },
    { label: "missing kernel id", body: { signer: ED_SIGNER } },
    { label: "unknown algorithm", body: { kernelId: "invalid-challenge", signer: { algorithm: "rsa", publicKey: ED_A.publicKeyHex } } },
    { label: "line break in kernel id", body: { kernelId: "invalid\nchallenge", signer: ED_SIGNER } },
    { label: "Unicode kernel id", body: { kernelId: "kernel-打印", signer: ED_SIGNER } },
    { label: "overlong kernel id", body: { kernelId: "k".repeat(129), signer: ED_SIGNER } },
    { label: "reserved EVM prefix", body: { kernelId: "eip155:8453:key", signer: ED_SIGNER } },
    { label: "reserved Ed25519 prefix", body: { kernelId: "ED25519:key", signer: ED_SIGNER } },
    { label: "invalid public key", body: { kernelId: "invalid-challenge", signer: { algorithm: "ed25519", publicKey: "bad-key" } } },
  ])("refuses a malformed challenge request: $label", async ({ body }) => {
    const response = await fixture.app.inject({
      method: "POST", url: "/api/kernels/registration-challenges",
      headers: { ...fixture.headers(), "content-type": "application/json" }, payload: JSON.stringify(body),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_registration_challenge");
  });

  it("issues distinct server identifiers with a ten minute lifetime and records the requesting key", async () => {
    const before = Date.now();
    const first = await fixture.issue("challenge-fields");
    const second = await fixture.issue("challenge-fields", ED_SIGNER, fixture.otherKey);
    expect(first.challengeId).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(second.challengeId).not.toBe(first.challengeId);
    expect(second.message).not.toBe(first.message);
    expect(Date.parse(first.expiresAt)).toBeGreaterThanOrEqual(before + 600_000);
    expect(Date.parse(first.expiresAt)).toBeLessThanOrEqual(Date.now() + 600_000);
    const stored = getStore().db.get(sql`SELECT created_by_key_id, consumed_at, message FROM kernel_registration_challenges WHERE id = ${first.challengeId}`) as { created_by_key_id: string; consumed_at: string | null; message: string };
    const key = getStore().db.get(sql`SELECT operator_id FROM api_keys WHERE id = ${stored.created_by_key_id}`) as { operator_id: string };
    expect(key.operator_id).toBe("0x1111111111111111111111111111111111111111");
    expect(stored.consumed_at).toBeNull();
    expect(stored.message).toBe(first.message);
  });

  it("composes canonical Ed25519 bytes with all registration fields", async () => {
    const challenge = await fixture.issue("ed-envelope");
    const decoded = Buffer.from(challenge.message, "base64").toString("utf8");
    expect(decoded.startsWith("PCC-KERNEL-REG-V1\n")).toBe(true);
    const json = decoded.slice("PCC-KERNEL-REG-V1\n".length);
    const fields = JSON.parse(json);
    expect(fields).toEqual({
      challengeId: challenge.challengeId, kernelId: "ed-envelope", nonce: expect.any(String),
      env: "prod", chainId: 84532, domain: "capability.network", issuedAt: expect.any(String),
      expiresAt: challenge.expiresAt, publicKey: `0x${ED_A.publicKeyHex}`,
    });
    const canonical = Object.fromEntries(Object.entries(fields).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    expect(json).toBe(JSON.stringify(canonical));
    expect(fields.nonce).toMatch(/^[A-Za-z0-9]{8,}$/);
  });

  it("composes the exact EIP-4361 text and registers a secp256k1 signer", async () => {
    const challenge = await fixture.issue("evm-envelope", EVM_SIGNER);
    const nonce = /^Nonce: (.+)$/m.exec(challenge.message)?.[1];
    const issuedAt = /^Issued At: (.+)$/m.exec(challenge.message)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9]{8,}$/);
    expect(challenge.message).toBe([
      "capability.network wants you to sign in with your Ethereum account:", EVM_A.address, "",
      "Register this key as the signing key of PCC kernel evm-envelope. Consent: kernel-registration v1.", "",
      "URI: https://capability.network/kernels/register", "Version: 1", "Chain ID: 84532", `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`, `Expiration Time: ${challenge.expiresAt}`, `Request ID: ${challenge.challengeId}`,
      "Resources:", `- urn:pcc:kernel-registration:${challenge.challengeId}`, "- urn:pcc:kernel:evm-envelope", "- urn:pcc:env:prod",
    ].join("\n"));
    const parsed = parseSiweMessage(challenge.message);
    expect(createSiweMessage(parsed as Parameters<typeof createSiweMessage>[0])).toBe(challenge.message);
    const signature = await EVM_A.signMessage({ message: challenge.message });
    const response = await fixture.register("evm-envelope", { ...signerFields(EVM_SIGNER), registrationProof: { challengeId: challenge.challengeId, signature } });
    expect(response.statusCode).toBe(201);
    expect(response.json().kernel.signingKey).toEqual(EVM_SIGNER);
  });

  it("URI-encodes special kernel ids in SIWE resources and round-trips the signed message", async () => {
    const kernelId = 'k{|}^"<>`x';
    const challenge = await fixture.issue(kernelId, EVM_SIGNER);
    const parsed = parseSiweMessage(challenge.message);
    expect(parsed.resources).toEqual([
      `urn:pcc:kernel-registration:${challenge.challengeId}`,
      `urn:pcc:kernel:${encodeURIComponent(kernelId)}`,
      "urn:pcc:env:prod",
    ]);
    expect(createSiweMessage(parsed as Parameters<typeof createSiweMessage>[0])).toBe(challenge.message);
    const signature = await EVM_A.signMessage({ message: challenge.message });
    const response = await fixture.register(kernelId, {
      ...signerFields(EVM_SIGNER), registrationProof: { challengeId: challenge.challengeId, signature },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().kernel.signingKey).toEqual(EVM_SIGNER);
    expect(fixture.row(kernelId)?.id).toBe(kernelId);
  });

  it.each([
    { deployment: "production", railway: undefined, node: "test", expected: "prod" },
    { deployment: "", railway: "staging", node: "test", expected: "staging" },
    { deployment: "", railway: "", node: "test", expected: "test" },
    { deployment: "", railway: "", node: "", expected: "development" },
  ])("shares W1's environment label $expected", async ({ deployment, railway, node, expected }) => {
    process.env.PCC_DEPLOYMENT_ENV = deployment;
    if (railway === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
    else process.env.RAILWAY_ENVIRONMENT_NAME = railway;
    process.env.NODE_ENV = node;
    const challenge = await fixture.issue("shared-env");
    expect(JSON.parse(Buffer.from(challenge.message, "base64").toString("utf8").split("\n")[1]).env).toBe(expected);
  });

  it("uses the fallback origin for an empty public URL without a server error", async () => {
    process.env.PCC_PUBLIC_URL = "";
    process.env.PCC_GATEWAY_URL = "http://localhost:3200/a-path";
    const challenge = await fixture.issue("empty-url", EVM_SIGNER);
    expect(challenge.message).toContain("localhost:3200 wants you to sign in");
    expect(challenge.message).toContain("URI: http://localhost:3200/kernels/register\n");
    const signature = await EVM_A.signMessage({ message: challenge.message });
    expect((await fixture.register("empty-url", { ...signerFields(EVM_SIGNER), registrationProof: { challengeId: challenge.challengeId, signature } })).statusCode).toBe(201);
  });

  it("uses W1's public default when both configured URLs are empty", async () => {
    process.env.PCC_PUBLIC_URL = "";
    process.env.PCC_GATEWAY_URL = "";
    const challenge = await fixture.issue("empty-urls", EVM_SIGNER);
    expect(challenge.message).toContain("URI: https://capability.network/kernels/register\n");
  });

  it("registers an Ed25519 signer with a fresh proof", async () => {
    const response = await fixture.register("fresh-proof", await fixture.proof("fresh-proof"));
    expect(response.statusCode).toBe(201);
    expect(response.json().kernel.signingKey).toEqual(ED_SIGNER);
  });

  it.each(["other key", "same claimed owner"])("refuses challenge redemption by another principal: %s", async (principal) => {
    const proof = await fixture.proof("issuer-only");
    const key = principal === "other key" ? fixture.otherKey : fixture.sameClaimKey;
    const denied = await fixture.register("issuer-only", proof, fixture.headers(key));
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "FORBIDDEN", message: "Kernel registration proof is invalid, expired, or already consumed" });
    expect(fixture.row("issuer-only")).toBeUndefined();
    const row = getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`);
    expect(row).toEqual({ consumed_at: null });
    expect((await fixture.register("issuer-only", proof)).statusCode).toBe(201);
    expect(fixture.row("issuer-only")?.signingKeyPublicKey).toBe(`0x${ED_A.publicKeyHex}`);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: expect.any(String) });
  });

  it("allows the admin to redeem another principal's challenge", async () => {
    const proof = await fixture.proof("admin-redemption");
    const response = await fixture.register("admin-redemption", proof, fixture.adminHeaders);
    expect(response.statusCode).toBe(201);
    expect(response.json().kernel.signingKey).toEqual(ED_SIGNER);
  });

  function sessionHeaders(walletAddress: string) {
    const now = Date.now();
    const session = getRepos().sessions.insert({
      id: randomUUID(), walletAddress, token: randomUUID(),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
    })!;
    return { authorization: `Bearer ${session.token}` };
  }

  it("binds a session-issued challenge to its wallet identity", async () => {
    const issuer = sessionHeaders(EVM_A.address);
    const other = sessionHeaders(EVM_B.address);
    const issued = await fixture.app.inject({
      method: "POST", url: "/api/kernels/registration-challenges", headers: issuer,
      payload: { kernelId: "session-issuer", signer: ED_SIGNER },
    });
    expect(issued.statusCode).toBe(201);
    const challenge = issued.json();
    expect(getStore().db.get(sql`SELECT created_by_key_id, created_by_session_identity FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ created_by_key_id: null, created_by_session_identity: EVM_A.address.toLowerCase() });
    const proof = { ...signerFields(ED_SIGNER), registrationProof: { challengeId: challenge.challengeId, signature: signEd(challenge.message) } };
    for (const headers of [other, fixture.headers()]) {
      const denied = await fixture.register("session-issuer", proof, headers);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().message).toBe("Kernel registration proof is invalid, expired, or already consumed");
      expect(fixture.row("session-issuer")).toBeUndefined();
      expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
        .toEqual({ consumed_at: null });
    }
    const accepted = await fixture.register("session-issuer", proof, issuer);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().kernel.signingKey).toEqual(ED_SIGNER);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: expect.any(String) });
  });

  it.each([EVM_A.address, EVM_A.address.toLowerCase()])("refuses a key claiming the session wallet %s from redeeming its challenge", async (claimedWallet) => {
    const issuer = sessionHeaders(EVM_A.address);
    const issued = await fixture.app.inject({
      method: "POST", url: "/api/kernels/registration-challenges", headers: issuer,
      payload: { kernelId: "session-claimed-key", signer: ED_SIGNER },
    });
    expect(issued.statusCode).toBe(201);
    const challenge = issued.json();
    const proof = { ...signerFields(ED_SIGNER), registrationProof: { challengeId: challenge.challengeId, signature: signEd(challenge.message) } };
    const claimingKey = provisionApiKey({ operatorId: claimedWallet }).rawKey;
    const denied = await fixture.register("session-claimed-key", proof, fixture.headers(claimingKey));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toBe("Kernel registration proof is invalid, expired, or already consumed");
    expect(fixture.row("session-claimed-key")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: null });
    const accepted = await fixture.register("session-claimed-key", proof, issuer);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().kernel.signingKey).toEqual(ED_SIGNER);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: expect.any(String) });
  });

  it("caps open challenges at five per API key across kernels and signers", async () => {
    for (let index = 0; index < 5; index++) await fixture.issue(`principal-cap-${index}`);
    const denied = await fixture.app.inject({
      method: "POST", url: "/api/kernels/registration-challenges", headers: fixture.headers(),
      payload: { kernelId: "principal-cap-six", signer: EVM_SIGNER },
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error).toBe("registration_challenge_limit");
    expect(getStore().db.get(sql`SELECT count(*) AS count FROM kernel_registration_challenges`)).toEqual({ count: 5 });
    expect((await fixture.issue("independent-principal", ED_SIGNER, fixture.otherKey)).challengeId).toEqual(expect.any(String));
  });

  it("caps open challenges per session wallet across session tokens", async () => {
    for (let index = 0; index < 6; index++) {
      const response = await fixture.app.inject({
        method: "POST", url: "/api/kernels/registration-challenges", headers: sessionHeaders(EVM_A.address),
        payload: { kernelId: `session-cap-${index}`, signer: ED_SIGNER },
      });
      expect(response.statusCode).toBe(index < 5 ? 201 : 429);
      if (index === 5) expect(response.json().error).toBe("registration_challenge_limit");
    }
    expect(getStore().db.get(sql`SELECT count(*) AS count FROM kernel_registration_challenges`)).toEqual({ count: 5 });
  });

  it("keeps owner, admin and proven-owner issuance available when another principal fills its signer slots", async () => {
    const kernelId = "pair-cap";
    expect((await fixture.register(kernelId, await fixture.proof(kernelId))).statusCode).toBe(201);
    const listed = (await fixture.app.inject({ method: "GET", url: "/api/kernels" })).json().kernels
      .find((kernel: { id: string }) => kernel.id === kernelId);
    expect(listed.signingKey).toEqual(ED_SIGNER);
    const attackerKey = provisionApiKey({ operatorId: "pair-issuer", scopes: [] }).rawKey;
    const requestChallenge = (headers: Record<string, string>) => fixture.app.inject({
      method: "POST", url: "/api/kernels/registration-challenges", headers,
      payload: { kernelId, signer: listed.signingKey },
    });
    for (let index = 0; index < 5; index++) {
      expect((await requestChallenge(fixture.headers(attackerKey))).statusCode).toBe(201);
    }
    expect(getStore().db.get(sql`SELECT count(*) AS count FROM kernel_registration_challenges WHERE consumed_at IS NULL`))
      .toEqual({ count: 5 });
    const owner = await requestChallenge(fixture.headers());
    expect(owner.statusCode).toBe(201);
    const challenge = owner.json();
    const response = await fixture.register(kernelId, {
      ...signerFields(ED_SIGNER), name: "Owner re-registered",
      registrationProof: { challengeId: challenge.challengeId, signature: signEd(challenge.message) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().kernel.signingKey).toEqual(ED_SIGNER);
    expect(fixture.row(kernelId)?.name).toBe("Owner re-registered");
    expect((await requestChallenge(fixture.adminHeaders)).statusCode).toBe(201);
    expect((await requestChallenge(fixture.provenHeaders)).statusCode).toBe(201);
    expect((await fixture.issue(kernelId, EVM_SIGNER)).challengeId).toEqual(expect.any(String));
  });

  it("does not count consumed challenges toward the open cap", async () => {
    const proof = await fixture.proof("consumed-slot");
    expect((await fixture.register("consumed-slot", proof)).statusCode).toBe(201);
    for (let index = 0; index < 5; index++) await fixture.issue(`remaining-slot-${index}`);
    expect(getStore().db.get(sql`SELECT count(*) AS count FROM kernel_registration_challenges`)).toEqual({ count: 6 });
  });

  it("prunes expired challenges at issuance and frees the principal cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let index = 0; index < 5; index++) await fixture.issue("expired-slots");
    vi.setSystemTime(Date.now() + 600_000);
    const challenge = await fixture.issue("expired-slots");
    expect(getStore().db.all(sql`SELECT id FROM kernel_registration_challenges`)).toEqual([{ id: challenge.challengeId }]);
  });

  it("refuses a replayed registration proof", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const proof = await fixture.proof("single-use");
    expect((await fixture.register("single-use", proof)).statusCode).toBe(201);
    const before = fixture.row("single-use");
    const consumed = getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`);
    expect(consumed).toEqual({ consumed_at: expect.any(String) });
    vi.setSystemTime(Date.now() + 1_000);
    const replay = await fixture.register("single-use", { ...proof, name: "Replayed profile" });
    expect(replay.statusCode).toBe(403);
    expect(replay.json()).toMatchObject({ error: "FORBIDDEN", message: "Kernel registration proof is invalid, expired, or already consumed" });
    expect(fixture.row("single-use")).toEqual(before);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`)).toEqual(consumed);
  });

  it("consumes a challenge once when registrations arrive concurrently", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const proof = await fixture.proof("concurrent-use");
    const responses = await Promise.all([
      fixture.register("concurrent-use", { ...proof, name: "First concurrent profile" }),
      fixture.register("concurrent-use", { ...proof, name: "Second concurrent profile" }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 403]);
    expect(responses.find((response) => response.statusCode === 403)?.json())
      .toMatchObject({ error: "FORBIDDEN", message: "Kernel registration proof is invalid, expired, or already consumed" });
    const before = fixture.row("concurrent-use");
    expect(before?.name).toBe(responses.find((response) => response.statusCode === 201)?.json().kernel.name);
    const consumed = getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`);
    expect(consumed).toEqual({ consumed_at: expect.any(String) });
    vi.setSystemTime(Date.now() + 1_000);
    const replay = await fixture.register("concurrent-use", { ...proof, name: "Replayed concurrent profile" });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().message).toBe("Kernel registration proof is invalid, expired, or already consumed");
    expect(fixture.row("concurrent-use")).toEqual(before);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`)).toEqual(consumed);
  });

  it("refuses a second burn when both uses verified the same unconsumed challenge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const proof = await fixture.proof("verified-before-burn");
    const stored = getStore().db.get<{ created_by_key_id: string }>(sql`SELECT created_by_key_id FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`)!;
    const authority = { admin: false, provenWallet: null, claimed: null, apiKeyId: stored.created_by_key_id };
    const [first, second] = await Promise.all([
      verifyKernelRegistrationProof("verified-before-burn", ED_SIGNER, proof.registrationProof, authority),
      verifyKernelRegistrationProof("verified-before-burn", ED_SIGNER, proof.registrationProof, authority),
    ]);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: null });
    first();
    const consumed = getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`);
    expect(consumed).toEqual({ consumed_at: expect.any(String) });
    vi.setSystemTime(Date.now() + 1_000);
    expect(second).toThrow("Kernel registration proof is invalid, expired, or already consumed");
    expect(first).toThrow("Kernel registration proof is invalid, expired, or already consumed");
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`)).toEqual(consumed);
    expect(fixture.row("verified-before-burn")).toBeUndefined();
  });

  it("refuses a proof for another kernel id", async () => {
    const proof = await fixture.proof("challenged-kernel");
    const response = await fixture.register("other-kernel", proof);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("other-kernel")).toBeUndefined();
    expect(fixture.row("challenged-kernel")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: null });
    expect((await fixture.register("challenged-kernel", proof)).statusCode).toBe(201);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: expect.any(String) });
  });

  it("refuses a staging challenge on a production gateway", async () => {
    process.env.PCC_DEPLOYMENT_ENV = "staging";
    const proof = await fixture.proof("environment-bound");
    process.env.PCC_DEPLOYMENT_ENV = "prod";
    const response = await fixture.register("environment-bound", proof);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("environment-bound")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: null });
    process.env.PCC_DEPLOYMENT_ENV = "staging";
    expect((await fixture.register("environment-bound", proof)).statusCode).toBe(201);
  });

  it("uses Railway's environment when the explicit deployment environment is unset", async () => {
    delete process.env.PCC_DEPLOYMENT_ENV;
    process.env.RAILWAY_ENVIRONMENT_NAME = "staging";
    const proof = await fixture.proof("deployment-environment-bound");
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    const response = await fixture.register("deployment-environment-bound", proof);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("deployment-environment-bound")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: null });
    process.env.RAILWAY_ENVIRONMENT_NAME = "staging";
    expect((await fixture.register("deployment-environment-bound", proof)).statusCode).toBe(201);
  });

  it("refuses a challenge for a different chain", async () => {
    process.env.PCC_CHAIN_ID = "8453";
    const proof = await fixture.proof("chain-bound");
    process.env.PCC_CHAIN_ID = "84532";
    const response = await fixture.register("chain-bound", proof);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("chain-bound")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: null });
    process.env.PCC_CHAIN_ID = "8453";
    expect((await fixture.register("chain-bound", proof)).statusCode).toBe(201);
  });

  it("refuses a challenge for a different public domain", async () => {
    process.env.PCC_PUBLIC_URL = "https://staging.capability.network";
    const proof = await fixture.proof("domain-bound");
    process.env.PCC_PUBLIC_URL = "https://capability.network";
    const response = await fixture.register("domain-bound", proof);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("domain-bound")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: null });
    process.env.PCC_PUBLIC_URL = "https://staging.capability.network";
    expect((await fixture.register("domain-bound", proof)).statusCode).toBe(201);
  });

  it("refuses an expired challenge", async () => {
    const proof = await fixture.proof("expired-challenge");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 600_001);
    const response = await fixture.register("expired-challenge", proof);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("expired-challenge")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: null });
  });

  it("refuses a challenge issued more than ten minutes ago even if its expiration is later", async () => {
    const proof = await fixture.proof("old-challenge");
    const old = new Date(Date.now() - 600_001).toISOString();
    getStore().db.run(sql`UPDATE kernel_registration_challenges SET issued_at = ${old} WHERE id = ${proof.registrationProof.challengeId}`);
    const response = await fixture.register("old-challenge", proof);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("old-challenge")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: null });
  });

  it("rechecks freshness when consuming a previously verified challenge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const proof = await fixture.proof("expires-before-consume");
    const stored = getStore().db.get<{ created_by_key_id: string }>(sql`SELECT created_by_key_id FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`)!;
    expect(stored.created_by_key_id).toEqual(expect.any(String));
    const consume = await verifyKernelRegistrationProof("expires-before-consume", ED_SIGNER, proof.registrationProof, {
      admin: false, provenWallet: null, claimed: null, apiKeyId: stored.created_by_key_id,
    });
    vi.setSystemTime(Date.now() + 600_000);
    expect(consume).toThrow("Kernel registration proof is invalid, expired, or already consumed");
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`)).toEqual({ consumed_at: null });
    expect(fixture.row("expires-before-consume")).toBeUndefined();
  });

  it("refuses a challenge whose issued_at is in the future", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const proof = await fixture.proof("future-challenge");
    vi.setSystemTime(now - 1);
    const denied = await fixture.register("future-challenge", proof);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toBe("Kernel registration proof is invalid, expired, or already consumed");
    expect(fixture.row("future-challenge")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${proof.registrationProof.challengeId}`))
      .toEqual({ consumed_at: null });
  });

  it("refuses an unknown challenge", async () => {
    const response = await fixture.register("unknown-challenge", { ...signerFields(ED_SIGNER), registrationProof: { challengeId: "missing-challenge", signature: "00".repeat(64) } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
  });

  it("refuses a different signer than the one challenged", async () => {
    const challenge = await fixture.issue("signer-bound");
    const response = await fixture.register("signer-bound", {
      signingKeyAlgorithm: "ed25519", signingPublicKey: `0x${ED_B.publicKeyHex}`,
      registrationProof: { challengeId: challenge.challengeId, signature: signEd(challenge.message, ED_B) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("signer-bound")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: null });
    const accepted = await fixture.register("signer-bound", {
      ...signerFields(ED_SIGNER), registrationProof: { challengeId: challenge.challengeId, signature: signEd(challenge.message) },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().kernel.signingKey).toEqual(ED_SIGNER);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: expect.any(String) });
  });

  it.each(["ed25519", "secp256k1"] as const)("refuses a valid signature by A when the body binds B: %s", async (algorithm) => {
    const challenged = algorithm === "ed25519" ? ED_SIGNER : EVM_SIGNER;
    const other = algorithm === "ed25519"
      ? { algorithm, publicKey: `0x${ED_B.publicKeyHex}` }
      : { algorithm, address: EVM_B.address };
    const challenge = await fixture.issue("unproven-body-key", challenged);
    const signature = algorithm === "ed25519" ? signEd(challenge.message) : await EVM_A.signMessage({ message: challenge.message });
    const response = await fixture.register("unproven-body-key", {
      ...signerFields(other), registrationProof: { challengeId: challenge.challengeId, signature },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("unproven-body-key")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: null });
    const accepted = await fixture.register("unproven-body-key", {
      ...signerFields(challenged), registrationProof: { challengeId: challenge.challengeId, signature },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().kernel.signingKey).toEqual(challenged);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: expect.any(String) });
  });

  it("verifies the signature over the stored challenge bytes", async () => {
    const challenge = await fixture.issue("stored-message");
    const wrongBytes = Buffer.from(`${Buffer.from(challenge.message, "base64").toString("utf8")} `).toString("base64");
    const response = await fixture.register("stored-message", {
      ...signerFields(ED_SIGNER), registrationProof: { challengeId: challenge.challengeId, signature: signEd(wrongBytes), message: wrongBytes },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("stored-message")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: null });
    expect((await fixture.register("stored-message", {
      ...signerFields(ED_SIGNER), registrationProof: { challengeId: challenge.challengeId, signature: signEd(challenge.message) },
    })).statusCode).toBe(201);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: expect.any(String) });
  });

  it.each(["ed25519", "secp256k1"] as const)("refuses a signature by a different key over the same stored bytes: %s", async (algorithm) => {
    const challenged = algorithm === "ed25519" ? ED_SIGNER : EVM_SIGNER;
    const challenge = await fixture.issue("signature-bound", challenged);
    const invalidSignature = algorithm === "ed25519"
      ? signEd(challenge.message, ED_B)
      : await EVM_B.signMessage({ message: challenge.message });
    const response = await fixture.register("signature-bound", {
      ...signerFields(challenged), registrationProof: { challengeId: challenge.challengeId, signature: invalidSignature },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("FORBIDDEN");
    expect(fixture.row("signature-bound")).toBeUndefined();
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: null });
    const signature = algorithm === "ed25519"
      ? signEd(challenge.message)
      : await EVM_A.signMessage({ message: challenge.message });
    const accepted = await fixture.register("signature-bound", {
      ...signerFields(challenged), registrationProof: { challengeId: challenge.challengeId, signature },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().kernel.signingKey).toEqual(challenged);
    expect(getStore().db.get(sql`SELECT consumed_at FROM kernel_registration_challenges WHERE id = ${challenge.challengeId}`))
      .toEqual({ consumed_at: expect.any(String) });
  });

  it.each([undefined, "deny", "ALLOW", "allow "])("refuses a legacy proof unless the flag is exactly allow (%s)", async (flag) => {
    if (flag === undefined) delete process.env.PCC_KERNEL_LEGACY_SIGNING_PROOF;
    else process.env.PCC_KERNEL_LEGACY_SIGNING_PROOF = flag;
    const response = await fixture.register("legacy-disabled", { ...signerFields(ED_SIGNER), signingProof: legacyEdProof("legacy-disabled") });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("legacy_signing_proof_disabled");
    expect(fixture.row("legacy-disabled")).toBeUndefined();
  });

  it("accepts an Ed25519 legacy proof when the flag is allow", async () => {
    process.env.PCC_KERNEL_LEGACY_SIGNING_PROOF = "allow";
    const response = await fixture.register("legacy-ed-allowed", { ...signerFields(ED_SIGNER), signingProof: legacyEdProof("legacy-ed-allowed") });
    expect(response.statusCode).toBe(201);
    expect(response.json().kernel.signingKey).toEqual(ED_SIGNER);
  });

  it("accepts a secp256k1 legacy proof when the flag is allow", async () => {
    process.env.PCC_KERNEL_LEGACY_SIGNING_PROOF = "allow";
    const signingProof = await EVM_A.signMessage({ message: kernelSigningProofMessage("legacy-evm-allowed") });
    const response = await fixture.register("legacy-evm-allowed", { ...signerFields(EVM_SIGNER), signingProof });
    expect(response.statusCode).toBe(201);
    expect(response.json().kernel.signingKey).toEqual(EVM_SIGNER);
  });
});
