/**
 * Lit Protocol key provisioning for operators.
 * When an operator registers, they get a scoped Lit usage API key
 * that lets them encrypt evidence directly (no gateway needed).
 */

import type { FastifyInstance } from "fastify";
import { litEncryptionService } from "../services.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";

const LIT_API_URL =
  process.env.LIT_API_URL ?? "https://api.dev.litprotocol.com/core/v1";
const LIT_ACCOUNT_KEY = process.env.LIT_API_KEY ?? "";

export async function litProvisionRoutes(app: FastifyInstance) {
  // ── POST /api/lit/provision ─────────────────────────────────────
  // Provisions a scoped Lit usage key for an operator.
  // Uses the ACCOUNT key (LIT_API_KEY) to create a limited usage key.
  app.post("/api/lit/provision", async (req, reply) => {
    const body = (req.body ?? {}) as {
      kernelId?: string;
      operatorDid?: string;
    };

    if (!body.kernelId || !body.operatorDid) {
      return reply.status(400).send({
        error: "missing_fields",
        message: "Both kernelId and operatorDid are required",
      });
    }

    if (!LIT_ACCOUNT_KEY) {
      console.log("[LIT] provision failed — no LIT_API_KEY configured");
      return reply.status(503).send({
        error: "lit_not_configured",
        message:
          "Lit Protocol account key is not configured. Set LIT_API_KEY env var.",
      });
    }

    try {
      const provisionBody = JSON.stringify({
        name: `pcc-operator-${body.kernelId}`,
        description: `PCC evidence encryption for ${body.operatorDid}`,
        can_create_groups: false,
        can_delete_groups: false,
        can_create_pkps: false,
        manage_ipfs_ids_in_groups: [],
        add_pkp_to_groups: [],
        remove_pkp_from_groups: [],
        execute_in_groups: [0],
      });

      console.log(
        `[LIT] provisioning usage key for kernel=${body.kernelId} operator=${body.operatorDid}`,
      );

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      let usageKey: string;
      try {
        const res = await fetch(`${LIT_API_URL}/add_usage_api_key`, {
          method: "POST",
          headers: {
            "X-Api-Key": LIT_ACCOUNT_KEY,
            "Content-Type": "application/json",
          },
          body: provisionBody,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const text = await res.text();
          console.log(
            `[LIT] provision API error: ${res.status} ${text}`,
          );
          return reply.status(502).send({
            error: "lit_api_error",
            message: `Lit API returned ${res.status}: ${text.slice(0, 200)}`,
          });
        }

        const data = (await res.json()) as { success?: boolean; usage_api_key?: string };
        usageKey = data.usage_api_key ?? "";

        if (!usageKey) {
          console.log("[LIT] provision returned empty key — response:", data);
          return reply.status(502).send({
            error: "lit_empty_key",
            message: "Lit API returned an empty usage key",
          });
        }
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        if (fetchErr.name === "AbortError") {
          console.log("[LIT] provision timed out after 10s");
          return reply.status(504).send({
            error: "lit_timeout",
            message: "Lit API did not respond within 10 seconds",
          });
        }
        console.log(`[LIT] provision network error: ${fetchErr.message}`);
        return reply.status(502).send({
          error: "lit_network_error",
          message: `Could not reach Lit API: ${fetchErr.message}`,
        });
      }

      auditService.log({
        eventType: "lit.key_provisioned",
        actor: body.operatorDid,
        resourceType: "lit_usage_key",
        resourceId: body.kernelId,
        action: "create",
        metadata: { kernelId: body.kernelId, operatorDid: body.operatorDid },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      trackServerEvent("lit_key_provisioned", {
        kernelId: body.kernelId,
        operatorDid: body.operatorDid,
      });

      console.log(
        `[LIT] usage key provisioned for kernel=${body.kernelId}`,
      );

      return reply.status(201).send({
        usageKey,
        litApiUrl: LIT_API_URL,
        litNetwork: "chipotle",
      });
    } catch (err: any) {
      console.log(`[LIT] provision unexpected error: ${err.message}`);
      return reply.status(500).send({
        error: "provision_failed",
        message: err.message ?? "Unknown error during Lit key provisioning",
      });
    }
  });

  // ── GET /api/lit/status ─────────────────────────────────────────
  // Returns Lit service status.
  app.get("/api/lit/status", async () => {
    return {
      timestamp: new Date().toISOString(),
      lit: litEncryptionService.getStatus(),
      accountKeyConfigured: !!LIT_ACCOUNT_KEY,
      litApiUrl: LIT_API_URL,
      litNetwork: "chipotle",
    };
  });
}
