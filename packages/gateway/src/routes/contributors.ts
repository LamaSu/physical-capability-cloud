/**
 * Contributor-economics REST routes.
 *
 * Surfaces the @pcc/store ContributorRepository + the @pcc/spec evaluation
 * helpers (computeScheduleHash / evaluateRateSchedule / computeTrainingManifestHash)
 * over Fastify so external agents can:
 *
 *   POST /api/contributors                                  — register a profile (DB row)
 *   GET  /api/contributors/:address                         — list profiles for an address
 *   GET  /api/contributors/by-role/:role                    — list profiles bound to a role
 *   POST /api/contributors/schedules                        — publish a sealed RateSchedule
 *   GET  /api/contributors/schedules/:scheduleHash          — fetch a published schedule
 *   POST /api/contributors/schedules/:scheduleHash/evaluate — evaluate the curve at a moment
 *   POST /api/contributors/training-manifests               — set TrainingManifest for a model IP
 *   GET  /api/contributors/training-manifests/:modelIpId    — fetch a TrainingManifest
 *
 * Conventions:
 *  - Inputs validated with Zod; failures return `{error: "invalid_request", message}` 400.
 *  - All schedule writes recompute `scheduleHash` server-side via the @pcc/spec
 *    canonicalizer, then reject when the caller's claimed hash mismatches. This
 *    keeps the registry content-addressed exactly the way the on-chain
 *    `RateScheduleRegistry.publish(...)` does.
 *  - Training manifests enforce dataset weight sum ≤ 10000 bps at the gateway
 *    (the on-chain payout map currently expects exact == 10000 sum, but for
 *    the registry surface we accept ≤ to allow incremental publishing of
 *    partial mixes; the validation note here matches the brief).
 *
 * Tests live in __tests__/contributors.test.ts and exercise the full route
 * surface against an in-memory better-sqlite3 store.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRepos } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getEmbeddedWalletAdapter } from "../auth/embedded-wallet.js";
import {
  RateSegmentSchema,
  computeScheduleHash,
  evaluateRateSchedule,
  type RateSchedule,
  type RateSegment,
  TrainingDatasetEntrySchema,
  computeTrainingManifestHash,
  canonicalize,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------

/**
 * Canonical 10-role taxonomy from @pcc/spec story.ts ContributorRole, plus the
 * deprecated `designer` alias retained for backward compatibility (ADR-12
 * §2.2). Mirrors the union type because spec does not currently export a Zod
 * enum form (CompositionRoleSchema in composition-manifest.ts is a near-dup
 * but adds `pilot` and omits `designer`, so it cannot be reused verbatim).
 */
const ContributorRoleSchema = z.enum([
  "operator",
  "verifier",
  "insurer",
  "integrator",
  "protocol-author",
  "model-author",
  "dataset-contributor",
  "curator",
  "assembler",
  "network-treasury",
  // Deprecated alias retained for legacy decode (ADR-12 §2.2).
  "designer",
] as const);

const ScheduleHashSchema = z
  .string()
  .regex(/^0x[a-f0-9]{64}$/i, "scheduleHash must be 0x + 64 lowercase hex chars");

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "address must be 0x + 40 hex chars");

// ---------------------------------------------------------------------------
// Body / params shapes (Zod-driven, not interface-typed)
// ---------------------------------------------------------------------------

const RegisterProfileBodySchema = z.object({
  address: AddressSchema,
  role: ContributorRoleSchema,
  scheduleHash: ScheduleHashSchema,
  ipId: z.string().min(1).optional(),
  metadataUri: z.string().min(1).optional(),
  contributorNftTokenId: z.string().min(1).optional(),
});

/**
 * Body for `POST /api/contributors/schedules`. Caller submits the parsed
 * RateSchedule sans the scheduleHash field — we recompute the hash server-side
 * and seal it. Callers that already know the hash (e.g., they computed it
 * client-side and want to gate-check) MAY include `scheduleHash`; if it
 * mismatches the recomputed value we reject 400.
 */
const PublishScheduleBodySchema = z.object({
  publishedBy: AddressSchema,
  schedule: z.object({
    version: z.number().int().min(1),
    segments: z.array(RateSegmentSchema).min(1),
    notes: z.string().optional(),
    scheduleHash: ScheduleHashSchema.optional(),
    publishedAt: z.string().optional(),
  }),
});

const EvaluateScheduleBodySchema = z.object({
  now: z.number().int().min(0),
  jobValueCents: z.number().int().min(0).optional(),
  jobsPerDay: z.number().min(0).optional(),
});

const TrainingManifestBodySchema = z.object({
  modelIpId: z.string().min(1),
  baseModelIpId: z.string().min(1).optional(),
  datasetWeights: z.array(TrainingDatasetEntrySchema).min(1),
  methodologyHash: z
    .string()
    .regex(/^0x[a-f0-9]{64}$/i)
    .optional(),
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function contributorRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/contributors ───────────────────────────────────────────────

  app.post("/api/contributors", async (req, reply) => {
    const parse = RegisterProfileBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: parse.error.issues[0]?.message ?? "validation failed",
        details: parse.error.issues,
      });
    }

    const body = parse.data;
    const repos = getRepos();

    // The `id` is a deterministic composite of address + role + (tokenId or
    // scheduleHash). This matches the schema comment on contributorProfiles.id.
    const idTail = body.contributorNftTokenId ?? body.scheduleHash;
    const id = `${body.address}:${body.role}:${idTail}`;

    const profile = {
      id,
      address: body.address,
      role: body.role,
      scheduleHash: body.scheduleHash,
      ipId: body.ipId ?? null,
      contributorNftTokenId: body.contributorNftTokenId ?? null,
      metadataUri: body.metadataUri ?? null,
      registeredAt: new Date().toISOString(),
    };

    try {
      repos.contributors.upsertProfile(profile);
      return reply.code(201).send({ profile });
    } catch (err) {
      return reply.code(500).send({
        error: "register_profile_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── GET /api/contributors/by-role/:role ──────────────────────────────────
  // IMPORTANT: registered BEFORE /:address so Fastify's static-segment-first
  // resolver picks this branch even when role values look like addresses.

  app.get<{ Params: { role: string } }>(
    "/api/contributors/by-role/:role",
    async (req, reply) => {
      const role = req.params.role;
      const parse = ContributorRoleSchema.safeParse(role);
      if (!parse.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: `unknown role: ${role}`,
        });
      }
      const repos = getRepos();
      const profiles = repos.contributors.listProfilesByRole(parse.data);
      return { profiles };
    },
  );

  // ── GET /api/contributors/schedules/:scheduleHash ────────────────────────
  // Registered BEFORE /:address so static segments win over the dynamic one.

  app.get<{ Params: { scheduleHash: string } }>(
    "/api/contributors/schedules/:scheduleHash",
    async (req, reply) => {
      const parsed = ScheduleHashSchema.safeParse(req.params.scheduleHash);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "invalid scheduleHash",
        });
      }

      const repos = getRepos();
      const record = repos.contributors.getSchedule(parsed.data);
      if (!record) {
        return reply.code(404).send({ error: "schedule_not_found" });
      }

      // Re-parse segmentsJson and validate via Zod so callers always receive
      // a structurally-checked RateSegment[] back, not an opaque string.
      let segments: RateSegment[];
      try {
        const raw = JSON.parse(record.segmentsJson);
        segments = z.array(RateSegmentSchema).parse(raw);
      } catch (err) {
        return reply.code(500).send({
          error: "schedule_corrupt",
          message: `stored segmentsJson failed to parse: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const schedule: RateSchedule = {
        scheduleHash: record.scheduleHash as `0x${string}`,
        version: record.version,
        segments,
        notes: record.notes ?? undefined,
        publishedAt: record.publishedAt,
      };

      return { schedule, publishedBy: record.publishedBy };
    },
  );

  // ── POST /api/contributors/schedules/:scheduleHash/evaluate ──────────────

  app.post<{ Params: { scheduleHash: string } }>(
    "/api/contributors/schedules/:scheduleHash/evaluate",
    async (req, reply) => {
      const hashParse = ScheduleHashSchema.safeParse(req.params.scheduleHash);
      if (!hashParse.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: hashParse.error.issues[0]?.message ?? "invalid scheduleHash",
        });
      }
      const bodyParse = EvaluateScheduleBodySchema.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: bodyParse.error.issues[0]?.message ?? "validation failed",
          details: bodyParse.error.issues,
        });
      }

      const repos = getRepos();
      const record = repos.contributors.getSchedule(hashParse.data);
      if (!record) {
        return reply.code(404).send({ error: "schedule_not_found" });
      }

      let segments: RateSegment[];
      try {
        segments = z.array(RateSegmentSchema).parse(JSON.parse(record.segmentsJson));
      } catch (err) {
        return reply.code(500).send({
          error: "schedule_corrupt",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const schedule: RateSchedule = {
        scheduleHash: record.scheduleHash as `0x${string}`,
        version: record.version,
        segments,
        notes: record.notes ?? undefined,
        publishedAt: record.publishedAt,
      };

      const result = evaluateRateSchedule(schedule, {
        now: bodyParse.data.now,
        jobValueCents: bodyParse.data.jobValueCents ?? 0,
        jobsPerDay: bodyParse.data.jobsPerDay ?? 0,
      });

      return {
        scheduleHash: record.scheduleHash,
        bps: result.bps,
        segmentKind: result.kind,
        segmentIndex: result.segmentIndex,
      };
    },
  );

  // ── POST /api/contributors/schedules ─────────────────────────────────────

  app.post("/api/contributors/schedules", async (req, reply) => {
    const parse = PublishScheduleBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: parse.error.issues[0]?.message ?? "validation failed",
        details: parse.error.issues,
      });
    }

    const { publishedBy, schedule } = parse.data;

    // Recompute the canonical hash server-side. This is the same algorithm
    // (sha256 over canonical JSON of {version, segments}) used by the on-chain
    // RateScheduleRegistry.publish() — the value MUST match if the caller
    // claimed a hash up-front.
    let computed: `0x${string}`;
    try {
      computed = computeScheduleHash({
        version: schedule.version,
        segments: schedule.segments,
        notes: schedule.notes,
        publishedAt: schedule.publishedAt ?? "",
      });
    } catch (err) {
      return reply.code(400).send({
        error: "invalid_request",
        message: `computeScheduleHash failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (schedule.scheduleHash && schedule.scheduleHash.toLowerCase() !== computed.toLowerCase()) {
      return reply.code(400).send({
        error: "schedule_hash_mismatch",
        message: `caller-claimed hash ${schedule.scheduleHash} does not match recomputed ${computed}`,
      });
    }

    // Compute the canonical bytes that hash to `computed`. These are the
    // exact bytes the on-chain RateScheduleRegistry.publish() must consume so
    // its sha256 matches the off-chain `scheduleHash` we just returned.
    // Without this, integrators end up sending literal user-typed JSON to
    // the chain (whose bytes hash to a DIFFERENT value), publishing under
    // hash X, then reverting on ContributorNFT.mint(Y) — see SEAM-1 in
    // ai/research/contributor-economics/verify-05-e2e.md.
    const canonicalBytes = canonicalize({
      version: schedule.version,
      segments: schedule.segments,
    });

    const repos = getRepos();
    const existing = repos.contributors.getSchedule(computed);
    if (existing) {
      return {
        scheduleHash: computed,
        canonicalBytes,
        alreadyPublished: true,
      };
    }

    // Canonicalize segmentsJson before write so on read we always parse back
    // the same shape, regardless of insertion order in the input.
    const segmentsJson = canonicalize(schedule.segments);

    try {
      repos.contributors.publishSchedule({
        scheduleHash: computed,
        version: schedule.version,
        segmentsJson,
        notes: schedule.notes ?? null,
        publishedBy,
        publishedAt: schedule.publishedAt ?? new Date().toISOString(),
      });
    } catch (err) {
      return reply.code(500).send({
        error: "publish_schedule_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      scheduleHash: computed,
      canonicalBytes,
      alreadyPublished: false,
    };
  });

  // ── POST /api/contributors/training-manifests ────────────────────────────

  app.post("/api/contributors/training-manifests", async (req, reply) => {
    const parse = TrainingManifestBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: parse.error.issues[0]?.message ?? "validation failed",
        details: parse.error.issues,
      });
    }

    const { modelIpId, baseModelIpId, datasetWeights, methodologyHash } = parse.data;

    const totalBps = datasetWeights.reduce((sum, d) => sum + d.weightBps, 0);
    if (totalBps > 10000) {
      return reply.code(400).send({
        error: "weights_exceed_total",
        message: `dataset weightBps sum to ${totalBps}, must be ≤ 10000`,
      });
    }

    // computeTrainingManifestHash signs the structural body (modelIpId + datasets
    // + optional baseModelIpId + optional methodologyHash) — exactly mirrors the
    // off-chain definition in @pcc/spec/types/training-manifest.ts.
    const manifestHash = computeTrainingManifestHash({
      modelIpId,
      datasets: datasetWeights,
      baseModelIpId,
      methodologyHash: methodologyHash as `0x${string}` | undefined,
      trainedAt: new Date().toISOString(),
    });

    const datasetWeightsJson = canonicalize(datasetWeights);

    try {
      const repos = getRepos();
      repos.contributors.setTrainingManifest({
        modelIpId,
        baseModelIpId: baseModelIpId ?? null,
        datasetWeightsJson,
        methodologyHash: methodologyHash ?? null,
        manifestHash,
        createdAt: new Date().toISOString(),
      });

      return { modelIpId, manifestHash };
    } catch (err) {
      return reply.code(500).send({
        error: "set_training_manifest_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── GET /api/contributors/training-manifests/:modelIpId ──────────────────

  app.get<{ Params: { modelIpId: string } }>(
    "/api/contributors/training-manifests/:modelIpId",
    async (req, reply) => {
      const repos = getRepos();
      const record = repos.contributors.getTrainingManifest(req.params.modelIpId);
      if (!record) {
        return reply.code(404).send({ error: "training_manifest_not_found" });
      }

      let datasets: unknown;
      try {
        datasets = JSON.parse(record.datasetWeightsJson);
      } catch (err) {
        return reply.code(500).send({
          error: "training_manifest_corrupt",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      return {
        manifest: {
          modelIpId: record.modelIpId,
          baseModelIpId: record.baseModelIpId,
          datasets,
          methodologyHash: record.methodologyHash,
          manifestHash: record.manifestHash,
          createdAt: record.createdAt,
        },
      };
    },
  );

  // ── POST /api/contributors/quickstart ────────────────────────────────────
  //
  // Bundled signup endpoint for the zero-friction "I want to earn from my
  // work" flow (apps/dashboard/src/pages/EarnFromYourWorkPage.tsx). One
  // request creates a wallet, an API key, a contributor profile, and a
  // default RateSchedule — the four things a non-technical contributor would
  // otherwise have to do via four separate API calls + a wallet install.
  //
  // The wallet is created via the EmbeddedWalletAdapter seam:
  //   - DemoWalletAdapter (default)  → UnifiedKeychain-derived EOA, mnemonic
  //                                    returned once for the user to back up
  //   - PrivyWalletAdapter (active when PRIVY_APP_ID is set) → Privy ERC-4337
  //                                    smart wallet, no seed phrase
  //
  // The default RateSchedule is a single `constant` segment with the user's
  // chosen percentage as bps (1.5% → 150 bps), forever. Authors who want
  // adoption-indexed / capture-class / step / decay schedules use the full
  // RateSchedulePublishPage in the dashboard instead.

  const QuickstartBodySchema = z.object({
    email: z.string().email().max(255),
    role: ContributorRoleSchema,
    ratePercent: z.number().min(0.01).max(50),
    contributionDescription: z.string().max(280).optional(),
    name: z.string().max(120).optional(),
  });

  app.post("/api/contributors/quickstart", async (req, reply) => {
    const parse = QuickstartBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: parse.error.issues[0]?.message ?? "validation failed",
        details: parse.error.issues,
      });
    }

    const body = parse.data;
    const adapter = getEmbeddedWalletAdapter();

    // 1. Create / recover the embedded wallet for this email.
    let wallet;
    try {
      wallet = await adapter.createWalletForEmail(body.email);
    } catch (err) {
      return reply.code(502).send({
        error: "wallet_provider_failed",
        provider: adapter.providerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Provision an API key bound to this email.
    let apiKey: string;
    let keyId: string;
    try {
      const result = provisionApiKey({
        operatorId: body.email,
        name: body.name ?? body.email,
        description: `Contributor quickstart (${body.role})`,
        scopes: [
          "contributor:read",
          "contributor:write",
          "schedule:read",
          "schedule:publish",
        ],
        metadata: {
          flow: "quickstart",
          walletProvider: adapter.providerId,
          walletAddress: wallet.address,
          contributorRole: body.role,
        },
      });
      if (!result.record) {
        return reply.code(500).send({
          error: "api_key_provision_failed",
          message: "provisionApiKey returned no record",
        });
      }
      apiKey = result.rawKey;
      keyId = result.record.id;
    } catch (err) {
      return reply.code(500).send({
        error: "api_key_provision_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Build a default constant-segment RateSchedule.
    //    1.5% → 150 bps. Schedule starts now (unix seconds), no end.
    const bps = Math.round(body.ratePercent * 100);
    const startTime = Math.floor(Date.now() / 1000);
    const segments: RateSegment[] = [
      {
        kind: "constant",
        startTime,
        endTime: null,
        bps,
      },
    ];
    const publishedAt = new Date().toISOString();
    let scheduleHash: `0x${string}`;
    try {
      scheduleHash = computeScheduleHash({
        version: 1,
        segments,
        notes: body.contributionDescription,
        publishedAt: "",
      });
    } catch (err) {
      return reply.code(500).send({
        error: "schedule_hash_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const segmentsJson = canonicalize(segments);
    const repos = getRepos();

    // 4. Publish the schedule (idempotent on duplicate hash).
    const existingSchedule = repos.contributors.getSchedule(scheduleHash);
    if (!existingSchedule) {
      try {
        repos.contributors.publishSchedule({
          scheduleHash,
          version: 1,
          segmentsJson,
          notes: body.contributionDescription ?? null,
          publishedBy: wallet.address,
          publishedAt,
        });
      } catch (err) {
        return reply.code(500).send({
          error: "schedule_publish_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5. Register the contributor profile.
    const profileId = `${wallet.address}:${body.role}:${scheduleHash}`;
    try {
      repos.contributors.upsertProfile({
        id: profileId,
        address: wallet.address,
        role: body.role,
        scheduleHash,
        ipId: null,
        contributorNftTokenId: null,
        metadataUri: null,
        registeredAt: new Date().toISOString(),
      });
    } catch (err) {
      return reply.code(500).send({
        error: "profile_register_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const baseUrl = `${req.protocol}://${req.hostname}`;

    return reply.code(201).send({
      apiKey,
      keyId,
      walletAddress: wallet.address,
      walletProvider: adapter.providerId,
      walletProviderUserId: wallet.providerUserId,
      // Mnemonic is ONLY present when the demo adapter is active. The
      // Privy adapter never returns a seed phrase. Frontend MUST display
      // this once with a "back this up before continuing" gate.
      mnemonic: wallet.mnemonic ?? null,
      mnemonicWarning: wallet.mnemonic
        ? "Save this 12-word phrase NOW. It is the only way to recover your wallet. We do not store it. If you lose it, your wallet and all royalty payouts are gone forever."
        : null,
      scheduleHash,
      ratePercent: body.ratePercent,
      bps,
      role: body.role,
      contributionDescription: body.contributionDescription ?? null,
      profileId,
      // Pointers the frontend can deep-link to.
      links: {
        viewSchedule: `${baseUrl}/contributors/schedules/${scheduleHash}`,
        addUsdc: `${baseUrl}/api/fiat-ramp/onramp/session`,
        agentPackage: `${baseUrl}/agent-package.json`,
      },
    });
  });

  // ── GET /api/contributors/:address ───────────────────────────────────────
  // Registered LAST so Fastify resolves the static segments first
  // (/by-role/:role, /schedules/:hash, /training-manifests/:id, /quickstart).

  app.get<{ Params: { address: string } }>(
    "/api/contributors/:address",
    async (req, reply) => {
      const parse = AddressSchema.safeParse(req.params.address);
      if (!parse.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: parse.error.issues[0]?.message ?? "invalid address",
        });
      }
      const repos = getRepos();
      const profiles = repos.contributors.listProfilesByAddress(parse.data);
      return { profiles };
    },
  );
}
