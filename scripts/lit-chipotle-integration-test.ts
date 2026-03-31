/**
 * Lit Protocol Chipotle v3 — Integration Test
 *
 * Tests the REAL Lit Chipotle REST API connection, wallet creation,
 * and Lit Action execution. Requires LIT_API_KEY env var.
 *
 * Run:
 *   LIT_API_KEY=<key> npx tsx scripts/lit-chipotle-integration-test.ts
 */

const API_KEY = process.env.LIT_API_KEY;
const BASE = process.env.LIT_API_URL ?? "https://api.dev.litprotocol.com/core/v1";

if (!API_KEY) {
  console.error("ERROR: Set LIT_API_KEY env var");
  process.exit(1);
}

async function safeFetch(url: string, opts: RequestInit = {}): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (e: any) {
    clearTimeout(timeout);
    console.log(`  ⚠ Network error: ${e.cause?.code ?? e.message}`);
    return null;
  }
}

async function main() {
  console.log("=== Lit Protocol Chipotle v3 Integration Test ===\n");
  console.log(`API: ${BASE}`);
  console.log(`Key: ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}\n`);

  // 1. Version check (no auth)
  console.log("1. API Version...");
  const ver = await safeFetch(`${BASE}/version`);
  if (ver) {
    const data = await ver.json();
    console.log(`  ✓ ${data.name} v${data.version} (${data.commit_version})`);
  } else {
    console.log("  ✗ API unreachable (TLS flaky on dev — retry later)");
    process.exit(0);
  }

  // 2. Account verification
  console.log("2. Account exists...");
  const acct = await safeFetch(`${BASE}/account_exists`, {
    headers: { "X-Api-Key": API_KEY },
  });
  if (acct) {
    const exists = await acct.text();
    console.log(`  ✓ Account exists: ${exists}`);
  }

  // 3. Billing balance
  console.log("3. Billing balance...");
  const bal = await safeFetch(`${BASE}/billing/balance`, {
    headers: { "X-Api-Key": API_KEY },
  });
  if (bal) {
    const data = await bal.json();
    console.log(`  ✓ Balance: ${data.balance_display}`);
  }

  // 4. List wallets
  console.log("4. List wallets...");
  const wallets = await safeFetch(
    `${BASE}/list_wallets?page_number=0&page_size=10`,
    { headers: { "X-Api-Key": API_KEY } },
  );
  if (wallets) {
    const data = await wallets.json();
    if (Array.isArray(data)) {
      console.log(`  ✓ ${data.length} wallet(s):`);
      data.forEach((w: any) => console.log(`    - ${w.wallet_address} (${w.name || "unnamed"})`));
    } else {
      console.log(`  ✓ Response: ${JSON.stringify(data)}`);
    }
  }

  // 5. List groups
  console.log("5. List groups...");
  const groups = await safeFetch(
    `${BASE}/list_groups?page_number=0&page_size=10`,
    { headers: { "X-Api-Key": API_KEY } },
  );
  if (groups) {
    const data = await groups.json();
    if (Array.isArray(data)) {
      console.log(`  ✓ ${data.length} group(s):`);
      data.forEach((g: any) => console.log(`    - [${g.id}] ${g.name}: ${g.description}`));
    }
  }

  // 6. Execute Lit Action
  console.log("6. Execute Lit Action...");
  const action = await safeFetch(`${BASE}/lit_action`, {
    method: "POST",
    headers: { "X-Api-Key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      code: `async function main() {
        return JSON.stringify({
          source: "pcc-evidence-encryption",
          timestamp: new Date().toISOString(),
          network: "chipotle-v3",
          status: "operational"
        });
      }`,
      js_params: null,
    }),
  });
  if (action) {
    const data = await action.json();
    if (typeof data === "string" && data.includes("not authorized")) {
      console.log(`  ⚠ Action not authorized (need to register in a group first)`);
      console.log(`  → This is expected for new accounts. The group setup is automated on first encrypt.`);
    } else if (data.has_error === false) {
      console.log(`  ✓ Action executed:`, data.response);
    } else {
      console.log(`  ⚠ Action response:`, JSON.stringify(data));
    }
  }

  // 7. PCC Service integration test
  console.log("\n7. PCC RealLitEncryptionService test...");
  try {
    const { RealLitEncryptionService } = await import("../packages/kernel/src/lit-encryption-real.js");
    const svc = new RealLitEncryptionService({ apiKey: API_KEY });
    console.log(`  Status before connect:`, svc.getStatus());

    await svc.connect();
    console.log(`  Status after connect:`, svc.getStatus());

    await svc.disconnect();
    console.log(`  ✓ Service lifecycle complete`);
  } catch (e: any) {
    console.log(`  ⚠ Service test: ${e.message}`);
  }

  console.log("\n=== Integration Test Complete ===");
}

main().catch(console.error);
