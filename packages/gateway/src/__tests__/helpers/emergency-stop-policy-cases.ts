import { vi } from "vitest";
import { schema, sql } from "@pcc/store";
import { getStore } from "../../db.js";
import type { EmergencyStopState } from "../../routes/device-relay.js";

export interface PolicyCase {
  label: string;
  state: EmergencyStopState;
  policy?: unknown;
  malformedJSON?: boolean;
  throwingRead?: boolean;
}

export const POLICY_CASES: PolicyCase[] = [
  { label: "no policy row", state: "clear" },
  { label: "absent emergencyStop key", state: "clear", policy: {} },
  { label: "emergencyStop false", state: "clear", policy: { emergencyStop: false } },
  { label: "emergencyStop 0", state: "clear", policy: { emergencyStop: 0 } },
  { label: "emergencyStop null", state: "clear", policy: { emergencyStop: null } },
  { label: "emergencyStop true", state: "stopped", policy: { emergencyStop: true } },
  { label: 'emergencyStop string "true"', state: "stopped", policy: { emergencyStop: "true" } },
  { label: "emergencyStop 1", state: "stopped", policy: { emergencyStop: 1 } },
  { label: 'emergencyStop string "false"', state: "stopped", policy: { emergencyStop: "false" } },
  { label: "null policy", state: "unavailable", policy: null },
  { label: "array policy", state: "unavailable", policy: [] },
  { label: "string policy", state: "unavailable", policy: "policy" },
  { label: "number policy", state: "unavailable", policy: 1 },
  { label: "boolean policy", state: "unavailable", policy: false },
  { label: "unparseable JSON", state: "unavailable", malformedJSON: true },
  { label: "throwing policy read", state: "unavailable", throwingRead: true },
];

export const UNAVAILABLE_POLICY_CASES = POLICY_CASES.filter(({ state }) => state === "unavailable");

/** Make policy unavailable without interfering with authority or job reads. Restore mocks after use. */
export function applyUnavailablePolicy(kernelId: string, policyCase: PolicyCase): void {
  if (policyCase.policy !== undefined || policyCase.malformedJSON) {
    // Bind JSON text so a JS null remains JSON null instead of violating SQL NOT NULL.
    const policyJSON = policyCase.malformedJSON ? "{" : JSON.stringify(policyCase.policy);
    getStore().db.run(sql`INSERT INTO operator_policies (kernel_id, policy, updated_at, updated_by)
      VALUES (${kernelId}, ${policyJSON}, '2026-10-10T12:00:00.000Z', 'unavailable-policy-test')
      ON CONFLICT(kernel_id) DO UPDATE SET policy = excluded.policy,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
  }
  if (policyCase.throwingRead) {
    const { db } = getStore();
    const select = db.select.bind(db);
    vi.spyOn(db, "select").mockImplementation((fields) => {
      const query = select(fields);
      const from = query.from.bind(query);
      vi.spyOn(query, "from").mockImplementation((table) => {
        if (table === schema.operatorPolicies) throw new Error("operator policy read failed");
        return from(table);
      });
      return query;
    });
  }
}
