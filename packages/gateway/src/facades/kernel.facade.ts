/**
 * Kernel Facade — Shop Kernel registration, heartbeat, and health management.
 *
 * Maps to L1.1 (Kernel Registry) in the standards taxonomy.
 * Replaces inline DB access in routes/kernels.ts with standardized
 * populator-based DTOs.
 */

import crypto from "node:crypto";
import { recoverMessageAddress } from "viem";
import { kernelSigningProofMessage } from "@pcc/kernel";
import { type Result, type RegisteredSigner, ok, err, Errors } from "@pcc/spec";
import { verifyEd25519Signature, normalizePublicKeyHex } from "../auth/ed25519.js";
import { BaseFacade } from "./base.facade.js";
import type {
  KernelDTO,
  KernelHealthSnapshot,
  DeviceStatusDTO,
  JobDTO,
  PopulationContext,
  AgentRole,
} from "./types.js";
import {
  populateKernelDTO,
  populateKernelHealthSnapshot,
  populateKernelList,
  type RawKernel,
} from "./populators/kernel.populator.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";

// ── Input interfaces ────────────────────────────────────────────────────────

export interface KernelFilters {
  status?: string;
}

export interface CreateKernelInput {
  id?: string;
  name?: string;
  operatorAddress?: string;
  /**
   * Location. Two accepted shapes (both persisted to their respective columns):
   *   1. `{ lat, lng }` object — geo-coordinates persisted to the `location` column
   *      (used by the dashboard map + by-location queries)
   *   2. `string` — freeform postal address, persisted to `physicalAddress` only
   *      (legacy alias kept for older onboarding flows)
   * Both can be sent together; they populate different DB columns.
   */
  location?: string | { lat: number; lng: number };
  physicalAddress?: string;
  /**
   * Maximum assurance tier the operator claims they can sustain (0-3).
   * Submitted value is persisted as-is — no silent override. Defaults to 2
   * when omitted (most operators support tier 0/1/2 evidence by default).
   */
  maxAssuranceTier?: 0 | 1 | 2 | 3;
  /**
   * The kernel's claimed secp256k1 signing address (checksummed 0x…). This is
   * the address that signs the kernel's machine-log entries. It is persisted
   * ONLY when accompanied by a valid `signingProof` that recovers to it —
   * otherwise it is ignored and `signingAddress` stays null (fail closed).
   *
   * secp256k1 is the DEFAULT lane: a body with `signingAddress`+`signingProof`
   * and NO `signingKeyAlgorithm` is verified as secp256k1 (unchanged from #230).
   */
  signingAddress?: string;
  /**
   * Proof-of-possession signature over the kernelId-bound challenge
   * `kernelSigningProofMessage(id)` = `pcc-kernel-signing-key:${id}`. Same
   * challenge for both algorithms — only the verification differs:
   *   - secp256k1 (default): EIP-191 signature; the gateway recovers the signer
   *     and persists `signingAddress` only if it matches the claimed address.
   *   - ed25519 (`signingKeyAlgorithm:"ed25519"`): a 128-hex raw detached
   *     signature verified against `signingPublicKey` with node:crypto.
   * The binding to the kernelId means a proof captured for one kernel cannot
   * register another kernel's key.
   */
  signingProof?: string;
  /**
   * Option C — the signing-key algorithm the proof is for. Omit (or "secp256k1")
   * for the default EVM-address lane. Set to "ed25519" to prove a raw Ed25519
   * signing key (the native key of pcc-node / kernel-sdk devices) via
   * `signingPublicKey` + a 128-hex `signingProof`.
   */
  signingKeyAlgorithm?: "secp256k1" | "ed25519";
  /**
   * The kernel's claimed Ed25519 signing public key ("0x"+64hex, raw 32-byte
   * pubkey). Required when `signingKeyAlgorithm === "ed25519"`. Persisted to
   * `signingKey` (and `signingKeyPublicKey`) ONLY when `signingProof` verifies
   * against it over the kernelId-bound challenge — otherwise ignored (fail
   * closed). For secp256k1 kernels this is null and the identity is
   * `signingAddress`.
   */
  signingPublicKey?: string;
}

export interface HeartbeatInput {
  status?: string;
  capabilities?: Array<Record<string, unknown>>;
  timestamp?: number;
}

export interface HeartbeatResult {
  acknowledged: true;
  kernelId: string;
  status: string;
  capabilitiesReceived: number;
  timestamp: string;
  /** ISO timestamp the kernel + its capabilities are valid until. */
  validUntil: string;
  /** True if the heartbeat resurrected a previously expired kernel. */
  resurrected: boolean;
  /** Seconds since the prior heartbeat (null on first heartbeat). */
  sinceLastHeartbeatSec: number | null;
}

/**
 * Kernel + capability TTL configuration. Reads from env at module load.
 *
 *   KERNEL_TTL_HOURS — default 24, clamped to [6, 168] (1 week max).
 *
 * Anything outside the band falls back to the default with a console
 * warning so a misconfigured deploy doesn't silently DoS the catalog by
 * setting TTL=0 or TTL=10000.
 */
const KERNEL_TTL_LOWER_BOUND_HOURS = 6;
const KERNEL_TTL_UPPER_BOUND_HOURS = 168;
const KERNEL_TTL_DEFAULT_HOURS = 24;

export function resolveKernelTtlHours(): number {
  const raw = process.env.KERNEL_TTL_HOURS;
  if (!raw) return KERNEL_TTL_DEFAULT_HOURS;
  const parsed = parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    parsed < KERNEL_TTL_LOWER_BOUND_HOURS ||
    parsed > KERNEL_TTL_UPPER_BOUND_HOURS
  ) {
    console.warn(
      `[kernel-ttl] KERNEL_TTL_HOURS="${raw}" out of band [${KERNEL_TTL_LOWER_BOUND_HOURS},${KERNEL_TTL_UPPER_BOUND_HOURS}]; using ${KERNEL_TTL_DEFAULT_HOURS}`,
    );
    return KERNEL_TTL_DEFAULT_HOURS;
  }
  return parsed;
}

/** Returns the ISO timestamp for `now + KERNEL_TTL_HOURS`. */
export function computeValidUntilIso(now: Date = new Date()): string {
  const ttlMs = resolveKernelTtlHours() * 3600 * 1000;
  return new Date(now.getTime() + ttlMs).toISOString();
}

export interface CapabilityAnnouncementInput {
  capabilities?: Array<Record<string, unknown>>;
  devices?: string[];
  signature?: string;
}

export interface AnnouncementResult {
  acknowledged: true;
  kernelId: string;
  capabilitiesReceived: number;
  devicesReceived: number;
  timestamp: string;
}

// ── Facade ─────────────────────────────────────────────────────────────────

export class KernelFacade extends BaseFacade {
  protected readonly allowedRoles: readonly AgentRole[] = [
    "discovery",
    "execution",
    "operator",
    "admin",
  ];

  constructor() {
    super("kernel");
  }

  /**
   * List all kernels with staleness detection and capability type enrichment.
   * Replaces: GET /api/kernels
   */
  async list(
    filters?: KernelFilters,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<KernelDTO[]>> {
    return this.execute("list", async () => {
      const context = this.defaultContext(ctx);

      const kernels = filters?.status
        ? this.repos.kernels.findByStatus(filters.status)
        : this.repos.kernels.findAll();

      // Batch-load all capabilities for these kernels (prevents N+1)
      const capabilityMap = this.buildCapabilityMap(kernels.map((k) => k.id));

      return populateKernelList(kernels as any as RawKernel[], capabilityMap, context);
    });
  }

  /**
   * Get a single kernel by ID with full health snapshot (devices + recent jobs).
   * Replaces: GET /api/kernels/:kernelId
   */
  async getById(
    kernelId: string,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<KernelHealthSnapshot>> {
    return this.execute("getById", async () => {
      const context = this.defaultContext({ includeReputation: true, ...ctx });

      const kernel = this.repos.kernels.findById(kernelId);
      if (!kernel) {
        throw new NotFoundError("kernel", kernelId);
      }

      const capabilities = this.repos.capabilities.findByKernel(kernelId);
      const devices = this.repos.kernels.findDevicesByKernel(kernelId);
      const recentJobs = this.repos.jobs.findByKernel(kernelId);

      if (context.includeReputation && kernel) {
        context.reputationCache = new Map([[kernel.id, kernel.reputation ?? 500]]);
      }

      return populateKernelHealthSnapshot(
        kernel as any as RawKernel,
        capabilities,
        devices as any[],
        recentJobs as any[],
        context,
      );
    });
  }

  /**
   * Get devices for a kernel.
   * Replaces: GET /api/kernels/:kernelId/devices
   */
  async getDevices(kernelId: string): Promise<Result<DeviceStatusDTO[]>> {
    return this.execute("getDevices", async () => {
      const raw = this.repos.kernels.findDevicesByKernel(kernelId);
      return raw.map((d: any) => ({
        id: d.id,
        type: d.type,
        model: d.model,
        status: (d.status ?? "offline") as DeviceStatusDTO["status"],
        healthStatus: (d.healthStatus ?? "unknown") as DeviceStatusDTO["healthStatus"],
        adapterType: d.adapterType ?? undefined,
        capabilities: d.capabilities ?? d.contributesToCapabilities ?? [],
      }));
    });
  }

  /**
   * Get jobs for a kernel.
   * Replaces: GET /api/kernels/:kernelId/jobs
   */
  async getJobs(kernelId: string): Promise<Result<JobDTO[]>> {
    return this.execute("getJobs", async () => {
      const jobs = this.repos.jobs.findByKernel(kernelId);
      const kernel = this.repos.kernels.findById(kernelId);

      return jobs.map((job: any) => ({
        id: job.id,
        capabilityId: job.capabilityId,
        kernelId: job.kernelId,
        status: job.status as JobDTO["status"],
        progress: job.progress ?? undefined,
        assuranceTier: 0 as JobDTO["assuranceTier"],
        createdAt: job.startedAt ?? new Date().toISOString(),
        updatedAt: job.completedAt ?? undefined,
        kernelName: kernel?.name,
        capabilityType: undefined,
        evidenceCount: 0,
        escrowStatus: undefined,
        estimatedCompletion: undefined,
      }));
    });
  }

  /**
   * Register (upsert) a kernel.
   * Returns created: true on first creation, created: false on update.
   * Replaces: POST /api/kernels
   */
  async register(
    body: CreateKernelInput,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Result<{ kernel: KernelDTO; created: boolean }>> {
    return this.execute("register", async () => {
      const repos = this.repos;
      const id = body.id || `kernel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const context = this.defaultContext();

      const existing = repos.kernels.findById(id);
      if (existing) {
        // Upsert: update heartbeat + optional fields
        const updates: Record<string, unknown> = {
          lastHeartbeat: new Date().toISOString(),
          status: "online",
        };
        if (body.name) updates.name = body.name;
        // Upsert: physicalAddress accepts the literal string OR the legacy string
        // form of `location`. Object location goes to the `location` column below.
        if (body.physicalAddress) {
          updates.physicalAddress = body.physicalAddress;
        } else if (typeof body.location === "string" && body.location.length > 0) {
          updates.physicalAddress = body.location;
        }
        if (typeof body.location === "object" && body.location !== null) {
          const loc = body.location as { lat?: number; lng?: number };
          if (typeof loc.lat === "number" && typeof loc.lng === "number") {
            updates.location = { lat: loc.lat, lng: loc.lng };
          }
        }
        if (typeof body.maxAssuranceTier === "number") {
          updates.maxAssuranceTier = body.maxAssuranceTier;
        }
        // Signing-key proof: SET-ONCE on the money path. Bind a proven signer
        // only if this kernel has none yet — in EITHER family. A generic upsert
        // must never silently OVERWRITE an already-registered settlement signer
        // — key rotation is a dedicated, owner-authenticated operation
        // (follow-up). Fail closed: absent/mismatched proof leaves the existing
        // value intact. "Already proven" = a tag is set (secp256k1 or ed25519)
        // OR a legacy #230 row already carries signingAddress.
        const existingSigner = existing as {
          signingAddress?: string | null;
          signingKeyAlgorithm?: string | null;
        };
        const alreadyProven =
          Boolean(existingSigner.signingKeyAlgorithm) ||
          Boolean(existingSigner.signingAddress);
        if (!alreadyProven) {
          const provenSigner = await this.verifySigningProof(id, body);
          if (provenSigner) {
            const cols = this.signerToColumns(provenSigner);
            updates.signingAddress = cols.signingAddress;
            updates.signingKeyAlgorithm = cols.signingKeyAlgorithm;
            updates.signingKeyPublicKey = cols.signingKeyPublicKey;
          }
        }
        const updated = repos.kernels.update(id, updates);
        const kernel = updated ?? existing;
        const capabilities = repos.capabilities.findByKernel(id);
        return {
          kernel: populateKernelDTO(kernel as any as RawKernel, capabilities, context),
          created: false,
        };
      }

      // Location: accept either { lat, lng } object (geo) OR a string (address)
      // OR both. Object goes to `location`, string goes to `physicalAddress`.
      // Fix for coord task a8207dfa: previously hardcoded { lat: 0, lng: 0 }
      // regardless of input, silently dropping any submitted coordinates.
      let geoLocation: { lat: number; lng: number } = { lat: 0, lng: 0 };
      let addressString = body.physicalAddress ?? "";
      if (typeof body.location === "object" && body.location !== null) {
        const loc = body.location as { lat?: number; lng?: number };
        if (typeof loc.lat === "number" && typeof loc.lng === "number") {
          geoLocation = { lat: loc.lat, lng: loc.lng };
        }
      } else if (typeof body.location === "string" && body.location.length > 0) {
        // Legacy alias: string location populates physicalAddress only.
        addressString = addressString || body.location;
      }

      // Proof-of-possession: verify the kernel's signing-key proof and resolve
      // the tagged RegisteredSigner. Only a key cryptographically proven by a
      // matching signature over the kernelId-bound challenge is persisted;
      // absent / mismatched / malformed proof → null in every signing column
      // (never persist an unproven signer, which could otherwise clear
      // settlement for forged machine logs). Supports both secp256k1 (EVM
      // address) and ed25519 (raw pubkey) via the algorithm tag.
      const provenSigner = await this.verifySigningProof(id, body);
      const signerColumns = this.signerToColumns(provenSigner);

      const now = new Date();
      const kernelData = {
        id,
        name: body.name || "New Kernel",
        operatorAddress: body.operatorAddress || "0x0000000000000000000000000000000000000000",
        // Legacy random field (not used for auth); kept for the NOT NULL column.
        // The authenticated identity is the tagged signing key below.
        publicKey: `0x${crypto.randomBytes(32).toString("hex")}`,
        signingAddress: signerColumns.signingAddress,
        signingKeyAlgorithm: signerColumns.signingKeyAlgorithm,
        signingKeyPublicKey: signerColumns.signingKeyPublicKey,
        location: geoLocation,
        physicalAddress: addressString,
        status: "online",
        registeredAt: now.toISOString(),
        lastHeartbeat: now.toISOString(),
        version: "0.1.0",
        reputation: 0,
        totalJobsCompleted: 0,
        // Fix for coord task c6b48ca1: respect the operator's submitted tier
        // instead of hardcoding 2. Default to 2 when omitted (most operators
        // sustain tier 0/1/2 evidence by default).
        maxAssuranceTier: body.maxAssuranceTier ?? 2,
        // feat/ed25519-keys-and-kernel-ttl — set initial soft expiry.
        // Without this, a registered-but-never-heartbeated kernel would
        // never appear in default listings (sweeper would mark expired
        // on its first run). One heartbeat extends to now + TTL.
        validUntil: computeValidUntilIso(now),
      };

      const inserted = repos.kernels.insert(kernelData);

      trackServerEvent(
        "kernel_registered",
        { kernelId: id, name: kernelData.name, operatorAddress: kernelData.operatorAddress },
        actorId,
      );
      auditService.log({
        eventType: "kernel.created",
        actor: actorId ?? kernelData.operatorAddress,
        resourceType: "kernel",
        resourceId: id,
        action: "create",
        metadata: { name: kernelData.name, operatorAddress: kernelData.operatorAddress },
        ip,
        userAgent,
      });

      const capabilities = repos.capabilities.findByKernel(id);
      return {
        kernel: populateKernelDTO(inserted as any as RawKernel, capabilities, context),
        created: true,
      };
    });
  }

  /**
   * Handle a heartbeat from a kernel daemon.
   * Updates status, upserts capabilities announced in the heartbeat.
   * Replaces: POST /api/kernels/:kernelId/heartbeat
   */
  async heartbeat(
    kernelId: string,
    body: HeartbeatInput,
  ): Promise<Result<HeartbeatResult>> {
    return this.execute("heartbeat", async () => {
      const { status = "online", capabilities } = body ?? {};
      const nowDate = new Date();
      const now = nowDate.toISOString();
      const validUntil = computeValidUntilIso(nowDate);
      const repos = this.repos;

      // Resurrection detection: compare prior validUntil to "now" — if it
      // had already passed, this heartbeat brings the kernel back from
      // expired status. Emit telemetry so the dashboard can show it.
      const kernel = repos.kernels.findById(kernelId) as any;
      let resurrected = false;
      let sinceLastHeartbeatSec: number | null = null;
      let wasExpiredForMinutes: number | null = null;

      if (kernel) {
        const priorHeartbeat = kernel.lastHeartbeat
          ? Date.parse(kernel.lastHeartbeat as string)
          : NaN;
        if (Number.isFinite(priorHeartbeat)) {
          sinceLastHeartbeatSec = Math.floor((nowDate.getTime() - priorHeartbeat) / 1000);
        }
        const priorValidUntil = kernel.validUntil
          ? Date.parse(kernel.validUntil as string)
          : NaN;
        if (Number.isFinite(priorValidUntil) && priorValidUntil < nowDate.getTime()) {
          resurrected = true;
          wasExpiredForMinutes = Math.floor(
            (nowDate.getTime() - priorValidUntil) / 60000,
          );
        }

        try {
          repos.kernels.update(kernelId, {
            // The sweeper marks expired kernels status=expired; an
            // incoming heartbeat brings them back online unless the
            // operator explicitly sent status=offline.
            status: status === "offline" ? "offline" : "online",
            lastHeartbeat: now,
            validUntil,
          } as any);
        } catch {
          // soft fail
        }
      }

      // Upsert capability announcements
      let capabilitiesReceived = 0;
      if (capabilities && capabilities.length > 0) {
        for (const cap of capabilities) {
          const capType = (cap.type as string) ?? (cap.capability_type as string);
          if (!capType) continue;
          const capId = `cap-${kernelId}-${capType}`;
          try {
            const existing = repos.capabilities.findById(capId);
            if (!existing) {
              repos.capabilities.insert({
                id: capId,
                kernelId,
                type: capType,
                name: (cap.name as string) ?? `${capType} — ${kernelId}`,
                description: (cap.description as string) ?? `Auto-registered from heartbeat for kernel ${kernelId}`,
                materials: (cap.materials as string[]) ?? [],
                assuranceTiers: (cap.assuranceTiers as number[]) ?? [0, 1],
                pricing: (cap.pricing as any) ?? { currency: "USDC", baseCost: "0", minimum: "0" },
                availability: (cap.availability as any) ?? {},
                location: (cap.location as any) ?? { lat: 0, lng: 0 },
                lastHeartbeatAt: now,
                validUntil,
              } as any);
            } else {
              // Existing capability — refresh its TTL.
              try {
                repos.capabilities.update(capId, {
                  lastHeartbeatAt: now,
                  validUntil,
                } as any);
              } catch {
                // soft fail
              }
            }
          } catch {
            // non-fatal
          }
          capabilitiesReceived++;
        }
      } else {
        // Heartbeat with no capabilities body — refresh TTL on EVERY
        // capability this kernel currently exposes. Operators that beat
        // without an explicit list expect their whole catalog to stay
        // live, not just rows touched by an old announce. The query is
        // cheap (one indexed select + N updates per kernel).
        try {
          const existingCaps = repos.capabilities.findByKernel(kernelId);
          for (const c of existingCaps as any[]) {
            try {
              repos.capabilities.update(c.id, {
                lastHeartbeatAt: now,
                validUntil,
              } as any);
            } catch {
              // soft fail
            }
          }
        } catch {
          // soft fail
        }
      }

      // Telemetry — feed kernel.heartbeat.received, and kernel.resurrected
      // when applicable. See docs/kernel-lifecycle.md.
      try {
        emitKernelLifecycleEvent({
          event: "kernel.heartbeat.received",
          kernelId,
          sinceLastHeartbeatSec,
        });
        if (resurrected) {
          emitKernelLifecycleEvent({
            event: "kernel.resurrected",
            kernelId,
            wasExpiredForMinutes: wasExpiredForMinutes ?? 0,
          });
        }
      } catch {
        // never let telemetry failure break a heartbeat
      }

      return {
        acknowledged: true as const,
        kernelId,
        status,
        capabilitiesReceived,
        timestamp: now,
        validUntil,
        resurrected,
        sinceLastHeartbeatSec,
      };
    });
  }

  /**
   * Accept a capability announcement from a kernel daemon.
   * Currently a stub — returns acknowledged without upsert (unlike heartbeat).
   * Replaces: POST /api/kernels/:kernelId/capabilities
   *
   * TODO: Implement full announcement verification (Ed25519 signature check
   * on the announcement payload, then upsert capabilities and devices).
   */
  async announceCapabilities(
    kernelId: string,
    body: CapabilityAnnouncementInput,
  ): Promise<Result<AnnouncementResult>> {
    return this.execute("announceCapabilities", async () => {
      const now = new Date().toISOString();
      const capabilities = body.capabilities ?? [];
      const devices = body.devices ?? [];

      return {
        acknowledged: true as const,
        kernelId,
        capabilitiesReceived: capabilities.length,
        devicesReceived: devices.length,
        timestamp: now,
      };
    });
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Verify a kernel signing-key proof-of-possession and return the tagged
   * `RegisteredSigner` it proves, or `null` (fail closed).
   *
   * TWO LANES, ONE challenge — the signed message is `kernelSigningProofMessage(
   * kernelId)` for BOTH algorithms, so a proof captured for one kernel cannot be
   * replayed to register a different kernel's key:
   *   - secp256k1 (DEFAULT — #230 behavior, UNCHANGED): an EIP-191 signature;
   *     recover the signer and accept iff it matches the claimed
   *     `signingAddress`. Returns `{algorithm:"secp256k1", address:<checksummed>}`.
   *   - ed25519 (Option C — when `signingKeyAlgorithm === "ed25519"`): verify the
   *     128-hex detached signature against the claimed raw public key with
   *     node:crypto (`auth/ed25519.ts`). Returns
   *     `{algorithm:"ed25519", publicKey:"0x"+<64hex>}`.
   *
   * Fail closed on absent / malformed / mismatched input in EITHER lane: the
   * money path must never persist a signer that was not cryptographically
   * proven, or a forged machine log could clear settlement and release escrow.
   *
   * @param kernelId - The kernel being registered (challenge binding).
   * @param input    - The signing fields from the registration body.
   */
  private async verifySigningProof(
    kernelId: string,
    input: {
      signingAddress?: string;
      signingProof?: string;
      signingKeyAlgorithm?: string;
      signingPublicKey?: string;
    },
  ): Promise<RegisteredSigner | null> {
    const { signingProof } = input;
    // A proof is required in both lanes. No proof → no persisted signer.
    if (!signingProof) return null;

    // ── ed25519 lane (Option C) ────────────────────────────────────────────
    if (input.signingKeyAlgorithm === "ed25519") {
      // Normalize/validate the claimed raw pubkey (0x + 64 hex). Absent or
      // malformed → fail closed.
      const pubHex = normalizePublicKeyHex(input.signingPublicKey ?? "");
      if (pubHex === null) return null;
      const message = Buffer.from(kernelSigningProofMessage(kernelId), "utf8");
      // verifyEd25519Signature normalizes the 128-hex signature itself and never
      // throws — it returns false on any malformed / non-matching signature.
      if (!verifyEd25519Signature(pubHex, message, signingProof)) return null;
      return { algorithm: "ed25519", publicKey: `0x${pubHex}` };
    }

    // ── secp256k1 lane (default) ───────────────────────────────────────────
    const claimedAddress = input.signingAddress;
    if (!claimedAddress) return null;
    // Shape checks — reject anything that isn't a plausible address / hex
    // signature before touching the recovery routine. Fail closed on garbage.
    if (!/^0x[0-9a-fA-F]{40}$/.test(claimedAddress)) return null;
    if (!/^0x[0-9a-fA-F]+$/.test(signingProof)) return null;
    try {
      const recovered = await recoverMessageAddress({
        message: kernelSigningProofMessage(kernelId),
        signature: signingProof as `0x${string}`,
      });
      // Constant-format compare (both are hex addresses). Persist the recovered
      // (checksummed) address only when it matches the claim.
      if (recovered.toLowerCase() === claimedAddress.toLowerCase()) {
        return { algorithm: "secp256k1", address: recovered };
      }
      return null;
    } catch {
      // Malformed signature / recovery failure → treat as unproven.
      return null;
    }
  }

  /**
   * Map a proven `RegisteredSigner` (or null) to the three persisted kernel
   * columns. secp256k1 → the EVM address in `signingAddress` (the #230 compat
   * column the oracle's existing reader consumes); ed25519 → the raw pubkey in
   * `signingKeyPublicKey`. `signingKeyAlgorithm` carries the tag in both cases.
   * `null` → all three columns null (fail closed — no proven signer).
   */
  private signerToColumns(signer: RegisteredSigner | null): {
    signingAddress: string | null;
    signingKeyAlgorithm: string | null;
    signingKeyPublicKey: string | null;
  } {
    if (!signer) {
      return { signingAddress: null, signingKeyAlgorithm: null, signingKeyPublicKey: null };
    }
    if (signer.algorithm === "ed25519") {
      return {
        signingAddress: null,
        signingKeyAlgorithm: "ed25519",
        signingKeyPublicKey: signer.publicKey,
      };
    }
    return {
      signingAddress: signer.address,
      signingKeyAlgorithm: "secp256k1",
      signingKeyPublicKey: null,
    };
  }

  /**
   * Build a map of kernelId → capabilities[] for batch population.
   * Calls findByKernel for each kernel ID to avoid N+1 within the list path.
   */
  private buildCapabilityMap(kernelIds: string[]): Map<string, any[]> {
    const map = new Map<string, any[]>();
    for (const id of kernelIds) {
      try {
        const caps = this.repos.capabilities.findByKernel(id);
        map.set(id, caps);
      } catch {
        map.set(id, []);
      }
    }
    return map;
  }
}

/** Internal error for flow control — caught by BaseFacade.execute() */
class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} '${id}' not found`);
    this.name = "NotFoundError";
  }
}

// ── Lifecycle telemetry ───────────────────────────────────────────────────
//
// One JSON line per event to stdout. The dashboard tails this in the
// existing OTLP path; on local dev it shows up in the gateway's console.
// Stays alongside the facade so the heartbeat and sweeper share one
// emitter without an external service indirection.

export interface KernelLifecycleEvent {
  event:
    | "kernel.heartbeat.received"
    | "kernel.expired"
    | "kernel.resurrected"
    | "capability.expired";
  kernelId: string;
  capabilityId?: string;
  sinceLastHeartbeatSec?: number | null;
  wasExpiredForMinutes?: number;
  lastHeartbeatAt?: string | null;
  ageMinutes?: number;
}

export function emitKernelLifecycleEvent(evt: KernelLifecycleEvent): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...evt,
  });
  // Use stderr so it doesn't collide with Fastify request logs on stdout.
  // Dashboard collector reads both.
  process.stderr.write(`[kernel-lifecycle] ${line}\n`);
}
