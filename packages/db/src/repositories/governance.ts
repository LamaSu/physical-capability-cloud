import { eq, like } from "drizzle-orm";
import { rateLimitPolicies, dlpRules, endpointScopes } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IGovernanceRepository } from "../interfaces/IGovernanceRepository.js";

export class GovernanceRepository implements IGovernanceRepository {
  constructor(private db: StoreDB) {}

  // ── Rate Limit Policies ─────────────────────────────────────────

  findAllPolicies() {
    return this.db.select().from(rateLimitPolicies).all();
  }

  findPolicyById(id: string) {
    return this.db.select().from(rateLimitPolicies).where(eq(rateLimitPolicies.id, id)).get();
  }

  findPolicyByRoute(routePattern: string) {
    return this.db.select().from(rateLimitPolicies).where(eq(rateLimitPolicies.routePattern, routePattern)).get();
  }

  insertPolicy(policy: typeof rateLimitPolicies.$inferInsert) {
    return this.db.insert(rateLimitPolicies).values(policy).returning().get();
  }

  updatePolicy(id: string, data: Partial<typeof rateLimitPolicies.$inferInsert>) {
    return this.db.update(rateLimitPolicies).set(data).where(eq(rateLimitPolicies.id, id)).returning().get();
  }

  // ── DLP Rules ───────────────────────────────────────────────────

  findAllDlpRules() {
    return this.db.select().from(dlpRules).all();
  }

  findDlpRuleById(id: string) {
    return this.db.select().from(dlpRules).where(eq(dlpRules.id, id)).get();
  }

  findDlpRulesByResource(resourceType: string) {
    return this.db.select().from(dlpRules).where(eq(dlpRules.resourceType, resourceType)).all();
  }

  insertDlpRule(rule: typeof dlpRules.$inferInsert) {
    return this.db.insert(dlpRules).values(rule).returning().get();
  }

  updateDlpRule(id: string, data: Partial<typeof dlpRules.$inferInsert>) {
    return this.db.update(dlpRules).set(data).where(eq(dlpRules.id, id)).returning().get();
  }

  // ── Endpoint Scopes ─────────────────────────────────────────────

  findAllEndpointScopes() {
    return this.db.select().from(endpointScopes).all();
  }

  findEndpointScopeById(id: string) {
    return this.db.select().from(endpointScopes).where(eq(endpointScopes.id, id)).get();
  }

  findEndpointScopesByRoute(routePattern: string) {
    return this.db.select().from(endpointScopes).where(like(endpointScopes.routePattern, `%${routePattern}%`)).all();
  }

  insertEndpointScope(scope: typeof endpointScopes.$inferInsert) {
    return this.db.insert(endpointScopes).values(scope).returning().get();
  }

  updateEndpointScope(id: string, data: Partial<typeof endpointScopes.$inferInsert>) {
    return this.db.update(endpointScopes).set(data).where(eq(endpointScopes.id, id)).returning().get();
  }
}
