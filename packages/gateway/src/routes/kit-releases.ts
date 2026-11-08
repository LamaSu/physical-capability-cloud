/**
 * Public demand release ledger, read routes (kits K4a). The ledger and its
 * integrity rules live in services/release-ledger.ts.
 *
 *   GET /api/kits/demand/releases          every released period that verifies, newest first
 *   GET /api/kits/demand/releases/:period  one period's verified release and its approved-set snapshot
 *
 * A consumer verifies a release with @pcc/spec's
 * demandAggregatesFromRelease(release, approvedSet, asOf). Publishing is not a
 * route: the server-side producer calls the ledger. Like every /api/kits path,
 * these need an authenticated caller. Whether releases should be readable
 * without one is a policy decision left to the operator.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { getReleaseLedger, ReleaseIntegrityError, ReleaseLedgerError, type ReleaseLedger } from "../services/release-ledger.js";

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ReleaseLedgerError) {
    return reply.status(err.status).send({ error: err.code, message: err.message, ...err.details });
  }
  if (err instanceof ReleaseIntegrityError) {
    reply.log?.error?.({ period: err.period }, "release ledger integrity failure");
    return reply.status(500).send({ error: err.code, message: "the stored release failed verification and is not served" });
  }
  throw err;
}

export async function kitReleaseRoutes(app: FastifyInstance, opts: { ledger?: ReleaseLedger } = {}): Promise<void> {
  const ledger = (): ReleaseLedger => opts.ledger ?? getReleaseLedger();

  app.get("/api/kits/demand/releases", async (_req, reply) => {
    try {
      return await ledger().list();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { period: string } }>("/api/kits/demand/releases/:period", async (req, reply) => {
    try {
      const view = await ledger().get(req.params.period);
      if (!view) return reply.status(404).send({ error: "not_found", message: "that period has not been released" });
      return view;
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
