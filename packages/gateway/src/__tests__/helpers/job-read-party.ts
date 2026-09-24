import type { FastifyInstance } from "fastify";

/** Seeded kernel operators (packages/db/src/seed/kernels.ts). */
export const SEED_OPERATORS = Object.freeze({
  "kernel-nyc": "0x1111111111111111111111111111111111111111",
  "kernel-sf": "0x2222222222222222222222222222222222222222",
  "kernel-la": "0x3333333333333333333333333333333333333333",
});

/**
 * Job reads are object-authorized (readmodels F3): an admin, the job's kernel operator, or
 * its recorded buyer. Route tests that are not about that authorization read as a party:
 * this stands in for the API gate and sets the caller to `principal` (by default the seeded
 * kernel-nyc operator; null sets none). A request can name another caller with an
 * `x-test-principal` header.
 */
export function actAsJobParty(app: FastifyInstance, principal: string | null = SEED_OPERATORS["kernel-nyc"]): void {
  app.addHook("onRequest", async (req) => {
    const p = req.headers["x-test-principal"];
    const who = typeof p === "string" ? p : ((req as any).operatorId ?? principal);
    if (who != null) (req as any).operatorId = who;
  });
}
