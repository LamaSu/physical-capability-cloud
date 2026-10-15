import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, schema, sql } from "@pcc/store";
import { getRepos, getStore } from "../db.js";
import { authorityOf } from "../auth/kernel-authority.js";
import { hasSingleValidAdminKey } from "../middleware/relay-admin-gate.js";
import { refuseKernelRequest } from "./operator-relay.js";
import { assertMintablePackage, PackageNotMintableError, validatePackageBody } from "../settlement/final-milestone-package-v2.js";
import { mintablePackageDigest, packageDigestV2OfPreImage, packageDigestV2PreImage } from "../settlement/package-digest-v2.js";
import { ReceiptSigningUnavailableError, signGatewayReceipt } from "../settlement/gateway-receipt.js";
import { createEip712OperatorVerifier } from "../settlement/operator-signature-verifier.js";
import { loadReceiptSigner } from "../settlement/receipt-signer.js";
import { createJobChallengeReader, findStoredReceipt, gatewayKernelRegistry, storedReceiptBody } from "../settlement/receipt-store.js";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const positiveChainId = (value: unknown): number | null => {
  if (typeof value !== "number" && !(typeof value === "string" && /^[1-9][0-9]*$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function mintRefusal(error: PackageNotMintableError): string {
  // Translate the library's refusals without exposing its diagnostic strings or request data.
  if (error.message.includes(" at $.challengeBinding")) return "package_challenge_refused";
  if (error.message.includes(" at $.producer.kernelId") || error.message.includes(" at $.producer.devicePrincipalId")) return "package_registry_refused";
  if (error.message.includes(" at $.producer.operatorPrincipalId") || error.message.includes("operator signature verifier")) return "package_operator_refused";
  return "invalid_package_signatures";
}

export async function settlementReceiptRoutes(app: FastifyInstance) {
  app.post<{ Body: { jobId?: unknown; chainId?: unknown; escrow?: unknown; settlementUnitId?: unknown; ttlSeconds?: unknown } }>(
    "/api/admin/settlement-challenges", { schema: { hide: true } }, async (req, reply) => {
      if (!hasSingleValidAdminKey(req)) return reply.code(403).send({ error: "admin_required" });
      const { jobId, chainId: rawChainId, escrow: rawEscrow, settlementUnitId, ttlSeconds = 86_400 } = req.body ?? {};
      const chainId = positiveChainId(rawChainId);
      if (typeof jobId !== "string" || jobId.trim().length === 0 || chainId === null
        || typeof rawEscrow !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(rawEscrow)
        || typeof settlementUnitId !== "string" || !/^0x[0-9a-f]{64}$/.test(settlementUnitId)
        || typeof ttlSeconds !== "number" || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 604_800) {
        return reply.code(400).send({ error: "invalid_challenge_request" });
      }
      if (!getRepos().jobs.findById(jobId)) return reply.code(404).send({ error: "job_not_found" });
      const escrow = rawEscrow.toLowerCase();
      const table = schema.settlementChallenges;
      const unit = and(eq(table.chainId, chainId), eq(table.escrow, escrow), eq(table.settlementUnitId, settlementUnitId));
      const now = nowSeconds();
      const result = getStore().db.transaction((tx) => {
        const history = tx.select().from(table).where(unit).all();
        if (history.some((row) => row.jobId !== jobId)) return null;
        const open = history.find((row) => row.state === "issued" && row.expiresAt > now);
        // A repeated issue returns the same open challenge, without extending its lifetime.
        if (open) return { nonce: open.nonce, tChallengeRef: open.tChallengeRef, expiresAt: open.expiresAt };
        // Retire expired issues before replacing them; they never authorize a mint.
        tx.update(table).set({ state: "consumed", consumedAt: now }).where(and(unit, eq(table.state, "issued"), sql`${table.expiresAt} <= ${now}`)).run();
        const challenge = {
          nonce: `0x${randomBytes(32).toString("hex")}`,
          tChallengeRef: `gateway-challenge:${randomUUID()}`,
          expiresAt: now + ttlSeconds,
        };
        tx.insert(table).values({ id: randomUUID(), jobId, chainId, escrow, settlementUnitId, ...challenge, state: "issued", issuedAt: now }).run();
        return challenge;
      }, { behavior: "immediate" });
      if (!result) return reply.code(409).send({ error: "challenge_exists" });
      return result;
    },
  );

  app.post<{ Params: { jobId: string }; Body: { packageEnvelope?: { body?: unknown; signatures?: unknown } } }>(
    "/api/operator/jobs/:jobId/receipt", async (req, reply) => {
      const { jobId } = req.params;
      const job = getRepos().jobs.findById(jobId);
      if (!job) return reply.code(404).send({ error: "job_not_found" });
      const refusal = refuseKernelRequest(req, job.kernelId, "decide");
      if (refusal) return reply.code(refusal.status).send(refusal.body);
      const envelope = req.body?.packageEnvelope;
      let body;
      try {
        body = validatePackageBody(envelope?.body);
      } catch {
        return reply.code(400).send({ error: "invalid_package_body" });
      }
      if (body.producer.kernelId !== job.kernelId) return reply.code(409).send({ error: "kernel_mismatch" });
      const chainId = positiveChainId(body.unitBinding.chainId);
      if (chainId === null) return reply.code(400).send({ error: "invalid_settlement_unit" });
      const receivedAt = nowSeconds();
      const signer = loadReceiptSigner(receivedAt);
      // Availability is checked before the mint guard so an unavailable signer burns nothing.
      if (!signer) return reply.code(503).send({ error: "receipt_signer_unavailable" });
      let postedDigest: `0x${string}`;
      try {
        // Only compare identity here: a stored receipt must not mint or consume again.
        postedDigest = packageDigestV2OfPreImage(packageDigestV2PreImage(body, envelope?.signatures));
      } catch {
        return reply.code(422).send({ error: "invalid_package_signatures" });
      }
      const existing = findStoredReceipt(jobId, body.unitBinding);
      if (existing) {
        if (existing.packageDigest === postedDigest) return storedReceiptBody(existing);
        return reply.code(409).send({ error: "receipt_exists" });
      }
      const verifier = createEip712OperatorVerifier({
        operatorForUnit() {
          const kernel = getStore().db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, job.kernelId!)).get();
          const operator = kernel?.operatorAddress ?? null;
          const proven = authorityOf(req).provenWallet;
          if (proven !== null && proven.toLowerCase() !== operator?.toLowerCase()) return null;
          // The gateway uses its registry here; the oracle checks the escrow clone's operator() authoritatively.
          return operator;
        },
      });
      try {
        const minted = await assertMintablePackage(body, envelope?.signatures, gatewayKernelRegistry, createJobChallengeReader(jobId), verifier);
        const receipt = {
          chainId,
          escrow: body.unitBinding.escrow.toLowerCase() as `0x${string}`,
          settlementUnitId: body.unitBinding.settlementUnitId,
          packageDigest: mintablePackageDigest(minted),
          receivedAt,
        };
        const signed = signGatewayReceipt(receipt, signer.signer, signer.publicKey);
        const response = { receipt, signatureHex: signed.signature, receiptDigest: signed.receiptDigest, kid: signer.kid };
        getStore().db.insert(schema.gatewayReceipts).values({
          id: randomUUID(), jobId, kernelId: job.kernelId!, ...receipt,
          receiptDigest: response.receiptDigest, signatureHex: response.signatureHex, kid: response.kid,
          createdAt: new Date().toISOString(),
        }).run();
        return response;
      } catch (error) {
        // A competing mint may have consumed the challenge or won the unique insert.
        const winner = findStoredReceipt(jobId, body.unitBinding);
        if (winner) {
          if (winner.packageDigest === postedDigest) return storedReceiptBody(winner);
          return reply.code(409).send({ error: "receipt_exists" });
        }
        if (error instanceof PackageNotMintableError) return reply.code(422).send({ error: mintRefusal(error) });
        if (error instanceof ReceiptSigningUnavailableError) return reply.code(503).send({ error: "receipt_signer_unavailable" });
        // Avoid reflecting key material or package contents through a generic error handler.
        return reply.code(503).send({ error: "receipt_storage_unavailable" });
      }
    },
  );

  app.get<{ Params: { jobId: string } }>("/api/operator/jobs/:jobId/receipt", async (req, reply) => {
    const job = getRepos().jobs.findById(req.params.jobId);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    const refusal = refuseKernelRequest(req, job.kernelId, "decide");
    if (refusal) return reply.code(refusal.status).send(refusal.body);
    const receipt = findStoredReceipt(job.id);
    if (!receipt) return reply.code(404).send({ error: "receipt_not_found" });
    return storedReceiptBody(receipt);
  });
}
