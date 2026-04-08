import type { FastifyInstance } from "fastify";
import { getCapabilityFacade } from "../facades/index.js";

/**
 * Button config endpoint — returns pre-configured claudebuttons config
 * for any capability, allowing third-party sites to embed "Run on Claude Code"
 * buttons that target PCC capabilities.
 *
 * GET /api/capabilities/:capabilityType/button
 * Returns: { command, html, config }
 */
export async function buttonConfigRoutes(app: FastifyInstance) {
  const facade = getCapabilityFacade();

  app.get<{ Params: { capabilityType: string }; Querystring: { variant?: string; size?: string; mode?: string } }>(
    "/api/capabilities/:capabilityType/button",
    async (req) => {
      const { capabilityType } = req.params;
      const variant = req.query.variant ?? "outline";
      const size = req.query.size ?? "md";
      const mode = req.query.mode ?? "claude-code";

      const command = `pcc negotiate --capability ${capabilityType}`;
      const tag = mode === "cowork" ? "cowork-button" : "claude-code-button";

      return {
        command,
        config: {
          command,
          variant,
          size,
          mode,
          theme: "dark",
          shape: "pill",
        },
        html: `<script src="https://unpkg.com/claudebuttons"></script>\n<${tag} command="${command}" variant="${variant}" size="${size}" theme="dark" shape="pill"></${tag}>`,
        structuredData: {
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: `PCC ${capabilityType} — Run on Claude Code`,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Cross-platform",
          url: `https://capability.network/marketplace?capability=${capabilityType}`,
          potentialAction: {
            "@type": "UseAction",
            target: `claude-code://run?command=${encodeURIComponent(command)}`,
            name: `Negotiate ${capabilityType} capability`,
          },
        },
      };
    },
  );
}
