/**
 * Per-Kernel Dynamic Agent Package — any agent loads this to operate a kernel.
 *
 * GET /api/kernels/:kernelId/agent-package
 *   Returns a tailored tool set based on the kernel's devices, capabilities,
 *   and operator configuration. Includes system prompt, tools, and SDK hints.
 *
 * GET /api/kernels/:kernelId/agent-package/suggest
 *   Returns tool suggestions for the operator to review before accepting.
 *
 * PUT /api/kernels/:kernelId/agent-package/configure
 *   Operator saves their tool configuration (enabled/disabled/custom tools).
 *
 * GET /api/kernels/:kernelId/sdk/:language
 *   Returns SDK snippet for this kernel in the requested language.
 */

import type { FastifyInstance } from "fastify";
import { getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import type { OperatorPolicy } from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import {
  suggestTools,
  applyOperatorToolConfig,
  type SuggestedTool,
} from "../services/tool-suggestions.js";
import {
  generateWizardPrompt,
  generateKernelWizardPrompt,
} from "../services/wizard-prompt.js";

const { shopKernels, kernelDevices, capabilities, operatorPolicies } = schema;

export async function kernelAgentPackageRoutes(app: FastifyInstance) {
  /**
   * GET /api/kernels/:kernelId/agent-package
   *
   * The main endpoint. Any agent loads this to know what tools are available
   * for operating this kernel. The package format matches the existing
   * agent-package.json schema (pcc-agent-package/2.0).
   */
  app.get<{ Params: { kernelId: string }; Querystring: { role?: string } }>(
    "/api/kernels/:kernelId/agent-package",
    async (req, reply) => {
      try {
        const { db } = getStore();
        const { kernelId } = req.params;
        const isOperator = req.query.role === "operator";

        // Load kernel
        const kernel = db.select().from(shopKernels)
          .where(eq(shopKernels.id, kernelId))
          .get();
        if (!kernel) return reply.status(404).send({ error: "Kernel not found" });

        // Load devices
        const devices = db.select().from(kernelDevices)
          .where(eq(kernelDevices.kernelId, kernelId))
          .all();

        // Load capabilities
        const caps = db.select().from(capabilities)
          .where(eq(capabilities.kernelId, kernelId))
          .all();

        // Load operator policy
        const policyRow = db.select().from(operatorPolicies)
          .where(eq(operatorPolicies.kernelId, kernelId))
          .get();
        const policy = (policyRow?.policy ?? DEFAULT_OPERATOR_POLICY) as unknown as OperatorPolicy;

        // Extract adapter types and capability types
        const adapterTypes = [...new Set(
          devices
            .map((d) => d.adapterType)
            .filter((t): t is string => t !== null && t !== undefined),
        )];
        const capabilityTypes = [...new Set(caps.map((c) => c.type))];

        // Generate tool suggestions
        const suggestions = suggestTools(adapterTypes, capabilityTypes, isOperator);

        // Apply operator's tool configuration
        const toolConfig = (policy as any).toolConfig ?? {};
        const tools = applyOperatorToolConfig(suggestions, toolConfig);

        // Build system prompt tailored to this kernel
        const baseUrl = `${req.protocol}://${req.hostname}`;
        const systemPrompt = buildSystemPrompt(kernel, devices, caps, policy, baseUrl);

        // Build the agent package
        const agentPackage = {
          schema: "pcc-agent-package/2.0",
          name: `${kernel.name} Agent Package`,
          description: `Dynamic agent package for ${kernel.name}. ${caps.length} capabilities across ${devices.length} devices.`,
          version: "2.1.0",
          homepage: baseUrl,
          api_base: `${baseUrl}/api`,
          kernel: {
            id: kernel.id,
            name: kernel.name,
            location: kernel.location,
            status: kernel.status,
            reputation: kernel.reputation,
          },
          devices: devices.map((d) => ({
            id: d.id,
            type: d.type,
            model: d.model,
            status: d.status,
            adapterType: d.adapterType,
          })),
          capabilities: caps.map((c) => ({
            id: c.id,
            type: c.type,
            name: c.name,
            materials: c.materials,
            pricing: c.pricing,
          })),
          operator_policy: {
            approvalMode: policy.approvalMode,
            operatingHours: policy.operatingHours,
            timezone: policy.timezone,
            emergencyStop: policy.emergencyStop,
            pricingRules: policy.pricingRules?.filter((r) => r.enabled) ?? [],
          },
          batch_capable: suggestions.batchCapable,
          system_prompt: systemPrompt,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            category: t.category,
            input_schema: t.inputSchema,
            endpoint: t.endpoint,
          })),
          tool_count: tools.length,
          categories: suggestions.categories,
          wizard_prompt: generateKernelWizardPrompt(
            kernel,
            devices,
            caps,
            baseUrl,
          ),
          generated_at: new Date().toISOString(),
        };

        return agentPackage;
      } catch (err) {
        return reply.status(500).send({
          error: "Failed to generate agent package",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * GET /api/kernels/:kernelId/agent-package/suggest
   *
   * Returns tool suggestions for the operator to review.
   * The operator sees what the platform recommends and can accept/reject each.
   */
  app.get<{ Params: { kernelId: string } }>(
    "/api/kernels/:kernelId/agent-package/suggest",
    async (req, reply) => {
      try {
        const { db } = getStore();
        const { kernelId } = req.params;

        const devices = db.select().from(kernelDevices)
          .where(eq(kernelDevices.kernelId, kernelId))
          .all();
        const caps = db.select().from(capabilities)
          .where(eq(capabilities.kernelId, kernelId))
          .all();

        const adapterTypes = [...new Set(devices.map((d) => d.adapterType).filter(Boolean) as string[])];
        const capabilityTypes = [...new Set(caps.map((c) => c.type))];

        const suggestions = suggestTools(adapterTypes, capabilityTypes, true);

        return {
          suggestions: suggestions.tools.map((t) => ({
            name: t.name,
            description: t.description,
            category: t.category,
            recommended: t.recommended,
          })),
          categories: suggestions.categories,
          batchCapable: suggestions.batchCapable,
          adapterTypes,
          capabilityTypes,
          message: "Review these tool suggestions. Accept all recommended tools, or customize by enabling/disabling specific tools via PUT /configure.",
        };
      } catch {
        return reply.status(500).send({ error: "Failed to generate suggestions" });
      }
    },
  );

  /**
   * PUT /api/kernels/:kernelId/agent-package/configure
   *
   * Operator saves their tool configuration.
   */
  app.put<{ Params: { kernelId: string } }>(
    "/api/kernels/:kernelId/agent-package/configure",
    async (req, reply) => {
      const config = req.body as {
        enabledTools?: string[];
        disabledTools?: string[];
        customTools?: SuggestedTool[];
      };

      try {
        const { db } = getStore();
        const { kernelId } = req.params;

        // Verify the caller owns this kernel (prevents unauthorized policy injection)
        const operatorId = (req as any).operatorId ?? (req as any).userId;
        if (operatorId) {
          const kernel = db.select().from(schema.shopKernels)
            .where(eq(schema.shopKernels.id, kernelId))
            .get();
          if (kernel && (kernel as any).operatorId && (kernel as any).operatorId !== operatorId) {
            return reply.status(403).send({ error: "You can only configure your own kernel's agent package" });
          }
        }

        // Load current policy
        const row = db.select().from(operatorPolicies)
          .where(eq(operatorPolicies.kernelId, kernelId))
          .get();
        const policy = (row?.policy ?? { ...DEFAULT_OPERATOR_POLICY }) as any;

        // Save tool config into policy
        policy.toolConfig = config;
        const now = new Date().toISOString();

        db.insert(operatorPolicies)
          .values({ kernelId, policy, updatedAt: now, updatedBy: "tool-config" })
          .onConflictDoUpdate({
            target: operatorPolicies.kernelId,
            set: { policy, updatedAt: now, updatedBy: "tool-config" },
          })
          .run();

        return { configured: true, toolConfig: config, updatedAt: now };
      } catch {
        return reply.status(500).send({ error: "Failed to save tool configuration" });
      }
    },
  );

  /**
   * GET /api/kernels/:kernelId/sdk/:language
   *
   * Returns SDK snippet for controlling this kernel from code.
   */
  app.get<{ Params: { kernelId: string; language: string } }>(
    "/api/kernels/:kernelId/sdk/:language",
    async (req, reply) => {
      const { kernelId, language } = req.params;
      const baseUrl = `${req.protocol}://${req.hostname}`;

      const snippets: Record<string, string> = {
        python: `"""PCC SDK — ${kernelId}"""
import requests

BASE = "${baseUrl}/api"
KERNEL = "${kernelId}"

# 1. Start a negotiation session
session = requests.post(f"{BASE}/negotiate/session", json={
    "userAgentId": "my-agent",
    "kernelId": KERNEL,
    "capabilityType": "liquid-handler",  # or "fdm", "cnc-3axis", etc.
}).json()
sid = session["session"]["id"]

# 2. Configure parameters
requests.patch(f"{BASE}/negotiate/session/{sid}/select", json={
    "selections": {"protocolType": "transfer", "sampleCount": 8, "transferVolume": 100}
})

# 3. Get a quote
quote = requests.post(f"{BASE}/negotiate/session/{sid}/quote").json()
print(f"Price: {quote['quote']['totalPrice']} {quote['quote']['currency']}")

# 4. Review contract terms
requests.post(f"{BASE}/negotiate/session/{sid}/review")

# 5. Commit (fund escrow, start job)
result = requests.post(f"{BASE}/negotiate/session/{sid}/commit").json()
print(f"Job ID: {result['jobId']}")

# 6. Check status
status = requests.get(f"{BASE}/jobs/{result['jobId']}").json()
print(f"Status: {status}")
`,
        javascript: `// PCC SDK — ${kernelId}
const BASE = "${baseUrl}/api";
const KERNEL = "${kernelId}";

// 1. Start a negotiation session
const session = await fetch(\`\${BASE}/negotiate/session\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userAgentId: "my-agent",
    kernelId: KERNEL,
    capabilityType: "liquid-handler",
  }),
}).then(r => r.json());
const sid = session.session.id;

// 2. Configure parameters
await fetch(\`\${BASE}/negotiate/session/\${sid}/select\`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    selections: { protocolType: "transfer", sampleCount: 8, transferVolume: 100 }
  }),
});

// 3. Get a quote
const quote = await fetch(\`\${BASE}/negotiate/session/\${sid}/quote\`, { method: "POST" }).then(r => r.json());
console.log(\`Price: \${quote.quote.totalPrice} \${quote.quote.currency}\`);

// 4. Review + commit
await fetch(\`\${BASE}/negotiate/session/\${sid}/review\`, { method: "POST" });
const result = await fetch(\`\${BASE}/negotiate/session/\${sid}/commit\`, { method: "POST" }).then(r => r.json());
console.log(\`Job ID: \${result.jobId}\`);
`,
        curl: `# PCC SDK — ${kernelId}
BASE="${baseUrl}/api"
KERNEL="${kernelId}"

# 1. Create session
SID=$(curl -s -X POST $BASE/negotiate/session \\
  -H "Content-Type: application/json" \\
  -d '{"userAgentId":"my-agent","kernelId":"'$KERNEL'","capabilityType":"liquid-handler"}' \\
  | jq -r '.session.id')

# 2. Configure
curl -s -X PATCH $BASE/negotiate/session/$SID/select \\
  -H "Content-Type: application/json" \\
  -d '{"selections":{"protocolType":"transfer","sampleCount":8,"transferVolume":100}}'

# 3. Quote
curl -s -X POST $BASE/negotiate/session/$SID/quote | jq '.quote'

# 4. Review + commit
curl -s -X POST $BASE/negotiate/session/$SID/review
curl -s -X POST $BASE/negotiate/session/$SID/commit | jq '.jobId'
`,
      };

      const snippet = snippets[language];
      if (!snippet) {
        return reply.status(400).send({
          error: `Unsupported language: ${language}`,
          available: Object.keys(snippets),
        });
      }

      return {
        language,
        kernelId,
        snippet,
        note: "Load the agent package for the full tool set: GET /api/kernels/{kernelId}/agent-package",
      };
    },
  );

  /**
   * GET /api/onboard/wizard-prompt
   *
   * Bootstrap endpoint — returns the wizard system prompt BEFORE a kernel
   * exists. The operator's agent loads this to start the onboarding flow.
   * No kernel ID needed — the wizard creates one during setup.
   */
  app.get(
    "/api/onboard/wizard-prompt",
    async (req) => {
      const { deviceType, adapterType } = req.query as { deviceType?: string; adapterType?: string };
      const baseUrl = `${req.protocol}://${req.hostname}`;

      const prompt = generateWizardPrompt({
        baseUrl,
        deviceType: deviceType ?? undefined,
        adapterType: adapterType ?? undefined,
        includeDriverGuide: true,
      });

      return {
        prompt,
        usage: "Feed this prompt as the system message to any LLM agent. The agent becomes your setup wizard.",
        example: {
          claude: `claude -p "${baseUrl}/api/onboard/wizard-prompt" --system-prompt-url`,
          openai: "Set as system message in ChatCompletion",
          generic: "Load this prompt as the agent's system instruction",
        },
      };
    },
  );
}

// ── System Prompt Builder ─────────────────────────────────────────

function buildSystemPrompt(
  kernel: any,
  devices: any[],
  caps: any[],
  policy: any,
  baseUrl: string,
): string {
  const deviceList = devices.map((d) => `- ${d.model} (${d.type}, ${d.status})`).join("\n");
  const capList = caps.map((c) => `- ${c.type}: ${c.name}`).join("\n");
  const materials = [...new Set(caps.flatMap((c) => {
    const m = c.materials;
    return Array.isArray(m) ? m : typeof m === "string" ? JSON.parse(m) : [];
  }))].join(", ");

  return `You are an AI agent operating on the Physical Capability Cloud (PCC) network.

## Your Kernel: ${kernel.name}
- ID: ${kernel.id}
- Location: ${JSON.stringify(kernel.location)}
- Status: ${kernel.status}
- Reputation: ${kernel.reputation}/1000

## Devices
${deviceList}

## Capabilities
${capList}

## Materials Available
${materials}

## Operator Policy
- Approval mode: ${policy.approvalMode}
- Operating hours: ${policy.timezone}
- Emergency stop: ${policy.emergencyStop ? "ACTIVE — all jobs suspended" : "inactive"}

## How to Submit a Job
1. Create a negotiation session: POST /api/negotiate/session
2. Configure parameters using the tool schemas provided
3. Get a quote: POST /api/negotiate/session/{id}/quote
4. Review contract terms: POST /api/negotiate/session/{id}/review
5. Commit (funds escrow): POST /api/negotiate/session/{id}/commit
6. Monitor: GET /api/jobs/{jobId}

## Multi-User Batching
${caps.some((c: any) => ["liquid-handler", "hplc", "pcr", "assay"].includes(c.type))
    ? "This kernel supports multi-user batching. Multiple users can share a single run (e.g., wells on a shared 96-well plate). Use the batch_* tools to list open batches, claim slots, and check batch status."
    : "Standard single-user job execution."}

## Funding
Fund your wallet: POST ${baseUrl}/api/fiat-ramp/onramp/session
Accepts: Visa, Mastercard, AMEX → USDC on Base

## API Base
${baseUrl}/api
`;
}
