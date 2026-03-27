import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DocumentAnalysisResult, MachineRegistration } from "@pcc/spec";
import { UnifiedKeychain } from "@pcc/agent-runtime";

const GATECRAFT_URL = process.env.GATECRAFT_URL ?? "https://gatecraft-production.up.railway.app";

// Mock storage
const registrations: MachineRegistration[] = [];

export async function onboardRoutes(app: FastifyInstance) {
  // Upload document and return mock AI analysis
  app.post("/api/onboard/analyze", async (req) => {
    const result: DocumentAnalysisResult = {
      suggestedCapabilities: [
        {
          id: `sug-${Date.now()}`,
          type: "fdm",
          name: "Standard FDM Printing",
          description: "Layer-by-layer extrusion with 0.4mm nozzle",
          materials: ["PLA", "PETG", "ABS", "TPU"],
          tolerances: { linear: "±0.2mm", surface: "Ra 12.5" },
          envelope: { x: 250, y: 210, z: 210, unit: "mm" },
          suggestedParams: [],
          confidence: 0.92,
          sourceReason: "Extracted from manufacturer datasheet",
        },
      ],
      extractedSpecs: {
        "build-volume": "250 x 210 x 210 mm",
        "layer-height": "0.05 - 0.30 mm",
        "nozzle-temp-max": "300°C",
        "bed-temp-max": "120°C",
      },
      extractedMaterials: ["PLA", "PETG", "ABS", "TPU", "ASA", "PC"],
      extractedTolerances: [{ linear: "±0.2mm", surface: "Ra 12.5" }],
      confidence: 0.89,
      sourceDocumentId: "doc-uploaded",
    };
    return { status: "ok", analysis: result };
  });

  // Submit machine registration
  app.post("/api/onboard/register", async (req) => {
    const body = req.body as Partial<MachineRegistration>;
    const registration: MachineRegistration = {
      id: `reg-${Date.now()}`,
      name: body.name ?? "Unknown",
      category: body.category ?? "custom",
      manufacturer: body.manufacturer ?? "",
      model: body.model ?? "",
      serialNumber: body.serialNumber,
      description: body.description,
      photos: body.photos ?? [],
      documents: body.documents ?? [],
      capabilities: body.capabilities ?? [],
      spaceRequirements: body.spaceRequirements ?? {
        footprint: { width: 0, depth: 0, height: 0, unit: "mm" },
        clearances: { front: 0, back: 0, left: 0, right: 0, above: 0, unit: "mm" },
        weight: { value: 0, unit: "kg" },
        power: { voltage: 120, amperage: 15, phase: 1 },
        environmental: { ventilationRequired: false, dustExtraction: false, fumeExtraction: false },
        utilities: { compressedAir: false, water: false, coolant: false, wasteDrainage: false },
        vibrationIsolation: false,
      },
      pricing: body.pricing ?? { baseCost: "0", minimum: "0", currency: "USDC" },
      operator: body.operator ?? {
        walletAddress: "0x0000000000000000000000000000000000000000",
        displayName: "Unknown",
        certifications: [],
        trainingAcknowledgments: {},
      },
      status: "submitted",
      createdAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
    };
    registrations.push(registration);
    return { status: "ok", registration };
  });

  // List registrations
  app.get("/api/onboard/registrations", async () => {
    return { registrations };
  });

  // Get registration detail
  app.get<{ Params: { id: string } }>("/api/onboard/registrations/:id", async (req) => {
    const reg = registrations.find((r) => r.id === req.params.id);
    if (!reg) return { error: "not_found" };
    return { registration: reg };
  });

  // ═══════════════════════════════════════════════════════════════
  // Agent Onboarding — one invite code provisions everything
  // Uses Gatecraft as identity/wallet/credential layer
  // ═══════════════════════════════════════════════════════════════

  /**
   * POST /api/onboard/redeem — One-click agent onboarding
   *
   * 1. Redeems Gatecraft invite code → account + wallet + shared keys
   * 2. Returns unified config: PCC tools + LLM proxy + wallet + identity
   *
   * Result: agent has wallet, identity, LLM access, and PCC tools.
   * No manual key management, no provider selection, no wallet setup.
   */
  app.post("/api/onboard/redeem", async (req, reply) => {
    const body = req.body as {
      inviteCode: string;
      email: string;
      password: string;
      name?: string;
    };

    if (!body.inviteCode || !body.email || !body.password) {
      return reply.status(400).send({
        error: "inviteCode, email, and password are required",
      });
    }

    try {
      const gcRes = await fetch(`${GATECRAFT_URL}/v1/hackathon/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!gcRes.ok) {
        const err = await gcRes.json().catch(() => ({ error: "Identity service error" }));
        return reply.status(gcRes.status).send(err);
      }

      const gc = await gcRes.json() as {
        token: string;
        userId: string;
        walletBalance: number;
        providers: string[];
        message: string;
      };

      const baseUrl = `${req.protocol}://${req.hostname}`;

      // Generate unified keychain — one mnemonic derives all chain keys
      const kc = new UnifiedKeychain();
      const keys = kc.generate();

      return reply.send({
        success: true,
        message: "Your agent is provisioned. Everything is ready.",

        // Identity
        token: gc.token,
        user_id: gc.userId,

        // Wallet (microdollars)
        wallet_balance_usd: gc.walletBalance / 1_000_000,

        // Unified keys (generated client-side in production — here for demo)
        keys: {
          mnemonic: keys.mnemonic, // SENSITIVE — user must back this up
          evm: {
            address: keys.evm.address,
            // privateKey NOT exposed in API — only mnemonic
          },
          solana: {
            publicKey: keys.solana.publicKey,
          },
          did: keys.did,
          bittensor: {
            publicKeyHex: keys.bittensor.publicKeyHex,
          },
        },
        warning:
          "Back up your mnemonic. It derives all your keys. PCC never stores it.",

        // Agent configuration — feed this entire object to your agent
        agent_config: {
          pcc_tools: `${baseUrl}/agent-package.json`,
          pcc_api: `${baseUrl}/api`,
          llm_proxy: `${GATECRAFT_URL}/api/v2/proxy/call`,
          llm_auth: `Bearer ${gc.token}`,
          providers: gc.providers,
          unbrowse_skills: `${baseUrl}/unbrowse-skills.json`,
          unbrowse_api: `${baseUrl}/api/unbrowse`,
          wallet: `${GATECRAFT_URL}/api/v2/proxy/wallet`,
        },

        // Fiat on-ramp — fund agent wallet with credit card
        funding: {
          message: "Fund your agent wallet with a credit card or bank transfer",
          stripe: {
            endpoint: `${baseUrl}/api/fiat-ramp/onramp/session`,
            method: "POST",
            body: { walletAddress: keys.evm.address, amount: 50, currency: "USD" },
            description: "Visa/Mastercard/AMEX → USDC on Base",
          },
          yellowcard: {
            endpoint: `${baseUrl}/api/fiat-ramp/onramp/yellowcard`,
            method: "POST",
            description: "Mobile money in 34 emerging market countries → USDC",
          },
          wise: {
            endpoint: `${baseUrl}/api/fiat-ramp/payout`,
            method: "POST",
            description: "Enterprise bank payouts in 40+ currencies",
          },
        },
      });
    } catch (err) {
      app.log.error(err, "Onboard redeem failed");
      return reply.status(502).send({ error: "Identity service unreachable" });
    }
  });

  /** GET /api/onboard/check/:code — Validate invite code before redeeming */
  app.get<{ Params: { code: string } }>("/api/onboard/check/:code", async (req, reply) => {
    try {
      const res = await fetch(`${GATECRAFT_URL}/v1/hackathon/invite/${req.params.code}`);
      if (!res.ok) return reply.status(404).send({ valid: false });
      const data = await res.json();
      return reply.send({
        valid: true,
        event: data,
        includes: [
          "Wallet with credits for LLM calls",
          "Access to Claude, GPT-4o, Groq — no API keys needed",
          "73 PCC tools for physical capability discovery and orchestration",
          "Agent identity with trust scoring",
        ],
      });
    } catch {
      return reply.status(502).send({ valid: false, error: "Service unreachable" });
    }
  });

  /** GET /api/onboard/status — Check what the agent has provisioned */
  app.get("/api/onboard/status", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Bearer token required (from /api/onboard/redeem)" });
    }

    try {
      const [meRes, walletRes, credsRes] = await Promise.all([
        fetch(`${GATECRAFT_URL}/v1/auth/me`, { headers: { Authorization: auth } }),
        fetch(`${GATECRAFT_URL}/api/v2/proxy/wallet`, { headers: { Authorization: auth } }),
        fetch(`${GATECRAFT_URL}/api/v2/proxy/credentials`, { headers: { Authorization: auth } }),
      ]);

      return reply.send({
        user: meRes.ok ? await meRes.json() : null,
        wallet: walletRes.ok ? await walletRes.json() : null,
        credentials: credsRes.ok ? await credsRes.json() : null,
        pcc_tools: `${req.protocol}://${req.hostname}/agent-package.json`,
        ready: meRes.ok,
      });
    } catch {
      return reply.status(502).send({ error: "Identity service unreachable" });
    }
  });
}
