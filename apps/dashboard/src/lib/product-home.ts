import { PRODUCT_HOME_SCHEMA_ID, type ProductHomeDTO } from "@pcc/spec";
import { isCount } from "../api/wire-vocabulary.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function heldAmount(value: unknown): boolean {
  return record(value) &&
    typeof value.currency === "string" && value.currency.trim() !== "" &&
    isCount(value.decimals) && value.decimals <= 36 &&
    typeof value.amountBaseUnits === "string" && /^(0|[1-9]\d*)$/.test(value.amountBaseUnits) &&
    isCount(value.milestones);
}

function section(value: unknown, counts: readonly string[], more?: (value: Record<string, unknown>) => boolean): boolean {
  if (!record(value)) return false;
  if (value.state === "unavailable") return typeof value.reason === "string";
  return value.state === "read" && counts.every((name) => isCount(value[name])) && (!more || more(value));
}

/** Malformed replies are unavailable; parsing never supplies figures or a fallback reason. */
export function parseProductHome(body: unknown): ProductHomeDTO | null {
  try {
    if (!record(body) || body.schemaId !== PRODUCT_HOME_SCHEMA_ID || typeof body.asOf !== "string") return null;
    if (!section(body.kernels, ["total", "online", "stale", "other"]) ||
      !section(body.jobs, ["total", "active"]) ||
      !section(body.capabilities, ["total", "onOnlineKernels"])) return null;
    if (!record(body.settlementNetwork) ||
      !(body.settlementNetwork.name === null || typeof body.settlementNetwork.name === "string")) return null;
    if (!section(body.escrowHeld, ["uncountedMilestones", "unclassifiedMilestones", "excludedSimulatedEscrows"], (held) =>
      held.confirmation === "record_only" &&
      Array.isArray(held.byCurrency) && held.byCurrency.every(heldAmount) &&
      record(held.releaseDecided) && held.releaseDecided.bound === "at_most" &&
      Array.isArray(held.releaseDecided.byCurrency) && held.releaseDecided.byCurrency.every(heldAmount))) return null;
    return body as unknown as ProductHomeDTO;
  } catch {
    return null;
  }
}
