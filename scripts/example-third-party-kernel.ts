/**
 * Example third-party kernel: a Celsius-to-Fahrenheit converter.
 *
 * Demonstrates the full lifecycle:
 *   1. buildManifest(...) constructs a DigitalKernelManifest
 *   2. --dry-run prints the manifest + signed sample evidence and exits
 *   3. without --dry-run, the script POSTs the manifest to a local gateway
 *      and starts a minimal HTTP server on localhost that serves the
 *      kernel-sdk's job handler.
 *
 * Run:
 *   npx tsx scripts/example-third-party-kernel.ts --dry-run
 *   npx tsx scripts/example-third-party-kernel.ts --gateway=http://localhost:3200
 *
 * Resolution note: this monorepo does not hoist workspace @pcc/* packages
 * to the root node_modules. Scripts use dynamic import of the built dist
 * directly to avoid node's package-resolution machinery. Each package
 * MUST be built (pnpm --filter @pcc/<pkg> build) before running this.
 */

import nacl from "tweetnacl";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  gatewayUrl: string;
  port: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    dryRun: argv.includes("--dry-run"),
    gatewayUrl:
      argv.find((a) => a.startsWith("--gateway="))?.slice("--gateway=".length) ??
      "http://localhost:3200",
    port: Number(
      argv.find((a) => a.startsWith("--port="))?.slice("--port=".length) ??
        3333,
    ),
  };
}

function toFileUrl(absPath: string): string {
  return "file:///" + absPath.replace(/\\/g, "/");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkgs = resolve(scriptDir, "..", "packages");

  // Dynamic imports against built dist (avoids node_modules resolution).
  const sdk = await import(
    toFileUrl(resolve(pkgs, "kernel-sdk/dist/index.js"))
  );
  const { buildManifest, createKernelHandler } = sdk;

  const endpointURL = args.dryRun
    ? "https://example-third-party-kernel.invalid/run"
    : `https://localhost:${args.port}/run`;

  // Deterministic builder identity so kernelId + sigs stay stable across runs.
  const seed = new Uint8Array(32);
  new TextEncoder()
    .encode("example-third-party-kernel-seed")
    .forEach((b, i) => {
      if (i < 32) seed[i] = b;
    });
  const kp = nacl.sign.keyPair.fromSeed(seed);

  const principalKey = {
    agentId: "eip155:84532:0x1234567890abcdef1234567890abcdef12345678",
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    publicKey: kp.publicKey,
  };

  const manifest = buildManifest({
    kernelId: "k-example-temp-converter",
    name: "Celsius -> Fahrenheit Converter",
    description: "Deterministic unit-conversion kernel, open-source example.",
    builder: {
      agentId: principalKey.agentId,
      contactURI: "mailto:example@pcc-builders.dev",
    },
    capabilityType: "temperature-converter",
    workflowSteps: [
      {
        stepId: "parse-input",
        stepType: "validate",
        description: "Validate the Celsius input",
        dependsOn: [],
      },
      {
        stepId: "convert",
        stepType: "transform",
        description: "Apply F = C*9/5 + 32",
        dependsOn: ["parse-input"],
      },
      {
        stepId: "format-output",
        stepType: "transform",
        description: "Format result to 4 decimal places",
        dependsOn: ["convert"],
      },
    ],
    pricing: { baseUSD: 0.001 },
    maxAssuranceTier: 1,
    endpointURL,
    sessionKeyPolicy: {
      maxTTLSeconds: 600,
      allowedActions: ["evidence_submit", "workflow_step_complete"],
    },
  });

  console.log("=".repeat(70));
  console.log("Third-Party Kernel Example: Celsius -> Fahrenheit Converter");
  console.log("=".repeat(70));
  console.log();
  console.log("Kernel manifest:");
  console.log(JSON.stringify(manifest, null, 2));
  console.log();
  console.log("Builder agentId:", principalKey.agentId);
  console.log("Builder pubkey: ", toHex(principalKey.publicKey));
  console.log();

  async function convertCelsiusToFahrenheit(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const celsius = Number(input.celsius);
    if (!Number.isFinite(celsius)) {
      throw new Error("input.celsius must be a finite number");
    }
    const fahrenheit = (celsius * 9) / 5 + 32;
    return {
      celsius,
      fahrenheit: Number(fahrenheit.toFixed(4)),
      formula: "F = C * 9/5 + 32",
    };
  }

  const handler = createKernelHandler({
    manifest,
    principalKey,
    principalPrivateKey: kp.secretKey,
    execute: convertCelsiusToFahrenheit,
  });

  // Always run a sample so the builder can see the evidence shape.
  const sample = await handler({
    jobId: "example-job-001",
    input: { celsius: 100 },
  });
  console.log("Sample output:", JSON.stringify(sample.output));
  console.log();
  console.log("Sample evidence bundle:");
  console.log(JSON.stringify(sample.evidenceBundle, null, 2));
  console.log();
  console.log("Attribution chain:");
  console.log("  builder.agentId ->", manifest.builder.agentId);
  console.log("  kernelSessionPublicKey ->", sample.kernelSessionPublicKey);
  console.log("  bundleHash ->", sample.evidenceBundle.bundleHash);
  console.log(
    "  kernelSignature.value ->",
    sample.evidenceBundle.kernelSignature.value.slice(0, 32) + "...",
  );
  console.log();

  if (args.dryRun) {
    console.log("Dry run complete — manifest validated + sample evidence generated.");
    console.log("Exiting without registering or serving.");
    return;
  }

  // Register with gateway
  console.log("Registering kernel with gateway at", args.gatewayUrl, "...");
  const registerRes = await fetch(`${args.gatewayUrl}/api/kernels/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest }),
  });
  const registerBody = await registerRes.json();
  console.log("Registration response:", registerBody);

  if (!registerRes.ok) {
    console.error("Registration failed — exiting.");
    process.exit(1);
  }

  // Minimal HTTP server (no external deps — uses node:http)
  const http = await import("node:http");
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/run") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    try {
      const result = await handler(body);
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify(result));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  server.listen(args.port, () => {
    console.log(`Kernel serving on http://localhost:${args.port}/run`);
    console.log("Press Ctrl+C to stop.");
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
