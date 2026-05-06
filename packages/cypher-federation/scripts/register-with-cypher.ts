/**
 * scripts/register-with-cypher.ts
 *
 * Standalone CLI: build the PCC federation manifest from env, attempt
 * to register with Cypher Bio, and either print the issued credentials
 * (with the secret redacted) or — on the expected 403 from a
 * LIMS-scoped key — print the manifest body and a help message
 * pointing the user at info@cypherbio.ai.
 *
 * Run with `pnpm --filter @pcc/cypher-federation register` (uses tsx
 * via the package script) or `node --import tsx <path>`.
 */

import {
  FederationAuthError,
  FederationApiError,
  FederationPeer,
  buildPccFederationManifest,
} from "../src/index.js";
import type { FederationManifest } from "../src/index.js";

interface CliEnv {
  apiKey: string | undefined;
  cypherBaseUrl: string;
  pccGatewayUrl: string;
  instanceId: string;
  name: string;
  baseUrl: string;
  contactEmail: string;
  pccApiKey?: string;
}

function readEnv(): CliEnv {
  return {
    apiKey: process.env.CYPHER_FEDERATION_API_KEY,
    cypherBaseUrl: process.env.CYPHER_BASE_URL ?? "https://cypherbio.ai/backend",
    pccGatewayUrl: process.env.PCC_GATEWAY_URL ?? "https://capability.network",
    instanceId: process.env.PCC_FEDERATION_INSTANCE_ID ?? "pcc",
    name: process.env.PCC_FEDERATION_NAME ?? "PCC",
    baseUrl:
      process.env.PCC_FEDERATION_BASE_URL ?? "https://capability.network/cypher/federation",
    contactEmail: process.env.PCC_FEDERATION_CONTACT_EMAIL ?? "",
    pccApiKey: process.env.PCC_API_KEY,
  };
}

function redactSecret(s: string | undefined): string {
  if (!s) return "<none>";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} chars)`;
}

function printManifestForEmailHandoff(manifest: FederationManifest): void {
  console.log("");
  console.log("---- federation registration manifest ----");
  console.log(JSON.stringify(manifest, null, 2));
  console.log("---- end manifest ----");
  console.log("");
  console.log(
    "Federation registration requires an admin-scoped Cypher API key. The key in",
  );
  console.log(
    "CYPHER_FEDERATION_API_KEY appears to be LIMS-scoped (or otherwise rejected).",
  );
  console.log("");
  console.log("To request peering, email info@cypherbio.ai with:");
  console.log("  - the manifest above");
  console.log("  - the email tied to your Cypher account");
  console.log("  - a one-line note: \"Please grant federation peering for the PCC instance.\"");
  console.log("");
  console.log("Cypher will issue a federation-scoped API key. Set it in");
  console.log("CYPHER_FEDERATION_API_KEY and re-run this script.");
}

async function main(): Promise<number> {
  const env = readEnv();

  if (!env.apiKey) {
    console.error(
      "CYPHER_FEDERATION_API_KEY is not set. Building manifest only — no registration call will be made.",
    );
    const manifest = await buildPccFederationManifest({
      gatewayUrl: env.pccGatewayUrl,
      instanceId: env.instanceId,
      name: env.name,
      baseUrl: env.baseUrl,
      contactEmail: env.contactEmail,
      pccApiKey: env.pccApiKey,
    });
    printManifestForEmailHandoff(manifest);
    return 1;
  }

  const peer = new FederationPeer({
    apiKey: env.apiKey,
    baseUrl: env.cypherBaseUrl,
  });

  console.log(`[cypher-federation] building manifest from ${env.pccGatewayUrl}`);
  const manifest = await buildPccFederationManifest({
    gatewayUrl: env.pccGatewayUrl,
    instanceId: env.instanceId,
    name: env.name,
    baseUrl: env.baseUrl,
    contactEmail: env.contactEmail,
    pccApiKey: env.pccApiKey,
  });
  console.log(
    `[cypher-federation] manifest ready: ${manifest.services?.length ?? 0} services, contact=${manifest.contactEmail || "<none>"}`,
  );

  try {
    const credentials = await peer.register(manifest);
    console.log("[cypher-federation] register OK.");
    console.log(
      `  instanceId: ${credentials.instanceId}\n  apiKey:    ${redactSecret(credentials.apiKey)}\n  secret:    ${redactSecret(credentials.secret)}\n  expiresAt: ${credentials.expiresAt ?? "never"}`,
    );
    console.log("");
    console.log("Save these credentials in your secret store. Cypher will use the apiKey");
    console.log("on every callback to PCC; PCC verifies it via the secret (HMAC).");
    return 0;
  } catch (e) {
    if (e instanceof FederationAuthError) {
      console.error(`[cypher-federation] register rejected: ${e.message}`);
      printManifestForEmailHandoff(manifest);
      return 2;
    }
    if (e instanceof FederationApiError) {
      console.error(`[cypher-federation] register failed: ${e.message}`);
      console.error(`  status: ${e.status ?? "<network error>"}`);
      if (e.body) {
        console.error(`  body:   ${JSON.stringify(e.body)}`);
      }
      return 3;
    }
    console.error(`[cypher-federation] unexpected error:`, e);
    return 4;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("fatal:", err);
    process.exit(99);
  },
);
