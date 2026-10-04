// Claims that published copy may make only when they are true.
//
// Why this exists: public pages promised "cryptographic proof on every job",
// "escrow pays your wallet" and "live" CNC/PCB supply while no production gate
// was armed and the public catalog had no available listing. Each phrase below
// makes a promise about what PCC does today. A published surface may carry one
// only when its status is `live`; the steward sets `live` when the gate named
// in `requires` is armed. A `forbidden` claim either breaks a standing rule (an
// architectural invariant or an operator rule; `requires` starts "Never:") or
// names a defence that is off until the steward records it armed (`requires`
// starts "Until armed:"). A `positioning` claim states purpose, not a live
// capability; it may appear only with the statement in `alongside` within
// ALONGSIDE_WINDOW characters of it. src/lib/__tests__/public-claims.test.ts
// fails CI when a published surface uses a claim that is not `live`, or a
// positioning claim without its companion.

export type ClaimStatus =
  | "live"
  | "positioning"
  | "testnet"
  | "preview"
  | "demo"
  | "roadmap"
  | "forbidden";

export interface GuardedClaim {
  id: string;
  /** Matched case-insensitively against the full text of each published surface. */
  pattern: RegExp;
  status: ClaimStatus;
  /** What must be true (ledger row, gate or rule) before the claim may be published. */
  requires: string;
  /** A phrase the pattern must catch; the test proves each pattern still matches. */
  example: string;
  /** For `positioning`: the statement that must sit beside every occurrence. */
  alongside?: RegExp;
}

/** How close (in characters, before or after) a positioning claim's companion must be. */
export const ALONGSIDE_WINDOW = 400;

export const GUARDED_CLAIMS: readonly GuardedClaim[] = [
  {
    id: "proof-on-every-job",
    pattern: /(cryptographic )?proof on every job|every job returns signed/i,
    status: "roadmap",
    requires: "Frozen evidence byte contract (R20), tier ceiling (R27) and Gate B armed",
    example: "Cryptographic proof on every job.",
  },
  {
    id: "escrow-pays-wallet",
    pattern: /escrow pays your wallet/i,
    status: "testnet",
    requires: "PRODUCTION-ARMED: real-money settlement",
    example: "Publish. Jobs arrive. Escrow pays your wallet.",
  },
  {
    id: "live-network-badge",
    pattern: /\blive\s*·\s*capability\.network/i,
    status: "roadmap",
    requires: "PRODUCTION-ARMED",
    example: "Live · capability.network",
  },
  {
    id: "live-capability-supply",
    pattern: /search live capabilities/i,
    status: "preview",
    requires: "Available supply in the public catalog (reference vertical, R46)",
    example: "Search live capabilities such as CNC machining",
  },
  {
    id: "prototype-to-working-system",
    pattern: /crossed from prototype to working distributed system/i,
    status: "roadmap",
    requires: "The money loop running on production (DELTAS #10)",
    example: "PCC crossed from prototype to working distributed system.",
  },
  {
    id: "printer-is-live",
    pattern: /the printer is live on PCC/i,
    status: "roadmap",
    requires: "Kernel creation in onboarding (R40) and the admin review gate (R26)",
    example: "7. Done. The printer is live on PCC",
  },
  {
    id: "simulated-ai-extraction",
    pattern: /AI assistant helps extract capabilities/i,
    status: "demo",
    requires: "Real document analysis in onboarding (PX-10)",
    example: "Our AI assistant helps extract capabilities from your documentation.",
  },
  {
    id: "unpublished-npm-package",
    pattern:
      /npx @pcc\/|npx pcc-onboard\b|npmjs\.com\/package\/@pcc\/|(npm i(nstall)?|pnpm add|yarn add) @pcc\//i,
    status: "roadmap",
    requires: "The package published to npm (ADK, R4)",
    example: "npx @pcc/onboard",
  },
  {
    id: "pcc-plans-the-work",
    pattern:
      /PCC handles the rest|PCC decomposes|decomposes the request into a capability DAG|orchestrates the supply chain|protocol routes the work|broker compiles (the )?execution plan/i,
    status: "forbidden",
    requires: "Never: invariant 1, PCC is not the canonical planner",
    example: "PCC decomposes the request into a capability DAG and orchestrates the supply chain.",
  },
  {
    id: "fixed-capability-taxonomy",
    pattern: /\b44 (built-in )?capability types/i,
    status: "forbidden",
    requires: "Never: capability types are open-ended",
    example: "44 capability types, 6 adapter templates.",
  },
  {
    id: "invented-income-projection",
    pattern: /most profitable equipment/i,
    status: "forbidden",
    requires: "Never: show real opportunities or an honest waiting state, not invented projections",
    example: "Find the most profitable equipment to bring online.",
  },
  {
    id: "moat",
    pattern: /\bmoat\b/i,
    status: "forbidden",
    requires: "Never: operator rule, no moat framing in public copy",
    example: "The substrate is the moat.",
  },
  {
    id: "x402-mpp-payment-gate",
    pattern:
      /via x402|x402 (and|\+) (Solana )?USDC|x402 ·|accepts? HTTP 402 micropayments|handles per-request micropayments|supports x402 micropayments|(pay|settle)(s|ment|ments)? (via|with|through) MPP/i,
    status: "forbidden",
    requires: "Until armed: the x402/MPP payment gate runs on application routes (N45)",
    example: "Some endpoints accept HTTP 402 micropayments.",
  },
  {
    id: "aegis-content-scanning",
    pattern: /\bAEGIS\b[^.\n]{0,40}\b(scan|screen|filter|protect|block)/i,
    status: "forbidden",
    requires: "Until armed: AEGIS content scanning runs on application routes (N45)",
    example: "AEGIS content scanning protects every request.",
  },
  {
    id: "security-monitor-blocking",
    pattern:
      /security monitor[^.\n]{0,40}\b(block|ban|stop)|blocks? (malicious|suspicious|abusive) (requests|traffic|clients|IPs)/i,
    status: "forbidden",
    requires: "Until armed: the security monitor's blocking runs on application routes (N45)",
    example: "The security monitor blocks malicious requests.",
  },
  {
    id: "thesis",
    pattern: /turn abilities and inventions into trusted, economically callable capacity/i,
    status: "positioning",
    alongside: /public beta: payments settle on a test network/i,
    requires: "The public-beta status sentence beside it (steward #2807, product-steward #2574)",
    example:
      "Turn abilities and inventions into trusted, economically callable capacity that other agents can immediately build on.",
  },
  {
    id: "retired-tagline",
    pattern:
      /(?<!(not|or) ["“]?)AWS for the physical world|cloud instance for the physical world|decentralized control plane|capability network for the physical world|verifiable on-chain skill wrapper/i,
    status: "forbidden",
    requires: "Never: the operator's thesis replaces these one-line definitions (PX-17, #2574)",
    example: "PCC is AWS for the physical world.",
  },
];

/** Repo-relative files that are served publicly or read by external agents. */
export const PUBLISHED_SURFACES: readonly string[] = [
  "README.md",
  "apps/dashboard/index.html",
  "apps/dashboard/public/landing.html",
  "apps/dashboard/public/index.md",
  "apps/dashboard/public/about.html",
  "apps/dashboard/public/about.md",
  "apps/dashboard/public/llms.txt",
  "apps/dashboard/public/pricing.md",
  "apps/dashboard/public/whitepaper.md",
  "apps/dashboard/public/visualizer.js",
  "apps/dashboard/public/install.html",
  "apps/dashboard/public/onboard.html",
  "apps/dashboard/public/docs/index.html",
  "apps/dashboard/public/skills/pcc.md",
  "apps/dashboard/public/MCP_INSTALL.md",
  "apps/dashboard/public/FOUR_SLOTS.md",
  "apps/dashboard/public/auth.md",
  "apps/dashboard/public/.well-known/ai-agent.json",
  "apps/dashboard/public/.well-known/ai-plugin.json",
  "apps/dashboard/public/.well-known/mcp/server-card.json",
  "apps/dashboard/public/unbrowse-skills.json",
  "apps/dashboard/src/components/AgentLandingHero.tsx",
  "apps/dashboard/src/pages/OnboardLandingPage.tsx",
  "apps/dashboard/src/pages/OnboardKitPage.tsx",
  "apps/dashboard/src/pages/StartPage.tsx",
  "packages/gateway/src/routes/start.ts",
  "packages/gateway/src/routes/docs.ts",
  "packages/gateway/src/routes/context-pack.ts",
  "packages/gateway/src/routes/well-known-aeo.ts",
  "packages/gateway/src/server.ts",
  "docs/quickstart/README.md",
  "docs/quickstart/claude-code.md",
  "docs/quickstart/claude-desktop.md",
  "docs/quickstart/claude-web.md",
];

/**
 * Published files not checked yet. Each still carries a guarded claim and has
 * an owner who is changing it; remove the entry when that change lands.
 */
export const UNCHECKED_SURFACES: Readonly<Record<string, string>> = {
  "apps/dashboard/src/pages/LandingPage.tsx":
    "Retiring: shell PR #354 makes in-app links to / load the static landing; aeo folds its agent entrypoints into landing.html",
  "apps/dashboard/public/agent-package.json":
    "aeo (R43, single system_prompt writer): the prompt names @pcc/evidence-judge and @pcc/operator-agent-runtime, which are not on npm",
  "packages/gateway/src/routes/snippet.ts":
    "adk (R4): the /onboard/snippet.json `npx` field names @pcc/onboard, which is not on npm; publish the package or drop the field",
  "packages/onboard-kit/AGENT_INSTRUCTIONS.md":
    "adk (R3): served as /docs/agent-guide and docs://pcc/agent-guide; the rewrite replaces the fixed taxonomy and 'broker compiles'",
  "PCC-NETWORK.md":
    "Managed by LamaSu/pcc-network-kit; fix the template there (operator decision #2284)",
  "packages/gateway/src/routes/well-known.ts":
    "gateway (N45) with aeo: the A2A card's x402 security scheme and pcc-settle skill name x402/MPP payments as active",
};

/**
 * The text a surface actually publishes. Files under packages/ and
 * apps/dashboard/src/ are compiled before they ship, so their full-line
 * comments never reach a reader and are dropped here; files served as-is
 * (apps/dashboard/public/, docs/, README.md) are checked whole.
 */
export function publishedText(path: string, source: string): string {
  if (!/^(packages\/|apps\/dashboard\/src\/)/.test(path)) return source;
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*)|^\s+\*( |\/|$)/.test(line))
    .join("\n");
}

export interface ClaimViolation {
  id: string;
  status: ClaimStatus;
  match: string;
}

/**
 * Guarded claims in `text` that are not yet `live`, plus positioning claims
 * that appear without their companion statement close by.
 */
export function findClaimViolations(
  text: string,
  claims: readonly GuardedClaim[] = GUARDED_CLAIMS,
): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  for (const claim of claims) {
    if (claim.status === "live") continue;
    const flags = claim.pattern.flags.includes("g") ? claim.pattern.flags : `${claim.pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(claim.pattern.source, flags))) {
      if (claim.status === "positioning" && claim.alongside) {
        const start = Math.max(0, match.index - ALONGSIDE_WINDOW);
        const nearby = text.slice(start, match.index + match[0].length + ALONGSIDE_WINDOW);
        if (claim.alongside.test(nearby)) continue;
      }
      violations.push({ id: claim.id, status: claim.status, match: match[0] });
      break;
    }
  }
  return violations;
}
