import type { FastifyInstance } from "fastify";
import { eq, schema } from "@pcc/store";
import { getStore } from "../db.js";
import { bindBuyer } from "../auth/buyer-identity.js";
import { AUTHENTICATION_REQUIRED, authorityOf, isAnonymous } from "../auth/kernel-authority.js";
import { buyerFundingAvailable, fundingPrepareRow, prepareBuyerFunding, prepareRefusalAnswer, prepareRowAnswer } from "../services/buyer-funding-prepare.js";

export async function buyerFundingRoutes(app: FastifyInstance) {
  app.post<{ Params: { scopeId: string } }>("/api/buyer-funding/scopes/:scopeId/prepare", async (req, reply) => {
    if (!buyerFundingAvailable()) {
      const answer = prepareRefusalAnswer("buyer_funding_unavailable");
      return reply.code(answer.status).send(answer.body);
    }
    const authority = authorityOf(req);
    if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
    const scope = getStore().db.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, req.params.scopeId)).get();
    if (!scope) {
      const answer = prepareRefusalAnswer("scope_not_found");
      return reply.code(answer.status).send(answer.body);
    }
    const binding = bindBuyer(authority, scope.createdBy);
    if (!binding.ok) return reply.code(binding.status).send(binding.body);
    const row = fundingPrepareRow(scope.id);
    const result = row ? { kind: "answer" as const, row } : await prepareBuyerFunding(scope.id);
    const answer = result.kind === "answer" ? prepareRowAnswer(result.row, result.atMs ?? Date.now()) : prepareRefusalAnswer(result.code);
    if (answer.contentType) reply.type(answer.contentType);
    return reply.code(answer.status).send(answer.body);
  });

  app.get<{ Params: { scopeId: string } }>("/api/buyer-funding/scopes/:scopeId/prepare", async (req, reply) => {
    if (!buyerFundingAvailable()) {
      const answer = prepareRefusalAnswer("buyer_funding_unavailable");
      return reply.code(answer.status).send(answer.body);
    }
    const authority = authorityOf(req);
    if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
    const scope = getStore().db.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, req.params.scopeId)).get();
    if (!scope) {
      const answer = prepareRefusalAnswer("scope_not_found");
      return reply.code(answer.status).send(answer.body);
    }
    const binding = bindBuyer(authority, scope.createdBy);
    if (!binding.ok) return reply.code(binding.status).send(binding.body);
    const row = fundingPrepareRow(scope.id);
    const answer = row ? prepareRowAnswer(row, Date.now()) : prepareRefusalAnswer("no_prepare");
    if (answer.contentType) reply.type(answer.contentType);
    return reply.code(answer.status).send(answer.body);
  });
}
