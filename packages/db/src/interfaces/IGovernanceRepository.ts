import type { rateLimitPolicies, dlpRules, endpointScopes } from "../schema/index.js";

export type RateLimitPolicyRow = typeof rateLimitPolicies.$inferSelect;
export type RateLimitPolicyInsert = typeof rateLimitPolicies.$inferInsert;
export type DlpRuleRow = typeof dlpRules.$inferSelect;
export type DlpRuleInsert = typeof dlpRules.$inferInsert;
export type EndpointScopeRow = typeof endpointScopes.$inferSelect;
export type EndpointScopeInsert = typeof endpointScopes.$inferInsert;

export interface IGovernanceRepository {
  // Rate limit policies
  findAllPolicies(): RateLimitPolicyRow[];
  findPolicyById(id: string): RateLimitPolicyRow | undefined;
  findPolicyByRoute(routePattern: string): RateLimitPolicyRow | undefined;
  insertPolicy(policy: RateLimitPolicyInsert): RateLimitPolicyRow | undefined;
  updatePolicy(id: string, data: Partial<RateLimitPolicyInsert>): RateLimitPolicyRow | undefined;
  // DLP rules
  findAllDlpRules(): DlpRuleRow[];
  findDlpRuleById(id: string): DlpRuleRow | undefined;
  findDlpRulesByResource(resourceType: string): DlpRuleRow[];
  insertDlpRule(rule: DlpRuleInsert): DlpRuleRow | undefined;
  updateDlpRule(id: string, data: Partial<DlpRuleInsert>): DlpRuleRow | undefined;
  // Endpoint scopes
  findAllEndpointScopes(): EndpointScopeRow[];
  findEndpointScopeById(id: string): EndpointScopeRow | undefined;
  findEndpointScopesByRoute(routePattern: string): EndpointScopeRow[];
  insertEndpointScope(scope: EndpointScopeInsert): EndpointScopeRow | undefined;
  updateEndpointScope(id: string, data: Partial<EndpointScopeInsert>): EndpointScopeRow | undefined;
}
