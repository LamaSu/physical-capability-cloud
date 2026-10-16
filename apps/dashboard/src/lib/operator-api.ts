import type { ShopKernel } from "@pcc/spec";
import { authorizedFetch } from "./authorized-fetch.js";

// The controls only need these fields from a validated /api/agent/me answer.
export type OperatorMachine = Pick<ShopKernel, "id" | "name">;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OWNER_PROOF_REQUIRED = "requires owner proof (SIWE sign-in, a session key, or a linked wallet)";

/** Distinguish a withheld agent/me answer requiring owner proof. */
export function kernelsOf(me: unknown): OperatorMachine[] | "withheld" | "unavailable" {
  if (!record(me) || me.ok !== true || !record(me.kernels)) return "unavailable";
  const kernels = me.kernels;
  if (kernels.count === null && Array.isArray(kernels.items) && kernels.items.length === 0 &&
      kernels.unavailable === OWNER_PROOF_REQUIRED &&
      Object.keys(kernels).every((key) => ["count", "items", "unavailable"].includes(key))) return "withheld";
  if (Object.keys(kernels).some((key) => key !== "count" && key !== "items") ||
      !Number.isInteger(kernels.count) || !Array.isArray(kernels.items) ||
      kernels.count !== kernels.items.length) return "unavailable";

  const ids = new Set<string>();
  const machines: OperatorMachine[] = [];
  for (const item of kernels.items) {
    if (!record(item) ||
        Object.keys(item).some((key) => !["id", "name", "status", "last_heartbeat"].includes(key)) ||
        typeof item.id !== "string" || !item.id.trim() || ids.has(item.id) ||
        ("name" in item && typeof item.name !== "string") ||
        ("status" in item && typeof item.status !== "string") ||
        (item.last_heartbeat !== null && typeof item.last_heartbeat !== "string")) return "unavailable";
    ids.add(item.id);
    machines.push({ id: item.id, name: typeof item.name === "string" ? item.name : "" });
  }
  return machines;
}

export function machineLabel(machine: OperatorMachine): string {
  return machine.name.trim() ? machine.name : machine.id;
}

type EmergencyResult = { ok: boolean; error: string | null };

/** A stop is confirmed only by a 2xx and stopped:true for the exact requested machine. */
export async function emergencyStop(machine: OperatorMachine): Promise<EmergencyResult> {
  const label = machineLabel(machine);
  const failureMessage = `The stop didn't go through. ${label} may still be running: use the machine's physical emergency stop, then try again.`;
  try {
    const res = await authorizedFetch("/api/operator/emergency-stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kernelId: machine.id }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.stopped === true && body?.kernelId === machine.id) {
      return { ok: true, error: null };
    }
    return { ok: false, error: res.ok
      ? `The server didn't confirm the stop for ${label}. The machine may still be running: use its physical emergency stop.`
      : res.status === 401
        ? `Sign in to stop ${label}. Until then, use the machine's physical emergency stop.`
        : res.status === 403
          ? `The stop was refused for this key. ${label} may still be running: use the machine's physical emergency stop.`
          : failureMessage };
  } catch {
    return { ok: false, error: failureMessage };
  }
}

/** Preserve PR-1's rule: only a 2xx changes the machine's confirmed stopped state. */
export async function emergencyResume(machine: OperatorMachine): Promise<EmergencyResult> {
  const label = machineLabel(machine);
  const failureMessage = `Resume didn't go through. ${label} is still stopped; try again.`;
  try {
    const res = await authorizedFetch("/api/operator/emergency-resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kernelId: machine.id }),
    });
    if (res.ok) return { ok: true, error: null };
    return { ok: false, error: res.status === 403
      ? `Resume was refused for ${label} with this key. A wallet sign-in can stop a kernel but can't resume it yet: ask a PCC admin to resume it, or resume through the API with your PCC-issued key and your self-linked wallet (X-PCC-Wallet header).`
      : res.status === 401
        ? `Sign in to resume ${label}.`
        : res.status === 404
          ? `${label} or its policy wasn't found, so it can't be resumed here.`
          : failureMessage };
  } catch {
    return { ok: false, error: failureMessage };
  }
}
