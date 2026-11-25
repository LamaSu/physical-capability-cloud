import { sql } from "@pcc/store";
import { getStore } from "../db.js";
import { auditService } from "./audit-service.js";

export const FEATURE_SWITCHES = [
  "key_minting", "signups", "sign_in", "onboard_chat", "device_identify",
  "onboard_analysis", "commentary", "request_planner", "job_submission",
] as const;
export type FeatureName = typeof FEATURE_SWITCHES[number];

const labels = {
  key_minting: "Creating API keys",
  signups: "Sign-up",
  sign_in: "Sign-in",
  onboard_chat: "The onboarding chat",
  device_identify: "Device identification",
  onboard_analysis: "Onboarding analysis",
  commentary: "Live commentary",
  job_submission: "Job submission",
} as const;

/** Every gate reads the store afresh. Only SQLite's integer 1 admits work. */
export function isFeatureEnabled(name: FeatureName): boolean {
  try {
    return getStore().db.get<{ enabled: unknown }>(
      sql`SELECT enabled FROM feature_switches WHERE name = ${name} AND typeof(enabled) = 'integer'`,
    )?.enabled === 1;
  } catch {
    return false;
  }
}

export function featurePaused<Name extends keyof typeof labels>(name: Name) {
  return { error: "feature_paused" as const, feature: name, message: `${labels[name]} is paused.` };
}

/** Unlike the gates, the admin read must report an unavailable store. */
export function listFeatureSwitches() {
  const rows = getStore().db.all<{
    name: string; enabled: unknown; updated_at: string; updated_by: string | null;
  }>(sql`SELECT name, CASE WHEN typeof(enabled) = 'integer' THEN enabled ELSE NULL END AS enabled,
    updated_at, updated_by FROM feature_switches`);
  return FEATURE_SWITCHES.map((name) => {
    const row = rows.find((entry) => entry.name === name);
    return {
      name, enabled: row?.enabled === 1,
      updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null,
    };
  });
}

/** The audit repository shares this connection, so a failed record rolls back the set. */
export function setFeatureSwitch(name: FeatureName, enabled: boolean, actor: string) {
  return getStore().db.transaction((tx) => {
    const from = isFeatureEnabled(name);
    const updatedAt = new Date().toISOString();
    tx.run(sql`INSERT INTO feature_switches (name, enabled, updated_at, updated_by)
      VALUES (${name}, ${enabled ? 1 : 0}, ${updatedAt}, ${actor})
      ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
    if (!auditService.log({
      eventType: "admin.features.set", action: "update", resourceType: "feature_switch",
      resourceId: name, actor, metadata: { from, to: enabled },
    })) throw new Error("Feature switch audit unavailable");
    return { name, enabled, updatedAt, updatedBy: actor };
  });
}
