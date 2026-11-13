import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SOURCE } from "../../scripts/generate-agent-pin.mjs";
import { AGENT_TOOLS } from "../agent-package.js";

const REPO = resolve(dirname(SOURCE), "../../..");
const read = (file: string) => readFileSync(resolve(REPO, file), "utf8");
const PIN = "700dcfe9581bb75dad9206b8db49ae6f68ebe6e6";
const INSTALL = /\b(?:pip3?|pipx|uv\s+pip|uv\s+tool)\b[^\n`;&|]*?\binstall\b[^\n`;&|]*pcc-node[^\n`;&|]*/gi;
type Tool = { name: string; description: string; endpoint: { path: string } };
type Pack = { system_prompt: string; tools: Tool[]; toolCount: number; metadata: { tool_count: number } };
const pack = () => JSON.parse(readFileSync(SOURCE, "utf8")) as Pack;
const fixture = () => JSON.parse(read("agent-package-test.json")) as Pack;
const INDEX = "packages/mcp-server/src/index.ts";
const CLI = "packages/mcp-server/src/cli.ts";
const CARD = "apps/dashboard/public/.well-known/mcp/server-card.json";
const PCC = "apps/dashboard/public/skills/pcc.md";
const ONBOARD = "apps/dashboard/public/onboard.html";
const README = "packages/mcp-server/README.md";
const PREREQ = "starter/runbook/00-prerequisites.md";
const CLAIMS = "apps/dashboard/src/lib/public-claims.ts";
const STORY = "Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain.";
const ROWS = {
  "A1a": {"path": "apps/dashboard/public/agent-package.json", "old": "`GET /api/capabilities/search?q=<plain-English need>` finds operators by natural-language match.", "new": "`GET /api/capabilities/search?q=<word>` returns unexpired listings whose name, type or one of whose materials contains that exact text, ignoring case."},
  "A1b": {"path": "apps/dashboard/public/agent-package.json", "old": "2. `GET /api/capabilities/search?q=<plain-English need>` — natural-language search across names, types, and materials. Start loose (\"someone to laser-cut acrylic\", \"overnight PCB assembly\"); you don't need the exact type string.", "new": "2. `GET /api/capabilities/search?q=<word>` — finds that exact text, ignoring case, in each unexpired listing's name, type or materials. Search with one short word (\"acrylic\", \"pcb\"): a whole sentence matches only a listing that contains that sentence."},
  "A2": {"path": "apps/dashboard/public/agent-package.json", "old": "Post a demand signal via `POST /api/bounty/*` describing what's wanted — operators watch the demand board, and new verticals appear when one registers against it. Tell the user \"no operator serves this yet, so I've posted it as demand\" rather than \"can't be done\".", "new": "Post a demand signal via `POST /api/bounty/demand` describing what's wanted. The gateway keeps it in memory but publishes no demand yet (`GET /api/bounty/demand` answers an empty list marked `suppressed`), so operators can't see the request through PCC. Tell the user \"no operator serves this yet; I've sent your request to PCC as demand\" rather than \"can't be done\"."},
  "A3": {"path": "apps/dashboard/public/agent-package.json", "old": "For high-stakes orders the user can ask for assurance-tier 2+ (photo evidence, multi-witness). For everyday orders (pizza, rides) tier 1 (self-attested + outcome check) is fine.", "new": "Assurance tiers above 0 (photo evidence, multi-witness, outcome checks) apply only to a capability type with a committed evidence program, and most types have none yet, so don't promise the user a tier: treat the evidence as self-attested and read it yourself."},
  "A3m": {"path": "apps/dashboard/public/skills/pcc.md", "old": "For high-stakes orders the user can ask for assurance-tier 2+ (photo evidence, multi-witness). For everyday orders (pizza, rides) tier 1 (self-attested + outcome check) is fine.", "new": "Assurance tiers above 0 (photo evidence, multi-witness, outcome checks) apply only to a capability type with a committed evidence program, and most types have none yet, so don't promise the user a tier: treat the evidence as self-attested and read it yourself."},
  "A4": {"path": "apps/dashboard/public/agent-package.json", "old": "settlement releases on-chain (Base Sepolia, a test network: this is a public beta) — for Max users this is gas-paid by the gateway.", "new": "nothing on the current gateway settles an offer or pays its operator yet (this is a public beta on Base Sepolia, a test network)."},
  "A4m": {"path": "apps/dashboard/public/skills/pcc.md", "old": "settlement releases on-chain (Base Sepolia, a test network: this is a public beta) — for Max users the gateway pays the gas.", "new": "nothing on the current gateway settles an offer or pays its operator yet (this is a public beta on Base Sepolia, a test network)."},
  "A5": {"path": "apps/dashboard/public/agent-package.json", "old": "The agentic onboarding flow (`POST /api/onboard/start`, tool `pcc_onboard_session_start`) handles this end-to-end if available; otherwise do it manually.", "new": "The agentic onboarding session (`POST /api/onboard/start`, tool `pcc_onboard_session_start`) can't complete a registration yet (its register call sends no API key), so do these steps yourself."},
  "A5m": {"path": "apps/dashboard/public/skills/pcc.md", "old": "The agentic onboarding flow (`POST /api/onboard/start`, tool `pcc_onboard_session_start`) handles this end-to-end if available; otherwise do it manually.", "new": "The agentic onboarding session (`POST /api/onboard/start`, tool `pcc_onboard_session_start`) can't complete a registration yet (its register call sends no API key), so do these steps yourself."},
  "A7": {"path": "apps/dashboard/public/agent-package.json", "old": "Submit a test job to verify the full pipeline works end-to-end (Step 4 of onboarding). Returns job ID and result.", "new": "Submit a test job for one device on a kernel (Step 4 of onboarding). The gateway runs it only for a kernel it operates in-process; for any other kernel it refuses and runs nothing. Every reply says whether the job ran and passed."},
  "A7f": {"path": "agent-package-test.json", "old": "Submit a test job to verify the full pipeline works end-to-end (Step 4 of onboarding). Returns job ID and result.", "new": "Submit a test job for one device on a kernel (Step 4 of onboarding). The gateway runs it only for a kernel it operates in-process; for any other kernel it refuses and runs nothing. Every reply says whether the job ran and passed."},
  "A7s": {"path": "packages/mcp-server/src/index.ts", "old": "Submit a test job to verify the full PCC pipeline works end-to-end: job submission → adapter execution → evidence collection → (optional) settlement. Returns job result with evidence bundle ID.", "new": "Submit a test job for one device on a kernel (Step 4 of onboarding). The gateway runs it only for a kernel it operates in-process; for any other kernel it refuses and runs nothing. The test-job handler includes ran and passed in its replies; authentication and other earlier refusals may omit them."},
  "A7c": {"path": "apps/dashboard/public/.well-known/mcp/server-card.json", "old": "Submit a test job to verify the full PCC pipeline works end-to-end: job submission → adapter execution → evidence collection → (optional) settlement. Returns job result with evidence bundle ID.", "new": "Submit a test job for one device on a kernel (Step 4 of onboarding). The gateway runs it only for a kernel it operates in-process; for any other kernel it refuses and runs nothing. The test-job handler includes ran and passed in its replies; authentication and other earlier refusals may omit them."},
  "A7h": {"path": "packages/mcp-server/src/cli.ts", "old": "pcc setup test-job [--kernelId=<id>] [--deviceId=<id>] [--tier=<0-3>]\n  Submit a test job to verify the full pipeline.", "new": "pcc setup test-job --kernelId=<id> --deviceId=<id> [--tier=<0-3>]\n  Submit a test job; the gateway runs it only for a kernel it operates in-process."},
  "A22a": {"path": "packages/mcp-server/src/index.ts", "old": "Target kernel. Uses default if omitted.", "new": "Target kernel (required: the gateway answers 400 without it)."},
  "A22b": {"path": "packages/mcp-server/src/index.ts", "old": "Target device. Auto-selects if omitted.", "new": "Device on that kernel (required: the gateway answers 400 without it)."},
  "A22c": {"path": "packages/mcp-server/src/index.ts", "old": "Assurance tier 0-3. Default 0 (no challenge window, auto-settle).", "new": "Assurance tier 0-3 (a test job settles nothing)."},
  "A9": {"path": "apps/dashboard/public/agent-package.json", "old": "Finalise a physical-operator onboarding session: registers the operator on PCC, mints a wallet, writes the SEO mirror, returns the publication payload (capabilities, operator_id, discovery_url). Idempotent — safe to retry inside the same session_id. Auth-required.", "new": "Finalise a physical-operator onboarding session. It mints no wallet, and it can't register the operator yet: its register call sends no API key, so the gateway refuses it and this call answers 500 `build_failed` with the refusal in `message`. A retry repeats the same refused call. Auth-required."},
  "B1": {"path": "apps/dashboard/public/agent-package.json", "old": "Signal that you want a capability that doesn't exist on the network yet. Creates a demand signal and may auto-create a bounty if enough demand accumulates.", "new": "Record that you want a capability no operator offers yet. The gateway keeps the signal in memory, publishes no demand yet, and creates no bounty."},
  "B2": {"path": "apps/dashboard/public/agent-package.json", "old": "List open bounties for capabilities the network needs. Operators can claim these to earn rewards by onboarding new capabilities.", "new": "List bounties. No gateway route creates a bounty and none is funded, so expect an empty list; no bounty pays anything."},
  "B3": {"path": "apps/dashboard/public/agent-package.json", "old": "Claim a bounty to onboard a new capability. The operator commits to registering the capability and completing verification.", "new": "Ask to take on a bounty as the authenticated operator. No gateway route creates a bounty, so the request finds none (409); no bounty is funded or pays anything."},
  "B4": {"path": "apps/dashboard/public/agent-package.json", "old": "Verify bounty completion by scoring the delivered capability against requirements.", "new": "Retired: the gateway answers 410 and changes no state. No caller can mark a bounty verified."},
  "B5": {"path": "apps/dashboard/public/agent-package.json", "old": "Get the bounty hunter leaderboard showing top operators by bounties claimed and verified.", "new": "Get the bounty leaderboard. No gateway route creates or verifies a bounty, so expect an empty list."},
  "B6": {"path": "apps/dashboard/public/agent-package.json", "old": "Get top demand signals aggregated by capability type. Shows which capabilities are most wanted on the network.", "new": "Get demand aggregated by capability type. The gateway doesn't publish demand yet: it answers an empty list marked `suppressed`."},
  "I1": {"path": "apps/dashboard/public/agent-package.json", "old": "Register a capability as a Story Protocol IP Asset. Returns an ipId and NFT token. The designer earns royalties whenever this capability is used.", "new": "Record a capability as an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. Any ipId, NFT token id or transaction hash in the reply is a placeholder, and no royalty is paid."},
  "I2": {"path": "apps/dashboard/public/agent-package.json", "old": "Register job evidence as a derivative IP asset on Story Protocol, linking it to the parent capability's IP. Operators earn royalties from derivative use.", "new": "Record job evidence as a derivative of a capability's IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. Any id or transaction hash in the reply is a placeholder, and no royalty is paid."},
  "I3": {"path": "apps/dashboard/public/agent-package.json", "old": "Set revenue splits for an IP asset among stakeholders (designer, operator, verifier, assembler, curator). Splits must sum to 100.", "new": "Set revenue splits for an IP asset among stakeholders (designer, operator, verifier, assembler, curator). Splits must sum to 100. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. No revenue is paid from these splits."},
  "I4": {"path": "apps/dashboard/public/agent-package.json", "old": "Pay royalties to an IP asset vault. The payer sends tokens that flow to stakeholders via the royalty splits.", "new": "Record a royalty payment to an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. No tokens move, and any transaction hash in the reply is a placeholder."},
  "I5": {"path": "apps/dashboard/public/agent-package.json", "old": "Claim earned revenue from an IP asset vault. Returns the claimed amount and transaction hash.", "new": "Claim an IP asset's recorded revenue. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. Nothing is paid out: any amount or transaction hash in the reply is a placeholder."},
  "I6": {"path": "apps/dashboard/public/agent-package.json", "old": "Get a revenue snapshot for an IP asset — total earned, pending claims, and recent payments.", "new": "Get the revenue PCC has recorded for an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. No revenue has been paid: any figure in the reply is a placeholder."},
  "I7": {"path": "apps/dashboard/public/agent-package.json", "old": "Get the full IP lineage chain for an asset — parent capabilities and all derivative job registrations.", "new": "Get the IP lineage PCC has recorded for an asset: parent capabilities and derivative job records. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain."},
  "I8": {"path": "apps/dashboard/public/agent-package.json", "old": "Get the Story Protocol IP registration for a capability by its capability ID.", "new": "Get the IP record PCC holds for a capability by its capability ID. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. Any id or transaction hash in it is a placeholder."},
  "I9": {"path": "apps/dashboard/public/agent-package.json", "old": "Raise a Story Protocol IP dispute against an asset. Provide evidence hash and reason.", "new": "Record an IP dispute against an asset. Provide evidence hash and reason. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain."},
  "I10s": {"path": "packages/mcp-server/src/index.ts", "old": "Register a PCC Capability StructureDefinition (CSD) as a Story Protocol IP Asset. Returns an ipId, nftTokenId, licenseTermsId, and transaction hash. The IP Asset enables programmable royalties for all future jobs using this capability.", "new": "Record a PCC Capability StructureDefinition (CSD) as an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. Any ipId, nftTokenId, licenseTermsId or transaction hash it returns is a placeholder, and no royalty is paid."},
  "I10c": {"path": "apps/dashboard/public/.well-known/mcp/server-card.json", "old": "Register a PCC Capability StructureDefinition (CSD) as a Story Protocol IP Asset. Returns an ipId, nftTokenId, licenseTermsId, and transaction hash. The IP Asset enables programmable royalties for all future jobs using this capability.", "new": "Record a PCC Capability StructureDefinition (CSD) as an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. Any ipId, nftTokenId, licenseTermsId or transaction hash it returns is a placeholder, and no royalty is paid."},
  "I11s": {"path": "packages/mcp-server/src/index.ts", "old": "Get the current revenue snapshot for a Story Protocol IP Asset — total accumulated revenue, unclaimed balance, and per-holder claimable amounts. Use this to check how much an IP Royalty Vault has accumulated.", "new": "Get the revenue PCC has recorded for an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. No revenue has been paid: any figure it returns is a placeholder."},
  "I11c": {"path": "apps/dashboard/public/.well-known/mcp/server-card.json", "old": "Get the current revenue snapshot for a Story Protocol IP Asset — total accumulated revenue, unclaimed balance, and per-holder claimable amounts. Use this to check how much an IP Royalty Vault has accumulated.", "new": "Get the revenue PCC has recorded for an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. No revenue has been paid: any figure it returns is a placeholder."},
  "I12s": {"path": "packages/mcp-server/src/index.ts", "old": "Claim accumulated revenue from a Story Protocol IP Royalty Vault. Returns a transaction hash and the amount claimed. Optionally specify which Royalty Token IDs to claim; omit to claim all.", "new": "Claim an IP asset's recorded revenue. Optionally specify which Royalty Token IDs to claim; omit to claim all. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. Nothing is paid out: any amount or transaction hash it returns is a placeholder."},
  "I12c": {"path": "apps/dashboard/public/.well-known/mcp/server-card.json", "old": "Claim accumulated revenue from a Story Protocol IP Royalty Vault. Returns a transaction hash and the amount claimed. Optionally specify which Royalty Token IDs to claim; omit to claim all.", "new": "Claim an IP asset's recorded revenue. Optionally specify which Royalty Token IDs to claim; omit to claim all. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. Nothing is paid out: any amount or transaction hash it returns is a placeholder."},
  "I13s": {"path": "packages/mcp-server/src/index.ts", "old": "Get the full IP lineage chain for a Story Protocol IP Asset — ancestors (parent CSDs this was derived from) and descendants (job evidence bundles and derivative CSDs). Shows the provenance graph of physical manufacturing work.", "new": "Get the IP links PCC has recorded in this process for an IP asset: direct parents and up to two descendant levels from job-evidence records. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain."},
  "I13c": {"path": "apps/dashboard/public/.well-known/mcp/server-card.json", "old": "Get the full IP lineage chain for a Story Protocol IP Asset — ancestors (parent CSDs this was derived from) and descendants (job evidence bundles and derivative CSDs). Shows the provenance graph of physical manufacturing work.", "new": "Get the IP links PCC has recorded in this process for an IP asset: direct parents and up to two descendant levels from job-evidence records. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain."},
  "I14s": {"path": "packages/mcp-server/src/index.ts", "old": "Configure revenue splits (Royalty Token distribution) for a Story Protocol IP Asset.\",\n    \"Splits must sum to 100. Each collaborator's role determines their share of all future revenue from this IP.", "new": "Configure revenue splits (Royalty Token distribution) for an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain.\",\n    \"Splits must sum to 100. No revenue is paid from them today."},
  "I14c": {"path": "apps/dashboard/public/.well-known/mcp/server-card.json", "old": "Configure revenue splits (Royalty Token distribution) for a Story Protocol IP Asset.\nSplits must sum to 100. Each collaborator's role determines their share of all future revenue from this IP.\n\nContributorRole taxonomy (ADR-12 §4 — see role responsibility table):\n  • operator             — runs the physical machine; residual share (typically 80-95% after others)\n  • verifier             — evaluates evidence, signs attestations; slashable (1-5%)\n  • insurer              — underwrites job failure coverage; opt-in (0-3%)\n  • integrator           — authored the machine-type adapter (OctoPrint, Bambu, ROS); 0-100 bps\n  • protocol-author      — authored the capability schema (CSD) + test vectors; 0-50 bps\n  • model-author         — trained the AI model invoked at execution time; 0-80 bps\n  • dataset-contributor  — pilot who collected training demonstrations; resolved via TrainingManifest\n  • curator              — organizes/audits a collection of contributions; 0-5%\n  • assembler            — composed multiple capabilities into a workflow; 0-50 bps\n\nLegacy aliases kept for backward decoding only — prefer the canonical names above:\n  • `designer` → use `protocol-author` / `assembler` / `integrator` depending on CSD kind\n  • `network`  → use `network-treasury`\n\nRecommended starting splits:\n  • Standard job (no AI):   operator 93, verifier 3, protocol-author 2, integrator 2\n  • Job with AI model:      operator 89, verifier 3, protocol-author 2, integrator 2, model-author 4\n\n", "new": "Configure revenue splits (Royalty Token distribution) for an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain.\nSplits must sum to 100. No revenue is paid from them today.\n\nContributorRole taxonomy (ADR-12 §4 — see role responsibility table):\n  • operator             — runs the physical machine; residual share (typically 80-95% after others)\n  • verifier             — evaluates evidence, signs attestations; slashable (1-5%)\n  • insurer              — underwrites job failure coverage; opt-in (0-3%)\n  • integrator           — authored the machine-type adapter (OctoPrint, Bambu, ROS); 0-100 bps\n  • protocol-author      — authored the capability schema (CSD) + test vectors; 0-50 bps\n  • model-author         — trained the AI model invoked at execution time; 0-80 bps\n  • dataset-contributor  — pilot who collected training demonstrations; resolved via TrainingManifest\n  • curator              — organizes/audits a collection of contributions; 0-5%\n  • assembler            — composed multiple capabilities into a workflow; 0-50 bps\n\nLegacy aliases kept for backward decoding only — prefer the canonical names above:\n  • `designer` → use `protocol-author` / `assembler` / `integrator` depending on CSD kind\n  • `network`  → no name above replaces it; leave it out of new splits\n\nRecommended starting splits:\n  • Standard job (no AI):   operator 93, verifier 3, protocol-author 2, integrator 2\n  • Job with AI model:      operator 89, verifier 3, protocol-author 2, integrator 2, model-author 4\n\n"},
  "A12": {"path": "apps/dashboard/public/llms.txt", "old": "The `pcc-node` daemon polls for jobs and runs them locally; your endpoint never faces the network.", "new": "`pcc-node` keeps the kernel online and takes no jobs: devices run only through the operating agent's typed operations."},
  "A12o": {"path": "apps/dashboard/public/onboard.html", "old": "</code> polls for jobs and runs them locally.</span>", "new": "</code> keeps the kernel online and takes no jobs.</span>"},
  "A14": {"path": "apps/dashboard/public/llms.txt", "old": "- Settlement is real milestone escrow; funds release only when evidence meets the contracted assurance tier.", "new": "- Settlement isn't wired to job offers yet: no gateway route settles an offer or pays its operator, and a tier above 0 needs a committed evidence program that most capability types don't have."},
  "A14s1": {"path": "skills/pcc/SKILL.md", "old": "| Payment | **Milestone escrow** on-chain (Base) — funds release only when evidence meets the tier |", "new": "| Payment | **Milestone escrow** on Base Sepolia, a test network — not wired to job offers yet: nothing settles an offer or pays its operator |"},
  "A14s2": {"path": ".claude/skills/pcc/SKILL.md", "old": "| Payment | **Milestone escrow** on-chain (Base) — funds release only when evidence meets the tier |", "new": "| Payment | **Milestone escrow** on Base Sepolia, a test network — not wired to job offers yet: nothing settles an offer or pays its operator |"},
  "A15a": {"path": "apps/dashboard/public/onboard.html", "old": "lab:\"prove → your pcc-node picks the job up and runs it locally\"", "new": "lab:\"test job: refused unless the gateway runs this kernel in-process\""},
  "A15b": {"path": "apps/dashboard/public/onboard.html", "old": "PCC queues a test job. Your <code style=\"font-family:var(--mono);color:var(--cyan)\">pcc-node</code> picks it up, runs it on the device, posts an evidence bundle. Clean run → auto-activate, no human approval.", "new": "The gateway runs a test job only for a kernel it operates in-process. For a kernel your <code style=\"font-family:var(--mono);color:var(--cyan)\">pcc-node</code> keeps online it refuses and runs nothing, and a test job activates nothing."},
  "A15c": {"path": "apps/dashboard/public/onboard.html", "old": "POST /api/setup/test-job · polls to completion · emits evidence bundle", "new": "POST /api/setup/test-job · runs only on a kernel the gateway operates in-process"},
  "A16a": {"path": "apps/dashboard/public/install.html", "old": "Bring your hardware online on the Physical Capability Cloud network in 60 seconds.", "new": "Install pcc-node next to your machine to keep its kernel online on the Physical Capability Cloud network."},
  "A16b": {"path": "apps/dashboard/public/install.html", "old": "Bring your hardware online on capability.network in about 60 seconds.", "new": "Install pcc-node to keep your machine's kernel online on capability.network. Buyers find it only after you publish a capability."},
  "A16c": {"path": "apps/dashboard/public/screen.html", "old": "Scan to onboard your hardware on capability.network — about 60 seconds end-to-end.", "new": "Scan to start onboarding your hardware on capability.network."},
  "A17": {"path": "packages/onboard-kit/AGENT_INSTRUCTIONS.md", "old": "pnpm add @pcc/spec @pcc/kernel @pcc/a2a @pcc/agent-runtime @pcc/agent-kernel @pcc/contract-builder @pcc/onboard-kit", "new": "# These packages are not on npm: build them in a clone of the PCC repo (pnpm install && pnpm build) and link them into your project."},
  "A18": {"path": "packages/onboard-kit/AGENT_INSTRUCTIONS.md", "old": "relayUrl: \"http://gateway.pcc.network:3200\",  // PCC Gateway URL", "new": "relayUrl: process.env.PCC_GATEWAY_URL!,  // the PCC gateway URL you were given"},
  "A19": {"path": "packages/onboard-kit/AGENT_INSTRUCTIONS.md", "old": "npx pcc-onboard validate --kernel-config ./kernel-config.json\n\n# This checks:\n# ✓ All adapters implement required interfaces\n# ✓ Capabilities have valid types, materials, pricing\n# ✓ Evidence emitter produces valid bundles\n# ✓ Bundle hashes are correct (canonical JSON SHA-256)\n# ✓ Machine profiles match capability templates\n# ✓ Wallet can sign messages\n# ✓ Kernel agent registers and responds to intents", "new": "pcc-onboard validate --config ./kernel-config.json   # from a built clone of the PCC repo: the package is not on npm\n\n# This checks the config file's fields only. It runs no adapter, evidence emitter, wallet or agent."},
  "A20": {"path": "docs/CAPABILITY_PROFILES.md", "old": "CSDs are stored in three places:\n1. **IPFS** — canonical, content-addressed, immutable (the source of truth)\n2. **SQLite** — local cache for fast queries (the working copy)\n3. **On-chain** — hash commitment for integrity (the proof it hasn't been tampered with)", "new": "CSDs are held in the gateway's process memory, in a registry keyed by each CSD's url: registering a CSD whose url is already held replaces it. Nothing stores CSDs on IPFS or on chain yet."},
  "A21p": {"path": "apps/dashboard/public/FOUR_SLOTS.md", "old": "inheritable via `baseDefinition`, versioned. Five base CSDs ship today\n(FDM, SLA, CNC 3-axis, laser cut, 2D print); the top-50 catalog is seeded.", "new": "inheritable via `baseDefinition`, versioned. Built-in CSDs ship today\n(FDM, SLA, CNC 3-axis, laser cut and 2D print among them); no wider catalog is seeded."},
  "A21d": {"path": "docs/FOUR_SLOTS.md", "old": "inheritable via `baseDefinition`, versioned. Five base CSDs ship today\n(FDM, SLA, CNC 3-axis, laser cut, 2D print); the top-50 catalog is seeded.", "new": "inheritable via `baseDefinition`, versioned. Built-in CSDs ship today\n(FDM, SLA, CNC 3-axis, laser cut and 2D print among them); no wider catalog is seeded."},
  "A23": {"path": "packages/onboard-cli/README.md", "old": "All three paths end up at the same place: a real registered capability,\nkernel, or channel on https://capability.network.", "new": "The browser chat (path 1) can't complete a registration yet: its tool calls\ncarry no API key. Check each step's result on the other paths too."},
  "A24": {"path": "starter/runbook/06-verify.md", "old": "On the current gateway it runs on a built-in mock device, not yours (board N59; the fix is #450).", "new": "On the current gateway it refuses any kernel the gateway doesn't operate in-process, yours included, and runs nothing (board N59)."},
  "A25": {"path": "starter/runbook/08-publish.md", "old": "**Coming:** the kit registry (kits, #397) and the split helper (economics' `computeKitSplit`, #492) will turn this into one publish call, with the exact split shown before you confirm.", "new": "**Coming:** one publish call that shows the exact split before you confirm. The kit registry (kits, #511) and the split helper (economics' `computeKitSplit`, #492) are both merged, but no publish route uses the helper yet."},
  "A25b": {"path": "starter/runbook/08-publish.md", "old": "Until they land, record the human's decision exactly:", "new": "Until that call lands, record the human's decision exactly:"},
  "R1a": {"path": "docs/ADAPTER_BOUNTIES.md", "old": "**Status**: Open. Bounties are claimable today.", "new": "**Status**: Not funded. Nothing in this document can be claimed or paid today: no route claims, verifies or pays a bounty, and the amounts below are a proposal, not an offer."},
  "R1b": {"path": "docs/ADAPTER_BOUNTIES.md", "old": "We are paying **$2,000 to $10,000 USD** flat **plus a 250bp lifetime royalty**\non every job that uses your adapter, for the first 50 priority machine-type\nadapters listed in §4. The royalty is on-chain, immutable, content-addressed,\nand routed through `MilestoneEscrow.splitPayout()`. Apache-2.0 licensed,\npublic source repo, you keep ownership of the `ContributorNFT`.", "new": "No bounty is funded, so nothing below is paid today, and no royalty is routed\nto anyone. The program would cover the priority machine-type adapters listed\nin §4. Adapters are Apache-2.0 licensed, in a public source repo, and you\nkeep ownership of your work."},
  "I15p": {"path": "apps/dashboard/public/MCP_INSTALL.md", "old": "Story Protocol royalties, fiat on/off-ramps", "new": "Story Protocol (now The DATA Foundation) IP records with no on-chain call, fiat on/off-ramps"},
  "I16p": {"path": "apps/dashboard/public/MCP_INSTALL.md", "old": "a kernel, funding escrow, claiming royalties) need one.", "new": "a kernel, funding escrow, recording IP) need one."},
  "I17p": {"path": "apps/dashboard/public/MCP_INSTALL.md", "old": "| Story Protocol IP |", "new": "| Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. |"},
  "I15d": {"path": "docs/MCP_INSTALL.md", "old": "Story Protocol royalties, fiat on/off-ramps", "new": "Story Protocol (now The DATA Foundation) IP records with no on-chain call, fiat on/off-ramps"},
  "I16d": {"path": "docs/MCP_INSTALL.md", "old": "a kernel, funding escrow, claiming royalties) need one.", "new": "a kernel, funding escrow, recording IP) need one."},
  "I17d": {"path": "docs/MCP_INSTALL.md", "old": "| Story Protocol IP |", "new": "| Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. |"},
  "A26c": {"path": "apps/dashboard/public/.well-known/mcp/server-card.json", "old": "  • `network`  → use `network-treasury`", "new": "  • `network`  → no name above replaces it; leave it out of new splits"},
  "A26s": {"path": "packages/mcp-server/src/index.ts", "old": "  • `network`  → use `network-treasury`", "new": "  • `network`  → no name above replaces it; leave it out of new splits"},
  "A27": {"path": "apps/dashboard/public/agent-package.json", "old": "Starting from a fuzzy, natural-language ask is safe. The negotiate→commit dialogue (`POST /api/negotiate/session` → refine selections → commit) sharpens a loose request into exact, priced acceptance criteria BEFORE any settlement — nothing is charged until you commit a fully-specified contract, so looseness at discovery time costs nothing.", "new": "A negotiation session (`POST /api/negotiate/session`) doesn't start from a loose ask: it needs an exact capability type and one kernel that offers it. Its steps (select → quote → review → commit) turn that type's parameters into a priced quote and contract terms, and no step before commit charges anything."},
  "A28a": {"path": "apps/dashboard/public/onboard.html", "old": "POST /api/skills/&lt;id&gt;/verify · ALCOA+ · auto-activates at Tier 1", "new": "POST /api/skills/&lt;id&gt;/verify · no gateway route serves this yet, so nothing activates here"},
  "A28b": {"path": "apps/dashboard/public/onboard.html", "old": "Human skills activate on real evidence.", "new": "No gateway route verifies a skill from its evidence yet, so this step activates nothing."},
  "A28c": {"path": "apps/dashboard/public/onboard.html", "old": "lab:\"prove a job → photo + GPS → activate (Tier 1)\"", "new": "lab:\"photo + GPS evidence: no gateway route takes it yet\""},
  "N2s": {"path": "packages/mcp-server/src/index.ts", "old": "Get reputation scores for a PCC kernel or agent — assurance tier, quality rating, uptime, response time, and evidence completeness.", "new": "Get the composition reputation PCC records for an agent or kernel: its score and its most recent changes. An id PCC has never seen reads as neutral."},
  "N2c": {"path": "apps/dashboard/public/.well-known/mcp/server-card.json", "old": "Get reputation scores for a PCC kernel or agent — assurance tier, quality rating, uptime, response time, and evidence completeness.", "new": "Get the composition reputation PCC records for an agent or kernel: its score and its most recent changes. An id PCC has never seen reads as neutral."},
  "N2h": {"path": "packages/mcp-server/src/cli.ts", "old": "pcc reputation get <agentId> [--tag=<tag>]\n  Get reputation scores for a kernel or agent.", "new": "pcc reputation get <agentId>\n  Get the composition reputation PCC records for a kernel or agent."},
  "A29": {"path": "apps/dashboard/public/agent-package.json", "old": "Operators are ERC-8004 identities with reputation scores tied to evidence-verified completions.", "new": "Operators are ERC-8004 identities, but no reputation score is tied to verified evidence yet: none checks evidence before it changes, so don't read a high score as proof of good work."},
  "A29m": {"path": "apps/dashboard/public/skills/pcc.md", "old": "Operators are ERC-8004 identities with reputation scores tied to evidence-verified completions.", "new": "Operators are ERC-8004 identities, but no reputation score is tied to verified evidence yet: none checks evidence before it changes, so don't read a high score as proof of good work."},
  "A30a": {"path": "apps/dashboard/public/onboard.html", "old": "Prove it works → go live.", "new": "Prove it works."},
  "A30b": {"path": "apps/dashboard/public/onboard.html", "old": "Prove a job → go live.", "new": "Prove a job."},
  "A31": {"path": "docs/AGENT_INTEGRATION.md", "old": "The same four helpers are surfaced as agent-package tools (see §8) so external LLMs can discover them: `pcc_trilobio_build_config`, `pcc_trilobio_validate_options`, `pcc_trilobio_validate_script`, `pcc_trilobio_capability_template`.", "new": "The agent package carries none of these helpers as tools: no gateway route serves them yet."},
  "A6": {"path": "apps/dashboard/public/agent-package.json", "old": "`python3 -m pip install \"pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@1d11f37203f99eb1c9f2cfcd2b5ccf278e835820#subdirectory=packages/pcc-node\"`", "new": "`python3 -m pip install \"pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@700dcfe9581bb75dad9206b8db49ae6f68ebe6e6#subdirectory=packages/pcc-node\"`"},
  "A6m": {"path": "apps/dashboard/public/skills/pcc.md", "old": "`python3 -m pip install \"pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@1d11f37203f99eb1c9f2cfcd2b5ccf278e835820#subdirectory=packages/pcc-node\"`", "new": "`python3 -m pip install \"pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@700dcfe9581bb75dad9206b8db49ae6f68ebe6e6#subdirectory=packages/pcc-node\"`"},
  "A6s1": {"path": "skills/pcc/SKILL.md", "old": "`python3 -m pip install \"pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@1d11f37203f99eb1c9f2cfcd2b5ccf278e835820#subdirectory=packages/pcc-node\"`", "new": "`python3 -m pip install \"pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@700dcfe9581bb75dad9206b8db49ae6f68ebe6e6#subdirectory=packages/pcc-node\"`"},
  "A6s2": {"path": ".claude/skills/pcc/SKILL.md", "old": "`python3 -m pip install \"pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@1d11f37203f99eb1c9f2cfcd2b5ccf278e835820#subdirectory=packages/pcc-node\"`", "new": "`python3 -m pip install \"pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@700dcfe9581bb75dad9206b8db49ae6f68ebe6e6#subdirectory=packages/pcc-node\"`"},
  "A32a": {"path": "packages/mcp-server/src/cli.ts", "old": "pcc ip splits <ipId> --splits='[{\"address\":\"0x...\",\"role\":\"protocol-author\",\"percentage\":2,\"label\":\"CSD Author\"},{\"address\":\"0x...\",\"role\":\"integrator\",\"percentage\":2,\"label\":\"Adapter Integrator\"},{\"address\":\"0x...\",\"role\":\"operator\",\"percentage\":92,\"label\":\"Machine Operator\"},{\"address\":\"0x...\",\"role\":\"verifier\",\"percentage\":3,\"label\":\"Evidence Verifier\"},{\"address\":\"0x...\",\"role\":\"network-treasury\",\"percentage\":1,\"label\":\"Network Treasury\"}]'\n  Configure revenue splits for an IP Asset. Splits must sum to 100.\n  Roles (ADR-12): operator, verifier, insurer, integrator, protocol-author,\n  model-author, dataset-contributor, curator, assembler, network-treasury.\n  Legacy aliases 'designer' and 'network' still decode for backward compat —\n  prefer the canonical names above.", "new": "pcc ip splits <ipId> --splits='[{\"address\":\"0x...\",\"role\":\"operator\",\"percentage\":93,\"label\":\"Machine Operator\"},{\"address\":\"0x...\",\"role\":\"verifier\",\"percentage\":3,\"label\":\"Evidence Verifier\"},{\"address\":\"0x...\",\"role\":\"protocol-author\",\"percentage\":2,\"label\":\"CSD Author\"},{\"address\":\"0x...\",\"role\":\"integrator\",\"percentage\":2,\"label\":\"Adapter Integrator\"}]'\n  Configure revenue splits for an IP Asset. Splits must sum to 100. No revenue is paid from them today.\n  Roles (ADR-12): operator, verifier, insurer, integrator, protocol-author,\n  model-author, dataset-contributor, curator, assembler.\n  Legacy aliases kept for backward decoding only — prefer the canonical names above:\n  'designer' → use 'protocol-author', 'assembler' or 'integrator', depending on CSD kind;\n  'network' → no name above replaces it; leave it out of new splits."},
  "A32b": {"path": "packages/mcp-server/src/cli.ts", "old": "  Register a capability as a Story Protocol IP Asset.", "new": "  Record a capability as an IP asset. Story Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain. Any id it returns is a placeholder, and no royalty is paid."},
  "A32c": {"path": "packages/mcp-server/src/cli.ts", "old": "  Get revenue snapshot for an IP Asset.", "new": "  Get the revenue PCC has recorded for an IP asset. No revenue has been paid: any figure it returns is a placeholder."},
  "A32d": {"path": "packages/mcp-server/src/cli.ts", "old": "  Claim accumulated revenue from an IP Royalty Vault.", "new": "  Claim an IP asset's recorded revenue. Nothing is paid out: any amount or transaction hash it returns is a placeholder."},
  "A32e": {"path": "packages/mcp-server/src/cli.ts", "old": "  Get IP lineage chain (ancestors + descendants).", "new": "  Get the IP links PCC has recorded in this process for an IP asset: direct parents and up to two descendant levels from job-evidence records."},
  "A33a": {"path": "packages/mcp-server/README.md", "old": "PCC is AWS for the physical world. Shop Kernels are availability zones. ", "new": "PCC connects agents to Shop Kernels: the sites whose machines and people do physical work. "},
  "A33b": {"path": "packages/mcp-server/README.md", "old": "| `pcc_get_reputation` | Reputation scores by agent/tag (quality, uptime, assurance). |", "new": "| `pcc_get_reputation` | The composition reputation PCC records for an agent or kernel: its score and its most recent changes. An id PCC has never seen reads as neutral. |"},
  "A33c": {"path": "packages/mcp-server/README.md", "old": "| `pcc_setup_test_job` | Submit a test job end-to-end to verify the pipeline. |", "new": "| `pcc_setup_test_job` | Submit a test job for one device on a kernel. The gateway runs it only for a kernel it operates in-process; for any other kernel it refuses and runs nothing. The test-job handler includes ran and passed in its replies; authentication and other earlier refusals may omit them. |"},
  "A33d": {"path": "packages/mcp-server/README.md", "old": "### Story Protocol IP and royalties (5)", "new": "### IP records (5)\n\nStory Protocol (now The DATA Foundation). These tools make no on-chain call: nothing is registered, claimed or disputed on chain."},
  "A33e": {"path": "packages/mcp-server/README.md", "old": "| `pcc_ip_register_capability` | Register a CSD as a Story Protocol IP Asset; enables programmable royalties. |", "new": "| `pcc_ip_register_capability` | Record a CSD as an IP asset. Any id or transaction hash it returns is a placeholder, and no royalty is paid. |"},
  "A33f": {"path": "packages/mcp-server/README.md", "old": "| `pcc_ip_revenue_snapshot` | Total accumulated revenue + unclaimed balance for an IP Asset. |", "new": "| `pcc_ip_revenue_snapshot` | The revenue PCC has recorded for an IP asset. No revenue has been paid: any figure it returns is a placeholder. |"},
  "A33g": {"path": "packages/mcp-server/README.md", "old": "| `pcc_ip_claim` | Claim accumulated revenue from an IP Royalty Vault. |", "new": "| `pcc_ip_claim` | Claim an IP asset's recorded revenue. Nothing is paid out: any amount or transaction hash it returns is a placeholder. |"},
  "A33h": {"path": "packages/mcp-server/README.md", "old": "| `pcc_ip_lineage` | Full ancestor + descendant lineage graph for an IP Asset. |", "new": "| `pcc_ip_lineage` | The IP links PCC has recorded in this process for an IP asset: direct parents and up to two descendant levels from job-evidence records. |"},
  "A33i": {"path": "packages/mcp-server/README.md", "old": "| `pcc_ip_set_splits` | Configure revenue splits across the 10-role ContributorRole taxonomy. |", "new": "| `pcc_ip_set_splits` | Configure revenue splits for an IP asset. Splits must sum to 100. No revenue is paid from them today. |"},
  "A34a": {"path": "apps/dashboard/public/onboard.html", "old": "${S.proof.test?'✓ test job passed':'▸ queue test job'}", "new": "${S.proof.test?'✓ in your plan':'▸ queue test job'}"},
  "A34b": {"path": "apps/dashboard/public/onboard.html", "old": " Capture a photo + your GPS — that's a Tier 1 bundle.</p>", "new": " Capture a photo + your GPS.</p>"},
  "A34c": {"path": "apps/dashboard/public/onboard.html", "old": "${S.proof.demand?'✓ demand posted, composed':'▸ post sample demand'}", "new": "${S.proof.demand?'✓ in your plan':'▸ post sample demand'}"},
  "A35a": {"path": "apps/dashboard/public/onboard.html", "old": "p.push({s:3,m:\"POST\",path:\"/api/skills\",lab:\"publish the human-node skill (PR #90)\",b:sk});", "new": "p.push({s:3,m:\"POST\",path:\"/api/skills\",terminal:1,lab:\"publish the human-node skill: no gateway route takes this call yet\",b:sk});"},
  "A35b": {"path": "apps/dashboard/public/onboard.html", "old": "p.push({s:4,m:\"POST\",path:\"/api/skills/${skillId}/verify\",lab:\"photo + GPS evidence: no gateway route takes it yet\",", "new": "p.push({s:4,m:\"POST\",path:\"/api/skills/${skillId}/verify\",terminal:1,lab:\"photo + GPS evidence: no gateway route takes it yet\","},
  "A36": {"path": "starter/runbook/00-prerequisites.md", "old": "pcc-node runs next to the device. It registers the kernel, signs its evidence and runs jobs.", "new": "pcc-node runs next to the device. It registers the kernel and signs its evidence; its daemon takes no jobs."},
} as const;
const SERVED_ROWS = ["A12", "A12o", "A14", "A14s1", "A14s2", "A15a", "A15b", "A15c", "A16a", "A16b", "A16c", "A17", "A18", "A19", "A20", "A21p", "A21d", "A23", "A24", "A25", "A25b", "R1a", "R1b", "I15p", "I16p", "I17p", "I15d", "I16d", "I17d"] as const;

type RowId = keyof typeof ROWS;
function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}
function changed(id: RowId, text = read(ROWS[id].path)): void {
  expect(occurrences(text, ROWS[id].old), `${id}: OLD`).toBe(0);
  expect(occurrences(text, ROWS[id].new), `${id}: NEW`).toBe(1);
}
function description(pkg: Pack, name: string): string {
  const tool = pkg.tools.find((entry) => entry.name === name);
  expect(tool, name).toBeDefined();
  return tool!.description;
}
function toolBlock(source: string, name: string): string {
  const blocks = source.split("server.tool(").slice(1);
  const block = blocks.find((entry) => entry.trimStart().startsWith(`"${name}",`));
  expect(block, name).toBeDefined();
  return block!;
}
function cardTools(): Tool[] {
  return (JSON.parse(read(CARD)) as { tools: Tool[] }).tools;
}

describe("N240 public claims", () => {
  it("PC1 search, demand, assurance, settlement and onboarding copy matches today's gateway", () => {
    const prompt = pack().system_prompt;
    for (const id of ["A1a", "A1b", "A2", "A3", "A4", "A5"] as const) changed(id, prompt);
    for (const id of ["A3m", "A4m", "A5m"] as const) changed(id, read(PCC));
  });

  it("PC2 the bounty family in the pack and root fixture makes no reward or creation promise", () => {
    const names = ["submit_demand", "list_bounties", "claim_bounty", "verify_bounty", "get_bounty_leaderboard", "get_top_demand"];
    const ids = ["B1", "B2", "B3", "B4", "B5", "B6"] as const;
    for (const pkg of [pack(), fixture()]) {
      for (const [i, name] of names.entries()) {
        const text = description(pkg, name);
        expect(text).toBe(ROWS[ids[i]].new);
        expect(text).not.toMatch(/earn rewards|auto-create|commits to/i);
      }
    }
  });

  it.each([
    ["I1", "register_capability_ip"],
    ["I2", "register_job_evidence_ip"],
    ["I3", "distribute_royalties"],
    ["I4", "pay_ip_royalty"],
    ["I5", "claim_ip_revenue"],
    ["I6", "get_ip_revenue"],
    ["I7", "get_ip_lineage"],
    ["I8", "get_capability_ip"],
    ["I9", "raise_ip_dispute"],
  ] as const)("PC3 %s keeps the exact IP description in the pack and root fixture", (id, name) => {
    for (const pkg of [pack(), fixture()]) {
      expect(description(pkg, name)).toBe(ROWS[id].new);
    }
  });

  it("PC3 every IP tool carries the Story sentence and promises no on-chain revenue", () => {
    const ipTools = pack().tools.filter((tool) => tool.endpoint.path.startsWith("/api/ip/"));
    const index = read(INDEX);
    const names = [...index.matchAll(/server\.tool\(\s*"(pcc_ip_[^"]+)"/g)].map((match) => match[1]);
    const cards = cardTools().filter((tool) => tool.name.startsWith("pcc_ip_"));
    expect(ipTools).toHaveLength(9);
    expect(names).toHaveLength(5);
    expect(cards).toHaveLength(5);
    for (const [sourceId, cardId, name] of [
      ["I10s", "I10c", "pcc_ip_register_capability"],
      ["I11s", "I11c", "pcc_ip_revenue_snapshot"],
      ["I12s", "I12c", "pcc_ip_claim"],
      ["I13s", "I13c", "pcc_ip_lineage"],
      ["I14s", "I14c", "pcc_ip_set_splits"],
    ] as const) {
      changed(sourceId, toolBlock(index, name));
      expect(cards.find((tool) => tool.name === name)?.description).toBe(ROWS[cardId].new);
    }
    const texts = [...ipTools.map((tool) => tool.description), ...names.map((name) => toolBlock(index, name)), ...cards.map((tool) => tool.description)];
    for (const text of texts) {
      expect(text).toContain(STORY);
      expect(text).not.toMatch(/earns? royalties|flow to stakeholders|earned revenue|programmable royalties|future revenue/i);
    }
  });

  it("PC4 test-job copy requires a kernel operated in-process and explicit kernel and device ids", () => {
    expect(description(pack(), "setup_test_job")).toBe(ROWS.A7.new);
    expect(description(fixture(), "setup_test_job")).toBe(ROWS.A7f.new);
    expect(cardTools().find((tool) => tool.name === "pcc_setup_test_job")?.description).toBe(ROWS.A7c.new);
    const index = read(INDEX);
    for (const id of ["A7s", "A22a", "A22b"] as const) changed(id, index);
    changed("A22c", index);
    changed("A7h");
  });

  it("PC5 build-agent describes the refused register call, build_failed and retry", () => {
    const text = description(pack(), "pcc_onboard_session_build_agent");
    expect(text).toBe(ROWS.A9.new);
    expect(text).not.toMatch(/mints a wallet/i);
    expect(text).not.toContain("Idempotent");
    expect(text).toContain("build_failed");
  });

  it("PC6 stdio and CLI reputation handlers use the served route and accept no tag", () => {
    const index = toolBlock(read(INDEX), "pcc_get_reputation");
    changed("N2s", index);
    changed("N2h");
    expect(cardTools().find((tool) => tool.name === "pcc_get_reputation")?.description).toBe(ROWS.N2c.new);
    const cli = read(CLI);
    const start = cli.indexOf("  reputation: {");
    expect(start).toBeGreaterThanOrEqual(0);
    const handler = cli.slice(start, cli.indexOf("\n  // ---------- depin", start));
    for (const text of [index, handler]) {
      expect(text).toContain('`/api/reputation/${encodeURIComponent(agentId)}`');
      expect(text).not.toContain("/api/registry/entities/${");
      expect(text).not.toMatch(/\btag\b/);
    }
    expect(cli).not.toContain("[--tag=<tag>]");
    expect(read("packages/gateway/src/routes/reputation.ts")).toContain('"/api/reputation/:agentId"');
  });

  it.each(SERVED_ROWS)("PC7 %s replaces the served-page claim exactly once", (id) => {
    changed(id);
  });

  it("PC8 the pack and generated pin carry no Trilobio tools and both counts match", () => {
    const pkg = pack();
    const raw = readFileSync(SOURCE, "utf8");
    expect(raw).not.toContain("pcc_trilobio_");
    for (const tool of pkg.tools) {
      expect(tool.name).not.toMatch(/^pcc_trilobio_/);
      expect(tool.endpoint.path).not.toMatch(/^\/api\/helpers\/trilobio\//);
    }
    for (const [name, endpoint] of Object.entries(AGENT_TOOLS)) {
      expect(name).not.toMatch(/^pcc_trilobio_/);
      expect(endpoint.path).not.toMatch(/^\/api\/helpers\/trilobio\//);
    }
    expect(pkg.toolCount).toBe(pkg.tools.length);
    expect(pkg.metadata.tool_count).toBe(pkg.tools.length);
  });

  it("PC9 both split descriptions retire the network-treasury alias", () => {
    const card = cardTools().find((tool) => tool.name === "pcc_ip_set_splits")!.description;
    changed("A26c", card);
    changed("A26s", toolBlock(read(INDEX), "pcc_ip_set_splits"));
    for (const text of [read(CARD), read(INDEX)]) expect(text).not.toContain("use `network-treasury`");
  });

  it("PC10 negotiation and reputation copy describes exact types and unchecked evidence", () => {
    const prompt = pack().system_prompt;
    changed("A27", prompt);
    changed("A29", prompt);
    changed("A29m");
  });

  it("PC11 the human evidence step makes no activation promise", () => {
    for (const id of ["A28a", "A28b", "A28c"] as const) changed(id, read(ONBOARD));
  });

  it("PC12 prove-step headings make no go-live promise", () => {
    const text = read(ONBOARD);
    for (const id of ["A30a", "A30b"] as const) changed(id, text);
    expect(text).not.toContain("→ go live.");
  });

  it("PC13 the integration guide carries no unserved Trilobio tools", () => {
    changed("A31");
    expect(read(ROWS.A31.path)).not.toContain("pcc_trilobio_");
  });

  it("PC16 the CLI split help names no treasury share", () => {
    const cli = read(CLI);
    for (const id of ["A32a", "A32b", "A32c", "A32d", "A32e"] as const) changed(id, cli);
    expect(cli).not.toContain("network-treasury");
    expect(cli).not.toContain("Network Treasury");
    const marker = "pcc ip splits <ipId> --splits='";
    expect(occurrences(cli, marker)).toBe(1);
    const start = cli.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const example = cli.slice(start + marker.length, cli.indexOf("'", start + marker.length));
    const splits = JSON.parse(example) as { percentage: number; role: string; label: string }[];
    expect(splits.reduce((sum, entry) => sum + entry.percentage, 0)).toBe(100);
    for (const entry of splits) {
      expect(entry.role).not.toBe("network");
      expect(entry.role).not.toBe("network-treasury");
      expect(entry.label).not.toMatch(/treasury/i);
    }
  });

  it("PC17 the MCP README is a published surface and its rows match the stdio texts", () => {
    const readme = read(README);
    for (const id of ["A33a", "A33b", "A33c", "A33d", "A33e", "A33f", "A33g", "A33h", "A33i"] as const) changed(id, readme);
    expect(readme).not.toContain("AWS for the physical world");
    expect(readme).not.toContain("programmable royalties");
    expect(readme).not.toContain("Royalty Vault");
    const claims = read(CLAIMS);
    const publishedStart = claims.indexOf("export const PUBLISHED_SURFACES");
    const uncheckedStart = claims.indexOf("export const UNCHECKED_SURFACES");
    expect(publishedStart).toBeGreaterThanOrEqual(0);
    expect(uncheckedStart).toBeGreaterThanOrEqual(0);
    const published = claims.slice(publishedStart, uncheckedStart);
    const nextExport = claims.indexOf("\nexport ", uncheckedStart);
    const unchecked = claims.slice(uncheckedStart, nextExport === -1 ? undefined : nextExport);
    expect(occurrences(published, "\n  \"packages/mcp-server/README.md\",")).toBe(1);
    expect(occurrences(published, "\n  \"starter/runbook/00-prerequisites.md\",")).toBe(1);
    expect(unchecked).not.toContain("packages/mcp-server/README.md");
    expect(unchecked).not.toContain("starter/runbook/00-prerequisites.md");
  });

  it("PC18 onboarding marks claim only what a server answer confirmed", () => {
    const text = read(ONBOARD);
    for (const id of ["A34a", "A34b", "A34c"] as const) changed(id, text);
    expect(text).not.toContain("test job passed");
    expect(text).not.toContain("demand posted, composed");
    expect(text).not.toContain("Tier 1 bundle");
  });

  it("PC19 the human plan lists the unserved skill steps without calling them", async () => {
    const text = read(ONBOARD);
    for (const id of ["A35a", "A35b"] as const) changed(id, text);
    expect(occurrences(text, "if(c.terminal)continue;")).toBe(1);
    expect(text).not.toContain("(PR #90)");
    expect(occurrences(text, "$(\"#mRun\").onclick=")).toBe(1);
    const start = text.indexOf("$(\"#mRun\").onclick=");
    const end = text.indexOf("\nfunction resolveBody", start);
    expect(end).toBeGreaterThan(start);
    const handlerSource = text.slice(start, end);
    const urls: string[] = [];
    const indices: number[] = [];
    const mRun: { onclick?: () => Promise<void> } = {};
    const dollar = (selector: string) => {
      if (selector === "#mRun") return mRun;
      if (selector === "#mBase") return { value: "https://example.invalid" };
      if (selector === "#mKey") return { value: "" };
      return { classList: { remove() {} } };
    };
    const buildPlan = () => [
      { m: "POST", path: "/api/auth/provision" },
      { m: "POST", path: "/api/onboard/analyze", opt: 1 },
      { m: "POST", path: "/api/kernels" },
      { m: "POST", path: "/api/skills", terminal: 1 },
      { m: "POST", path: "/api/skills/${skillId}/verify", terminal: 1 },
      { m: "GET", path: "/api/kernels/${kernelId}/agent-card.json", terminal: 1 },
    ];
    const fetch = (url: string) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };
    const resolveBody = (body: unknown) => body;
    const markCall = (index: number) => {
      indices.push(index);
    };
    const toast = () => {};
    const setTimeout = (callback: () => void) => {
      callback();
    };
    const handler = new Function("$", "buildPlan", "toast", "fetch", "resolveBody", "markCall", "setTimeout", handlerSource) as (...args: unknown[]) => void;
    handler(dollar, buildPlan, toast, fetch, resolveBody, markCall, setTimeout);
    await mRun.onclick!();
    expect(urls).toEqual(["https://example.invalid/api/auth/provision", "https://example.invalid/api/onboard/analyze", "https://example.invalid/api/kernels"]);
    expect(indices).toEqual([0, 1, 2]);
  });

  it("PC20 the prerequisites page says the daemon takes no jobs", () => {
    changed("A36", read(PREREQ));
    expect(read(PREREQ)).not.toMatch(/\bruns jobs\b/);
  });

  it("PC21 the lineage and test-job texts promise no derivative CSDs and no reply fields on earlier refusals", () => {
    for (const text of [read(CLI), read(README), read(INDEX), read(CARD)]) {
      expect(text).not.toContain("derivative CSDs");
      expect(text).not.toContain("ancestors (parent CSDs)");
    }
    for (const text of [read(README), read(INDEX), read(CARD)]) {
      expect(text).not.toContain("Every reply says whether the job ran and passed.");
    }
  });

  it("PC14 every agent install line pins pcc-node at 700dcfe9", () => {
    const prompt = pack().system_prompt;
    changed("A6", prompt);
    expect(prompt).not.toContain("1d11f372");
    for (const id of ["A6m", "A6s1", "A6s2"] as const) {
      const text = read(ROWS[id].path);
      changed(id, text);
      expect(text).not.toContain("1d11f372");
    }
    for (const id of ["A6", "A6m", "A6s1", "A6s2"] as const) {
      const path = ROWS[id].path;
      const text = read(path);
      const pins = [...new Set([...text.matchAll(/physical-capability-cloud(?:\.git)?@([0-9a-f]{7,40})/g)].map((m) => m[1]))];
      expect(pins, path).toEqual([PIN]);
      expect([...text.matchAll(INSTALL)], path).toHaveLength(1);
    }
  });

  it("PC15 no agent pack file names a pcc-node version", () => {
    for (const id of ["A6", "A6m", "A6s1", "A6s2"] as const) {
      const text = read(ROWS[id].path);
      expect(text, ROWS[id].path).not.toMatch(/pcc-node(?:\[[a-z,]+\])?\s*(?:==|>=|<=|~=|!=|>|<|\s)\s*v?\d+\.\d+|(?<![\d.])\b0\.\d+(?:\.\d+)?\s+(?:daemon|node)\b|(?<![\d.])0\.1\.\d+\b/i);
    }
  });
});
