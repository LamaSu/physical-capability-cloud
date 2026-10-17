import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { findSelfLinkedWallet } from "./repository.js";

declare module "fastify" {
  interface FastifyRequest {
    provenWallet?: string | null;
    provenWalletVia?: string | null;
  }
}

async function bindProof(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (typeof req.provenWallet === "string" && req.provenWallet.length > 0) return;
  if (!req.apiKeyId || !req.operatorId) return;
  const address = req.headers["x-pcc-wallet"];
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return;
  let occurrences = 0;
  for (let i = 0; i < req.raw.rawHeaders.length; i += 2) {
    if (req.raw.rawHeaders[i]?.toLowerCase() === "x-pcc-wallet") occurrences++;
  }
  if (occurrences !== 1) return;
  try {
    const role = findSelfLinkedWallet({ address, apiKeyId: req.apiKeyId, operatorId: req.operatorId, now: Date.now() });
    if (role !== null) {
      req.provenWallet = address.toLowerCase();
      req.provenWalletVia = `self-link:${role}`;
    }
  } catch {
    await reply.code(503).send({ error: "wallet_link_unavailable" });
  }
}

export function proveSelfLinkedWallet(req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  if (req.headers["x-admin-key"] !== undefined || req.headers["x-pcc-wallet"] === undefined) {
    done();
    return;
  }
  void bindProof(req, reply).then(() => done(), done);
}
