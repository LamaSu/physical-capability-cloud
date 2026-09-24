/**
 * GET /api/product/home (readmodels #409): the platform-wide facts the
 * StatusBar and Command Center show, each counted by the gateway over its own
 * records. The client never counts a partial page or sums display strings.
 *
 * Each section is either read or unavailable with a reason. An unavailable
 * section renders its reason, never a 0. An answer that isn't a ProductHomeDTO
 * is a failed read.
 */

import { PRODUCT_HOME_SCHEMA_ID, type ProductHomeDTO, type ProductHomeSectionError } from "@pcc/spec";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isHeldAmount(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.currency === "string" &&
    isCount(value.decimals) &&
    typeof value.amountBaseUnits === "string" &&
    /^\d+$/.test(value.amountBaseUnits) &&
    isCount(value.milestones)
  );
}

/** A section is well formed if it is unavailable with a reason, or read with every count it claims. */
function isSection(value: unknown, counts: readonly string[], extra?: (s: Record<string, unknown>) => boolean): boolean {
  if (!isRecord(value)) return false;
  if (value.state === "unavailable") return typeof value.reason === "string";
  return value.state === "read" && counts.every((k) => isCount(value[k])) && (extra ? extra(value) : true);
}

export function parseProductHome(body: unknown): ProductHomeDTO {
  const network = isRecord(body) ? body.settlementNetwork : undefined;
  const ok =
    isRecord(body) &&
    body.schemaId === PRODUCT_HOME_SCHEMA_ID &&
    typeof body.asOf === "string" &&
    isSection(body.kernels, ["total", "online", "stale", "other"]) &&
    isSection(body.jobs, ["total", "active"]) &&
    isSection(body.capabilities, ["total", "onOnlineKernels"]) &&
    isSection(
      body.escrowHeld,
      ["uncountedMilestones", "unclassifiedMilestones", "excludedSimulatedEscrows"],
      (s) => Array.isArray(s.byCurrency) && s.byCurrency.every(isHeldAmount),
    ) &&
    isRecord(network) &&
    (network.name === null || typeof network.name === "string");
  if (!ok) throw new Error("Unexpected response from /api/product/home");
  return body as unknown as ProductHomeDTO;
}

/** The section when the gateway read it; otherwise null. */
export function readSection<T extends { state: "read" }>(section: T | ProductHomeSectionError | undefined): T | null {
  return section && section.state === "read" ? section : null;
}

/** Why a section is unavailable, or null when it was read. */
export function sectionReason(section: { state: string } | undefined): string | null {
  return section && section.state === "unavailable" ? (section as ProductHomeSectionError).reason : null;
}

/** The configured settlement network, labelled as configuration: it is not proof any escrow lives there. */
export function configuredNetworkLabel(home: ProductHomeDTO | undefined): string | undefined {
  const name = home?.settlementNetwork.name;
  return name ? `${name} (configured)` : undefined;
}
