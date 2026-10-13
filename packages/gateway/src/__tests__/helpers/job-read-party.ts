import type { FastifyInstance } from "fastify";

/** Seeded kernel operators (packages/db/src/seed/kernels.ts). */
export const SEED_OPERATORS = Object.freeze({
  "kernel-nyc": "0x1111111111111111111111111111111111111111",
  "kernel-sf": "0x2222222222222222222222222222222222222222",
  "kernel-la": "0x3333333333333333333333333333333333333333",
});

/**
 * Job reads are object-authorized (readmodels F3): an admin, or a PROVEN wallet (SIWE) that
 * is the job's kernel operator or its recorded buyer (#353 review r3). Route tests that are
 * not about that authorization read as a party: this stands in for the API gate and sets the
 * caller to `principal` (by default the seeded kernel-nyc operator; null sets none). A
 * request can name another caller with an `x-test-principal` header.
 *
 * Like WP-A's gate (#326) for a SIWE session, a wallet principal is also the caller's
 * proven wallet (req.provenWallet). `x-test-proven-wallet` names another one, and
 * `x-test-proven-wallet: none` makes the caller an unproven key.
 */
export function actAsJobParty(app: FastifyInstance, principal: string | null = SEED_OPERATORS["kernel-nyc"]): void {
  app.addHook("onRequest", async (req) => {
    const p = req.headers["x-test-principal"];
    const who = typeof p === "string" ? p : ((req as any).operatorId ?? principal);
    if (who != null) (req as any).operatorId = who;
    (req as any).provenWallet = provenWalletFor(req.headers["x-test-proven-wallet"], who);
  });
}

/** The proven wallet the stand-in gate sets: the named one, none, or the wallet principal. */
export function provenWalletFor(header: unknown, principal: string | null | undefined): string | null {
  const w = typeof header === "string" ? (header === "none" ? null : header) : principal;
  return typeof w === "string" && /^0x[0-9a-fA-F]{40}$/.test(w) ? w.toLowerCase() : null;
}
