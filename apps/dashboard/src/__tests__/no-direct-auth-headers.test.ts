/**
 * One place puts an API key on a request (sol #2857: "key construction only
 * inside the wrapper"): fetchWithKey in lib/gateway-base.ts, which checks the
 * destination first. Dashboard code reaches it through authorizedFetch
 * (lib/authorized-fetch.ts).
 *
 * A module that calls getAuthHeaders() or builds a Bearer header by hand
 * attaches the key without knowing where the request goes. The egress guard
 * installed in main.tsx stops such a request from carrying the key off the
 * gateway. This ratchet removes the pattern from the code itself.
 *
 * KNOWN lists the remaining modules and their owning lanes. It only shrinks:
 * a new offender fails, and so does a listed file that no longer builds a
 * header. A listed file that has been deleted is fine.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** getAuthHeaders() is defined in the store; fetchWithKey is the wrapper. */
const ALLOWED = new Set(["lib/gateway-base.ts", "stores/auth-store.ts"]);

const KEY_CONSTRUCTION = /getAuthHeaders\s*\(|Bearer \$\{|["'`]Bearer ["'`]\s*\+/;

const SHELL = "pcc-shell 47b47970";
const KNOWN: Record<string, string> = {
  "agent/agent-client.ts": `${SHELL}: deleted with the old agent chat by #354`,
  "pages/AgentChatPage.tsx": `${SHELL}: deleted by #354`,
  "pages/EvidenceExplorerPage.tsx": "readmodels c255d7dc",
  "pages/SettlementPage.tsx": "readmodels c255d7dc",
  "components/escrow/DisputeModal.tsx": "economics df42dbe5",
  "pages/OperatorDashboardPage.tsx": "operator-ux f0734fab",
  "pages/OperatorMobilePage.tsx": "operator-ux f0734fab",
  "components/operator/DiscoverabilityPanel.tsx": "operator-ux f0734fab",
  "components/operator/EditDeleteBar.tsx": "operator-ux f0734fab",
  "components/operator/RateSubmitForm.tsx": "operator-ux f0734fab",
  "routes/operator/OperatorA2APage.tsx": "operator-ux f0734fab",
  "pages/StartPage.tsx": "adk 4f6668ed",
  "pages/AgentPackagePage.tsx": "adk 4f6668ed",
  "routes/onboard/chat/index.tsx": "adk 4f6668ed",
  "routes/orchestrator/[slug]/chat/index.tsx": "adk 4f6668ed",
  "lib/passkey-registration.ts": "adk 4f6668ed: sends to deps.apiBase, which usePasskey sets to the validated GATEWAY_BASE",
  "pages/NegotiationSessionPage.tsx": "unassigned: steward to route",
  "pages/AnalyticsDashboardPage.tsx": "unassigned: steward to route",
  "pages/BatchBoardPage.tsx": "unassigned (lab/OT-2 surfaces): steward to route",
  "pages/BatchTrackingPage.tsx": "unassigned (lab/OT-2 surfaces): steward to route",
  "pages/OrchestratorDetailPage.tsx": "unassigned (lab/OT-2 surfaces): steward to route",
  "pages/OrchestratorPage.tsx": "unassigned (lab/OT-2 surfaces): steward to route",
  "pages/ProtocolDetailPage.tsx": "unassigned (lab/OT-2 surfaces): steward to route",
  "pages/ProtocolLibraryPage.tsx": "unassigned (lab/OT-2 surfaces): steward to route",
  "pages/ProtocolRunPage.tsx": "unassigned (lab/OT-2 surfaces): steward to route",
  "pages/SensorDashboardPage.tsx": "unassigned (lab/OT-2 surfaces): steward to route",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const offenders = new Map<string, string[]>();
for (const full of files(SRC)) {
  const rel = relative(SRC, full).split(sep).join("/");
  if (ALLOWED.has(rel)) continue;
  const hits = readFileSync(full, "utf-8")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && KEY_CONSTRUCTION.test(line))
    .map(({ line, n }) => `${rel}:${n} ${line.trim().slice(0, 100)}`);
  if (hits.length) offenders.set(rel, hits);
}

describe("the API key is put on requests only by fetchWithKey (sol #2857)", () => {
  it("no module outside KNOWN builds an Authorization header itself", () => {
    const unexpected = [...offenders.entries()].filter(([f]) => !(f in KNOWN)).flatMap(([, h]) => h);
    expect(unexpected, "Use authorizedFetch (lib/authorized-fetch.ts), which checks the destination first").toEqual([]);
  });

  it("KNOWN only shrinks: every listed file that still exists still builds a header", () => {
    const stale = Object.keys(KNOWN).filter((f) => existsSync(join(SRC, f)) && !offenders.has(f));
    expect(stale, "Remove these from KNOWN: they no longer build a header").toEqual([]);
  });

  it("the gateway clients, the setup pages and the auth store send the key only through the wrapper", () => {
    for (const f of ["lib/api.ts", "api/gateway.ts", "pages/SetupAgentPage.tsx", "pages/SetupWizardPage.tsx", "pages/EarnFromYourWorkPage.tsx"]) {
      expect(offenders.has(f), f).toBe(false);
    }
    const store = readFileSync(join(SRC, "stores/auth-store.ts"), "utf-8");
    expect(store).not.toMatch(/fetch\(/);
  });

  it("the egress guard is installed at startup", () => {
    const main = readFileSync(join(SRC, "main.tsx"), "utf-8");
    expect(main).toMatch(/installKeyEgressGuard\(/);
  });
});
