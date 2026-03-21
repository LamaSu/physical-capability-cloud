/**
 * Human verification routes.
 *
 * POST /api/verification/submit             — Submit an evidence bundle for human verification
 * GET  /api/verification/assignments        — Get pending assignments for a verifier
 * GET  /api/verification/:requestId         — Get verification status
 * POST /api/verification/:requestId/respond — A verifier submits their verdict
 * POST /api/verification/:requestId/dispute — Minority verifier files a dispute
 */

import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import {
  VerifierSelector,
  type HumanVerificationRequest,
  type HumanVerificationResponse,
  type DisputeRecord,
  type VerifierNodeInfo,
} from "@pcc/verifier";

// ---------------------------------------------------------------------------
// In-memory stores (same pattern as other gateway routes)
// ---------------------------------------------------------------------------

interface StoredVerificationRequest {
  request: HumanVerificationRequest;
  assignedVerifiers: VerifierNodeInfo[];
  createdAt: string;
}

interface StoredResponse {
  verifierId: string;
  verdict: "match" | "no_match" | "inconclusive";
  notes?: string;
  signature: string;
  respondedAt: string;
}

const verificationRequests = new Map<string, StoredVerificationRequest>();
const verificationResponses = new Map<string, StoredResponse[]>(); // requestId → responses
const verificationDisputes = new Map<string, DisputeRecord[]>(); // requestId → disputes

// Default pool of verifier nodes available for selection
// (In production these would be fetched from a registry; here we seed a mock pool)
function getMockVerifierPool(): VerifierNodeInfo[] {
  const pool: VerifierNodeInfo[] = [];
  for (let i = 0; i < 10; i++) {
    pool.push({
      id: `verifier_${i}`,
      endpoint: `http://verifier-${i}.internal/verify`,
      publicKey: randomBytes(32).toString("hex"),
      stake: 1000 + i * 500,
      reputation: 8000 + i * 100, // 0-10000 scale
      status: "online",
    });
  }
  return pool;
}

const selector = new VerifierSelector();

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function humanVerificationRoutes(app: FastifyInstance) {
  /**
   * POST /api/verification/submit
   *
   * Body: { bundleHash, photoRef, referenceRef, comparisonScore?, verifierCount? }
   *
   * Creates a HumanVerificationRequest, selects verifiers, stores in DB.
   * Returns: { requestId, assignedVerifiers }
   */
  app.post<{
    Body: {
      bundleHash: string;
      photoRef: string;
      referenceRef: string;
      comparisonScore?: number;
      verifierCount?: number;
    };
  }>("/api/verification/submit", async (req, reply) => {
    const body = req.body as {
      bundleHash?: string;
      photoRef?: string;
      referenceRef?: string;
      comparisonScore?: number;
      verifierCount?: number;
    };

    if (!body?.bundleHash || !body.photoRef || !body.referenceRef) {
      return reply.status(400).send({
        error: "missing_required_fields",
        message: "bundleHash, photoRef, and referenceRef are required",
      });
    }

    const verifierCount = body.verifierCount ?? 5;
    const requestId = `hvreq_${randomBytes(12).toString("hex")}`;
    const now = new Date().toISOString();

    const request: HumanVerificationRequest = {
      requestId,
      bundleHash: body.bundleHash,
      bundleData: JSON.stringify({ photoRef: body.photoRef, referenceRef: body.referenceRef }),
      requiredTier: 2,
      timestamp: now,
      requesterAddress: "0x0000000000000000000000000000000000000000",
      photoRef: body.photoRef,
      referenceRef: body.referenceRef,
      comparisonScore: body.comparisonScore,
      verifierCount,
    };

    // Select verifiers deterministically using the bundleHash as seed
    const pool = getMockVerifierPool();
    const assignedVerifiers = selector.selectVerifiers(
      request,
      pool,
      verifierCount,
      body.bundleHash,
    );

    verificationRequests.set(requestId, {
      request,
      assignedVerifiers,
      createdAt: now,
    });
    verificationResponses.set(requestId, []);
    verificationDisputes.set(requestId, []);

    return {
      requestId,
      assignedVerifiers: assignedVerifiers.map((v) => ({
        id: v.id,
        stake: v.stake,
        reputation: v.reputation,
      })),
      verifierCount: assignedVerifiers.length,
      status: "pending",
      createdAt: now,
    };
  });

  /**
   * GET /api/verification/assignments
   *
   * Query: ?verifierId=xxx
   *
   * Returns pending verification assignments for a given verifier.
   */
  app.get("/api/verification/assignments", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const verifierId = query.verifierId;

    if (!verifierId) {
      return reply.status(400).send({
        error: "missing_verifier_id",
        message: "verifierId query parameter is required",
      });
    }

    const assignments: Array<{
      requestId: string;
      photoRef: string;
      referenceRef: string;
      comparisonScore?: number;
      createdAt: string;
    }> = [];

    for (const [requestId, stored] of verificationRequests) {
      const isAssigned = stored.assignedVerifiers.some((v) => v.id === verifierId);
      if (!isAssigned) continue;

      // Check if this verifier has already responded
      const responses = verificationResponses.get(requestId) ?? [];
      const hasResponded = responses.some((r) => r.verifierId === verifierId);
      if (hasResponded) continue;

      assignments.push({
        requestId,
        photoRef: stored.request.photoRef,
        referenceRef: stored.request.referenceRef,
        comparisonScore: stored.request.comparisonScore,
        createdAt: stored.createdAt,
      });
    }

    return { verifierId, assignments, count: assignments.length };
  });

  /**
   * GET /api/verification/:requestId
   *
   * Returns the verification status: pending responses, consensus state, dispute status.
   */
  app.get<{ Params: { requestId: string } }>(
    "/api/verification/:requestId",
    async (req, reply) => {
      // Guard static route collision
      if (req.params.requestId === "assignments") {
        return reply.status(404).send({ error: "not_found" });
      }

      const { requestId } = req.params;
      const stored = verificationRequests.get(requestId);

      if (!stored) {
        return reply.status(404).send({ error: "not_found", requestId });
      }

      const responses = verificationResponses.get(requestId) ?? [];
      const disputes = verificationDisputes.get(requestId) ?? [];

      // Compute vote tally
      const tally: Record<string, number> = { match: 0, no_match: 0, inconclusive: 0 };
      for (const r of responses) {
        tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
      }

      const total = responses.length;
      const required = stored.request.verifierCount;
      const pendingCount = Math.max(0, required - total);

      // Determine consensus (simple majority >= 60%)
      let consensusVerdict: string | null = null;
      let consensusReached = false;
      for (const [verdict, count] of Object.entries(tally)) {
        if (required > 0 && count / required >= 0.6) {
          consensusVerdict = verdict;
          consensusReached = true;
          break;
        }
      }

      return {
        requestId,
        photoRef: stored.request.photoRef,
        referenceRef: stored.request.referenceRef,
        comparisonScore: stored.request.comparisonScore,
        assignedVerifierCount: stored.request.verifierCount,
        responsesReceived: total,
        pendingResponses: pendingCount,
        tally,
        consensusReached,
        consensusVerdict,
        disputes: disputes.map((d) => ({
          disputeId: d.disputeId,
          disputerId: d.disputerId,
          status: d.status,
          createdAt: d.createdAt,
        })),
        createdAt: stored.createdAt,
      };
    },
  );

  /**
   * POST /api/verification/:requestId/respond
   *
   * Body: { verifierId, verdict: "match"|"no_match"|"inconclusive", notes?, signature }
   *
   * Stores the response and checks if consensus has been reached.
   */
  app.post<{
    Params: { requestId: string };
    Body: {
      verifierId: string;
      verdict: "match" | "no_match" | "inconclusive";
      notes?: string;
      signature: string;
    };
  }>("/api/verification/:requestId/respond", async (req, reply) => {
    const { requestId } = req.params;
    const body = req.body as {
      verifierId?: string;
      verdict?: string;
      notes?: string;
      signature?: string;
    };

    if (!body?.verifierId || !body.verdict || !body.signature) {
      return reply.status(400).send({
        error: "missing_required_fields",
        message: "verifierId, verdict, and signature are required",
      });
    }

    const validVerdicts = ["match", "no_match", "inconclusive"];
    if (!validVerdicts.includes(body.verdict)) {
      return reply.status(400).send({
        error: "invalid_verdict",
        message: `verdict must be one of: ${validVerdicts.join(", ")}`,
      });
    }

    const stored = verificationRequests.get(requestId);
    if (!stored) {
      return reply.status(404).send({ error: "not_found", requestId });
    }

    // Verify this verifier is assigned to this request
    const isAssigned = stored.assignedVerifiers.some((v) => v.id === body.verifierId);
    if (!isAssigned) {
      return reply.status(403).send({
        error: "not_assigned",
        message: `Verifier ${body.verifierId} is not assigned to request ${requestId}`,
      });
    }

    const responses = verificationResponses.get(requestId) ?? [];

    // Check for duplicate response
    const alreadyResponded = responses.some((r) => r.verifierId === body.verifierId);
    if (alreadyResponded) {
      return reply.status(409).send({
        error: "already_responded",
        message: `Verifier ${body.verifierId} has already submitted a response`,
      });
    }

    const newResponse: StoredResponse = {
      verifierId: body.verifierId!,
      verdict: body.verdict as "match" | "no_match" | "inconclusive",
      notes: body.notes,
      signature: body.signature!,
      respondedAt: new Date().toISOString(),
    };

    responses.push(newResponse);
    verificationResponses.set(requestId, responses);

    // Check if consensus is reached
    const required = stored.request.verifierCount;
    const tally: Record<string, number> = { match: 0, no_match: 0, inconclusive: 0 };
    for (const r of responses) {
      tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
    }

    let consensusVerdict: string | null = null;
    let consensusReached = false;
    for (const [verdict, count] of Object.entries(tally)) {
      if (required > 0 && count / required >= 0.6) {
        consensusVerdict = verdict;
        consensusReached = true;
        break;
      }
    }

    return {
      requestId,
      verifierId: body.verifierId,
      verdict: body.verdict,
      responsesReceived: responses.length,
      consensusReached,
      consensusVerdict,
      tally,
    };
  });

  /**
   * POST /api/verification/:requestId/dispute
   *
   * Body: { disputerId, reason, evidenceCid }
   *
   * A minority verifier files a dispute against the consensus verdict.
   */
  app.post<{
    Params: { requestId: string };
    Body: {
      disputerId: string;
      reason: string;
      evidenceCid: string;
    };
  }>("/api/verification/:requestId/dispute", async (req, reply) => {
    const { requestId } = req.params;
    const body = req.body as {
      disputerId?: string;
      reason?: string;
      evidenceCid?: string;
    };

    if (!body?.disputerId || !body.reason || !body.evidenceCid) {
      return reply.status(400).send({
        error: "missing_required_fields",
        message: "disputerId, reason, and evidenceCid are required",
      });
    }

    const stored = verificationRequests.get(requestId);
    if (!stored) {
      return reply.status(404).send({ error: "not_found", requestId });
    }

    // Verify the disputer actually responded (can't dispute if you didn't respond)
    const responses = verificationResponses.get(requestId) ?? [];
    const disputerResponse = responses.find((r) => r.verifierId === body.disputerId);
    if (!disputerResponse) {
      return reply.status(403).send({
        error: "no_response_found",
        message: `Verifier ${body.disputerId} has not submitted a response for this request`,
      });
    }

    const disputes = verificationDisputes.get(requestId) ?? [];

    // Check for duplicate dispute
    const alreadyDisputed = disputes.some((d) => d.disputerId === body.disputerId);
    if (alreadyDisputed) {
      return reply.status(409).send({
        error: "already_disputed",
        message: `Verifier ${body.disputerId} has already filed a dispute for this request`,
      });
    }

    const disputeId = `dispute_${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();

    const dispute: DisputeRecord = {
      disputeId,
      requestId,
      disputerId: body.disputerId!,
      reason: body.reason!,
      evidence: body.evidenceCid!,
      status: "pending",
      createdAt: now,
    };

    disputes.push(dispute);
    verificationDisputes.set(requestId, disputes);

    return {
      disputeId,
      requestId,
      disputerId: body.disputerId,
      status: "pending",
      createdAt: now,
    };
  });
}
