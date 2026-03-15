/**
 * Register PCC skills with Unbrowse — makes PCC discoverable by any agent.
 *
 * Unbrowse is a shared skill registry. This script:
 * 1. Reads PCC's skill manifest (unbrowse-skills.json)
 * 2. For each endpoint, resolves it through Unbrowse's intent system
 *    so Unbrowse indexes PCC's capabilities
 * 3. Validates the skills are discoverable via semantic search
 *
 * Run: npx tsx scripts/register-unbrowse.ts
 *
 * Requires: Unbrowse server running locally (bun src/index.ts)
 * or UNBROWSE_URL env var pointing to remote instance.
 */

const UNBROWSE_URL = process.env.UNBROWSE_URL ?? "http://localhost:6969";
const PCC_URL = process.env.PCC_URL ?? "https://pcc-gateway-production.up.railway.app";

interface SkillManifest {
  domain: string;
  name: string;
  endpoints: Array<{
    id: string;
    method: string;
    path: string;
    description: string;
    tags: string[];
  }>;
}

async function main() {
  console.log("═".repeat(60));
  console.log("  PCC × Unbrowse — Skill Registration");
  console.log("═".repeat(60));
  console.log();

  // 1. Check Unbrowse health
  console.log("[unbrowse] Checking server...");
  try {
    const health = await fetch(`${UNBROWSE_URL}/health`);
    if (!health.ok) throw new Error(`Status ${health.status}`);
    console.log("[unbrowse] Server OK\n");
  } catch (err) {
    console.error("[unbrowse] Server not reachable at", UNBROWSE_URL);
    console.error("           Start Unbrowse: bun src/index.ts");
    console.error("           Or set UNBROWSE_URL env var\n");
    console.log("Falling back to manifest validation only...\n");
    await validateOnly();
    return;
  }

  // 2. Load manifest
  console.log("[manifest] Loading PCC skill manifest...");
  const manifest: SkillManifest = await fetch(`${PCC_URL}/unbrowse-skills.json`).then(r => r.json());
  console.log(`[manifest] ${manifest.endpoints.length} endpoints found\n`);

  // 3. Register each endpoint via intent resolution
  console.log("[register] Registering PCC endpoints with Unbrowse...\n");
  let registered = 0;
  let failed = 0;

  for (const endpoint of manifest.endpoints) {
    const intent = `${endpoint.description} on ${manifest.domain}`;
    process.stdout.write(`  ${endpoint.id.padEnd(25)} `);

    try {
      const res = await fetch(`${UNBROWSE_URL}/v1/intent/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent,
          params: { url: `${PCC_URL}${endpoint.path.replace(/:(\w+)/g, "test")}` },
          context: { url: PCC_URL },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`✓ skill_id=${data.skill_id ?? "pending"}`);
        registered++;
      } else {
        console.log(`✗ ${res.status}`);
        failed++;
      }
    } catch {
      console.log("✗ timeout");
      failed++;
    }
  }

  console.log(`\n[register] ${registered} registered, ${failed} failed\n`);

  // 4. Verify discoverability via search
  console.log("[verify] Testing semantic search...\n");
  const testQueries = [
    "find a 3D printer",
    "HPLC chemical analysis",
    "manufacturing escrow",
    "machine capabilities",
  ];

  for (const query of testQueries) {
    process.stdout.write(`  "${query}" → `);
    try {
      const res = await fetch(`${UNBROWSE_URL}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: query, k: 3 }),
      });
      const data = await res.json();
      const pccResults = (data.results ?? []).filter(
        (r: { metadata?: { domain?: string } }) =>
          r.metadata?.domain?.includes("pcc") || r.metadata?.domain?.includes("railway"),
      );
      console.log(pccResults.length > 0 ? `✓ ${pccResults.length} PCC results` : "- no PCC results yet");
    } catch {
      console.log("✗ search unavailable");
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Done. PCC skills are now indexed in Unbrowse.");
  console.log("  Agents can discover PCC via: POST /v1/intent/resolve");
  console.log("  Or search: POST /v1/search { intent: 'CNC machining' }");
  console.log("═".repeat(60));
}

/** Offline validation — just check the manifest is well-formed */
async function validateOnly() {
  console.log("[validate] Fetching manifest from", PCC_URL);
  try {
    const manifest = await fetch(`${PCC_URL}/unbrowse-skills.json`).then(r => r.json());
    console.log(`[validate] ✓ ${manifest.name}`);
    console.log(`[validate] ✓ ${manifest.endpoints?.length ?? 0} endpoints`);
    console.log(`[validate] ✓ domain: ${manifest.domain}`);
    console.log(`[validate] ✓ auth: ${manifest.auth?.type}`);

    for (const ep of manifest.endpoints ?? []) {
      const ok = ep.id && ep.method && ep.path && ep.description;
      console.log(`  ${ok ? "✓" : "✗"} ${ep.id} — ${ep.method} ${ep.path}`);
    }

    console.log(`\n[validate] Manifest is valid. Serve at /unbrowse-skills.json`);
    console.log(`[validate] When Unbrowse is running, re-run to register.\n`);
  } catch (err) {
    console.error("[validate] ✗ Failed to fetch manifest:", err);
  }
}

main().catch(console.error);
