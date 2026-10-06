/** Capability Kit bindings and the live capacity projected from their current kernel rows. */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AvailabilitySummarySchema,
  MAX_AS_OF_SKEW_MS,
  OPERATOR_BINDING_SCHEMA,
  OperatorBindingDTOSchema,
} from "@pcc/spec";
import { getRepos } from "../db.js";
import { STALE_HEARTBEAT_MS } from "../facades/populators/staleness.js";
import { KitRegistryError, type BindingRead, type KitBindingRecord, type KitRegistry } from "./kit-registry.js";
import { ownsKernel, type OperatorIdentity } from "./operator-identity.js";

type Repos = ReturnType<typeof getRepos>;
type KernelRow = NonNullable<ReturnType<Repos["kernels"]["findById"]>>;
type CapabilityRow = NonNullable<ReturnType<Repos["capabilities"]["findById"]>>;
type KernelPresence = Partial<Pick<KernelRow, "status" | "validUntil">> & { lastHeartbeat?: string | null };
type CapabilityPresence = Partial<Pick<CapabilityRow, "validUntil">>;

// The server has no proven per-kernel assurance tier to raise this cap.
export const KIT_BINDING_ASSURANCE_TIER_CAP = 0 as const;

// These are the kernel schema's non-online statuses plus the lifecycle sweeper's expired status.
const OFFLINE_STATUSES = new Set(["offline", "maintenance", "suspended", "expired"]);

function epoch(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Live presence uses the heartbeat threshold, independently of the catalog's listing grace. */
export function presenceOf(kernel: KernelPresence, capability: CapabilityPresence, now: Date | number): "online" | "offline" | "unknown" {
  const nowMs = epoch(now);
  const kernelExpiry = parsedTime(kernel.validUntil);
  const capabilityExpiry = parsedTime(capability.validUntil);
  if ((kernelExpiry !== null && kernelExpiry < nowMs) || (capabilityExpiry !== null && capabilityExpiry < nowMs) || OFFLINE_STATUSES.has(kernel.status ?? "")) {
    return "offline";
  }
  const heartbeat = parsedTime(kernel.lastHeartbeat);
  if (kernel.status === "online" && heartbeat !== null && nowMs - heartbeat <= STALE_HEARTBEAT_MS && heartbeat - nowMs <= MAX_AS_OF_SKEW_MS) {
    return "online";
  }
  return "unknown";
}

/** The last kernel heartbeat, normalized to ISO, when it is a valid read time. */
export function lastSeenAt(kernel: Pick<KernelPresence, "lastHeartbeat">, now: Date | number): string | null {
  const heartbeat = parsedTime(kernel.lastHeartbeat);
  return heartbeat !== null && heartbeat - epoch(now) <= MAX_AS_OF_SKEW_MS ? new Date(heartbeat).toISOString() : null;
}

function storedObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Availability exposes only the closed summary shape. */
export function availabilityOf(capability: { availability?: unknown }) {
  const stored = storedObject(capability.availability);
  if (!stored || stored.mode === "delegate-to-agent") return null;
  const summary: Record<string, unknown> = {};
  for (const field of ["mode", "windows", "cron", "timezone", "describe"] as const) {
    if (Object.hasOwn(stored, field)) summary[field] = stored[field];
  }
  const result = AvailabilitySummarySchema.safeParse(summary);
  return result.success ? result.data : null;
}

const AmountSchema = z.string().regex(/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?$/);
const RecordedPriceSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3,5}$/),
  baseCost: AmountSchema,
  minimum: AmountSchema,
  perMinute: AmountSchema.optional(),
  perGram: AmountSchema.optional(),
  perCm3: AmountSchema.optional(),
}).strict();

/** List prices preserve recorded decimal strings and never supply a missing amount. */
export function listPriceOf(capability: { pricing?: unknown }) {
  const result = RecordedPriceSchema.safeParse(storedObject(capability.pricing));
  return result.success ? { basis: "capability_record" as const, ...result.data } : null;
}

const BindBodySchema = z.object({
  csdUrl: z.string().min(1),
  kernelId: z.string().min(1).max(200),
  capabilityId: z.string().min(1).max(200),
}).strict();
const WithdrawBodySchema = z.object({}).strict();
const QueryIntegerSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number);
const HostsQuerySchema = z.object({
  presence: z.enum(["online", "any"]).default("any"),
  limit: QueryIntegerSchema.pipe(z.number().int().min(1).max(100)).default("50"),
  offset: QueryIntegerSchema.pipe(z.number().int().min(0).max(10_000)).default("0"),
}).strict();

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Each active tuple contributes its earliest immutable binding. */
export function deduplicateBindings(entries: readonly BindingRead[]): KitBindingRecord[] {
  const tuples = new Map<string, KitBindingRecord>();
  const active = entries.filter((entry) => entry.withdrawal === null).map((entry) => entry.binding)
    .sort((a, b) => Date.parse(a.boundAt) - Date.parse(b.boundAt) || compareText(a.bindingId, b.bindingId));
  for (const binding of active) {
    const key = JSON.stringify([binding.kitDigest, binding.csdUrl, binding.target.kernelId, binding.target.capabilityId]);
    if (!tuples.has(key)) tuples.set(key, binding);
  }
  return [...tuples.values()];
}

function publicBinding(binding: KitBindingRecord) {
  const { boundBy: _boundBy, ...view } = binding;
  return view;
}

function principalHash(identity: OperatorIdentity): string {
  return createHash("sha256").update(identity.principal).digest("hex");
}

export class KitBindings {
  constructor(private readonly registry: KitRegistry, private readonly now: () => Date = () => registry.timestamp()) {}

  /** Bind a current owned capability to one CSD named by a published kit. */
  async bind(digest: string, body: unknown, identity: OperatorIdentity) {
    const kit = await this.registry.get(digest);
    const parsed = BindBodySchema.safeParse(body);
    if (!parsed.success) throw new KitRegistryError("invalid_body", 400, "a binding requires only csdUrl, kernelId and capabilityId");
    if (!kit) throw new KitRegistryError("kit_not_found", 404, "no published kit has that digest");
    const { csdUrl, kernelId, capabilityId } = parsed.data;
    if (!kit.manifest.capabilities.some((capability) => capability.csdUrl === csdUrl)) {
      throw new KitRegistryError("csd_not_in_kit", 422, "the CSD is not included in this kit");
    }
    const repos = getRepos();
    const kernel = repos.kernels.findById(kernelId);
    if (!kernel) throw new KitRegistryError("kernel_not_found", 404, "the kernel does not exist");
    if (!ownsKernel(identity, kernel)) throw new KitRegistryError("not_kernel_owner", 403, "only the current kernel owner may bind it");
    const capability = repos.capabilities.findById(capabilityId);
    if (!capability || capability.kernelId !== kernelId) {
      throw new KitRegistryError("capability_not_on_kernel", 422, "the capability does not belong to this kernel");
    }
    const existing = deduplicateBindings(await this.registry.listBindings({ kitDigest: digest, kernelIds: [kernelId] }))
      .find((binding) => binding.csdUrl === csdUrl && binding.target.capabilityId === capabilityId);
    if (existing) return { binding: publicBinding(existing), created: false };
    await this.registry.claimBindQuota(identity.principal, this.now());
    const binding = await this.registry.createBinding({
      kitDigest: digest,
      csdUrl,
      target: { kind: "kernel", kernelId, capabilityId },
      identityStatus: identity.identityStatus,
      boundBy: principalHash(identity),
    });
    this.registry.auditBinding({
      eventType: "kit.bound", actor: identity.principal, resourceType: "kit-binding", resourceId: binding.bindingId,
      action: "bind", metadata: { kitDigest: digest, kernelId, capabilityId, csdUrl, identityStatus: identity.identityStatus },
    });
    return { binding: publicBinding(binding), created: true };
  }

  /** Withdrawal uses current kernel ownership and preserves the first withdrawal time. */
  async withdraw(digest: string, bindingId: string, body: unknown, identity: OperatorIdentity) {
    if (body !== undefined && !WithdrawBodySchema.safeParse(body).success) {
      throw new KitRegistryError("invalid_body", 400, "withdrawal accepts an empty body only");
    }
    const entry = await this.registry.readBinding(bindingId);
    if (!entry || entry.binding.kitDigest !== digest) throw new KitRegistryError("binding_not_found", 404, "no binding has that id for this kit");
    const kernel = getRepos().kernels.findById(entry.binding.target.kernelId);
    if (!kernel || !ownsKernel(identity, kernel)) throw new KitRegistryError("not_kernel_owner", 403, "only the current kernel owner may withdraw it");
    const { record, created } = await this.registry.withdrawBinding({ bindingId, identityStatus: identity.identityStatus, withdrawnBy: principalHash(identity) });
    if (created) {
      const binding = entry.binding;
      this.registry.auditBinding({
        eventType: "kit.unbound", actor: identity.principal, resourceType: "kit-binding", resourceId: bindingId,
        action: "unbind", metadata: { kitDigest: digest, kernelId: binding.target.kernelId, capabilityId: binding.target.capabilityId, csdUrl: binding.csdUrl, identityStatus: identity.identityStatus },
      });
    }
    return { bindingId, withdrawnAt: record.withdrawnAt, created };
  }

  private async liveBindings(filter: { kitDigest?: string; kernelIds?: string[] }) {
    const bindings = deduplicateBindings(await this.registry.listBindings(filter));
    const repos = getRepos();
    const kernels = new Map(repos.kernels.findByIds([...new Set(bindings.map((binding) => binding.target.kernelId))]).map((kernel) => [kernel.id, kernel]));
    const capabilities = new Map(repos.capabilities.findByIds([...new Set(bindings.map((binding) => binding.target.capabilityId))]).map((capability) => [capability.id, capability]));
    return bindings.flatMap((binding) => {
      const kernel = kernels.get(binding.target.kernelId);
      const capability = capabilities.get(binding.target.capabilityId);
      return kernel && capability && capability.kernelId === kernel.id ? [{ binding, kernel, capability }] : [];
    });
  }

  /** Buyer-facing live hosts contain capacity summaries and no ownership fields. */
  async hosts(digest: string, query: unknown) {
    const parsed = HostsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new KitRegistryError("invalid_query", 400, "presence, limit or offset is invalid");
    if (!await this.registry.get(digest)) throw new KitRegistryError("kit_not_found", 404, "no published kit has that digest");
    const now = this.now();
    const ranks = { online: 0, unknown: 1, offline: 2 };
    const hosts = (await this.liveBindings({ kitDigest: digest })).map(({ binding, kernel, capability }) => ({
      bindingId: binding.bindingId,
      csdUrl: binding.csdUrl,
      kernelId: kernel.id,
      capabilityId: capability.id,
      identityStatus: binding.identityStatus,
      presence: presenceOf(kernel, capability, now),
      lastSeenAt: lastSeenAt(kernel, now),
      availability: availabilityOf(capability),
      listPrice: listPriceOf(capability),
      assuranceTierCap: KIT_BINDING_ASSURANCE_TIER_CAP,
      boundAt: binding.boundAt,
    })).filter((host) => parsed.data.presence === "any" || host.presence === "online")
      .sort((a, b) => ranks[a.presence] - ranks[b.presence]
        || (a.lastSeenAt === null ? (b.lastSeenAt === null ? 0 : 1) : b.lastSeenAt === null ? -1 : Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
        || compareText(a.bindingId, b.bindingId));
    return { kitDigest: digest, asOf: now.toISOString(), total: hosts.length, hosts: hosts.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit) };
  }

  /** The operator's current owned kernels determine binding and execution views. */
  async operatorBinding(identity: OperatorIdentity) {
    const repos = getRepos();
    // Current ownership is filtered by a scan of the kernel repository.
    const kernels = repos.kernels.findAll().filter((kernel) => ownsKernel(identity, kernel));
    const now = this.now();
    const active = await this.liveBindings({ kernelIds: kernels.map((kernel) => kernel.id) });
    const bindings = active.map(({ binding, kernel, capability }) => ({
      kind: "kernel" as const,
      id: kernel.id,
      capabilityType: binding.csdUrl,
      kitDigest: binding.kitDigest,
      presence: presenceOf(kernel, capability, now),
      availability: availabilityOf(capability),
      assuranceTierCap: KIT_BINDING_ASSURANCE_TIER_CAP,
      lastSeenAt: lastSeenAt(kernel, now),
    }));
    const mapped = new Set(active.map(({ capability }) => capability.id));
    const unmappedCapacity = kernels.flatMap((kernel) => repos.capabilities.findByKernel(kernel.id)
      .filter((capability) => !mapped.has(capability.id))
      .map((capability) => ({ kind: "kernel" as const, id: kernel.id, legacyType: capability.type }))).slice(0, 500);
    const result = OperatorBindingDTOSchema.safeParse({
      schema: OPERATOR_BINDING_SCHEMA,
      principal: { operatorId: identity.principal, identityStatus: identity.identityStatus },
      executorKinds: kernels.length > 0 ? ["machine"] : [],
      bindings,
      unmappedCapacity,
      // The server has no payout-destination store yet (N21).
      payee: null,
      moneyAuthority: "none",
      executionAuthority: { canClaimCapabilityTypes: [...new Set(bindings.map((binding) => binding.capabilityType))] },
      asOf: now.toISOString(),
    });
    if (!result.success) throw new KitRegistryError("binding_projection_invalid", 500, "the operator binding projection failed validation");
    return result.data;
  }
}
