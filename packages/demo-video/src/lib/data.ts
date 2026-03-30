export const PCC_METRICS = {
  packages: 25,
  tests: 3300,
  testFiles: 100,
  dashboardRoutes: 52,
  restEndpoints: 347,
  agentTools: 154,
  a2aIntents: 34,
  sseStreams: 6,
  uiComponents: 64,
  sponsors: 6,
  addressableMarket: "$3.5T",
  platformFeeReduction: "20-40% → 1.5%",
  routeFiles: 54,
} as const;

export const CAPABILITIES_TICKER = [
  // Biolab & precision science
  "CNC milling",
  "HPLC analysis",
  "PCB fabrication",
  "3D printing",
  "laser cutting",
  "wet lab assays",
  "drone surveys",
  "chemical synthesis",
  "welding",
  "gene sequencing",
  "spectroscopy",
  "soil sampling",
  "robotic assembly",
  "quality inspection",
  "flow cytometry",
  "bioreactor",
  // Factory capabilities
  "injection molding",
  "die casting",
  "metal stamping",
  "forging",
  "extrusion",
  "powder coating",
  "anodizing",
  "heat treatment",
  "surface grinding",
  "EDM machining",
  // Gig job capabilities
  "furniture assembly",
  "appliance repair",
  "house cleaning",
  "moving & hauling",
  "landscaping",
  "plumbing",
  "electrical work",
  "painting",
  "carpet cleaning",
  "window washing",
  "pressure washing",
  "junk removal",
  "handyman services",
  "personal shopping",
  "pet sitting",
  "event setup",
  "same-day delivery",
] as const;

export const SIX_PHASES = [
  {
    name: "DISCOVER",
    color: "#94b8ff",
    desc: "Agents find matching capabilities across global sites",
  },
  {
    name: "BID",
    color: "#f5a623",
    desc: "Operators compete in real-time auction pricing",
  },
  {
    name: "ESCROW",
    color: "#f87171",
    desc: "Funds lock on-chain per milestone before work starts",
  },
  {
    name: "EXECUTE",
    color: "#34d399",
    desc: "Physical work runs; evidence events stream in real-time",
  },
  {
    name: "VERIFY",
    color: "#34d399",
    desc: "Miners score evidence; ZK proofs generated",
  },
  {
    name: "SETTLE",
    color: "#f5a623",
    desc: "Funds auto-release; soulbound NFT certifies operator",
  },
] as const;

/** Sponsors — PL Genesis hackathon sponsors */
export const SPONSORS = [
  { name: "Protocol Labs", role: "Hackathon host + IPFS ecosystem" },
  { name: "Storacha", role: "Evidence storage + content addressing" },
  { name: "Filecoin", role: "Decentralized evidence persistence" },
  { name: "Starknet", role: "ZK proof anchoring" },
  { name: "Lit Protocol", role: "Decentralized evidence encryption" },
  { name: "Physical AI", role: "Real-world compute & robotics" },
] as const;

export const AWS_COMPARISON = [
  { aws: "Availability Zone", pcc: "Shop Kernel (physical site)" },
  { aws: "EC2 Instance Type", pcc: 'Capability Type ("5-axis CNC Tier-2")' },
  { aws: "S3 Request", pcc: "Evidence Bundle (content-addressed)" },
  { aws: "CloudWatch", pcc: "Sensor telemetry + evidence trail" },
  { aws: "IAM", pcc: "ERC-8004 machine DIDs" },
  { aws: "Billing", pcc: "Milestone escrow + x402 micropayments" },
] as const;

export const EVIDENCE_PIPELINE = [
  { step: "W3C DID Identity", detail: "did:pcc:operator:lab-01", color: "#94b8ff" },
  { step: "Verifiable Credential", detail: "Operator authorization VC", color: "#94b8ff" },
  { step: "Evidence Collection", detail: "6 events: peaks, purity, retention", color: "#34d399" },
  { step: "Lit Protocol Encryption", detail: "AES-256-GCM — sponsor integration", color: "#94b8ff" },
  { step: "Storacha IPFS", detail: "Content-addressed evidence — sponsor integration", color: "#94b8ff" },
  { step: "Verifier Consensus", detail: "5 miners, consensus score: 0.94", color: "#34d399" },
  { step: "Starknet ZK Proof", detail: "On-chain proof anchor — sponsor integration", color: "#34d399" },
  { step: "Escrow Settlement", detail: "$280 released — lock → fulfill → collect", color: "#f5a623" },
  { step: "Soulbound cNFT Mint", detail: "Non-transferable competence attestation", color: "#f5a623" },
] as const;

export const NEGOTIATION_LOG = [
  { tag: "BROKER", tagColor: "#f5a623", text: "Broadcasting HPLC capability request to 3 operators..." },
  { tag: "LAB-01", tagColor: "#94b8ff", text: "Bid: $3.50/sample — 99.2% purity — 4hr turnaround" },
  { tag: "LAB-02", tagColor: "#94b8ff", text: "Bid: $3.80/sample — 99.5% purity — 2hr turnaround" },
  { tag: "LAB-03", tagColor: "#94b8ff", text: "Bid: $3.20/sample — 98.8% purity — 6hr turnaround" },
  { tag: "BROKER", tagColor: "#f5a623", text: "Lowest bid: $3.20. Requesting final offers..." },
  { tag: "LAB-01", tagColor: "#94b8ff", text: "Counter: $3.10/sample — matching 4hr turnaround" },
  { tag: "LAB-03", tagColor: "#4a5568", text: "Withdrawn." },
  { tag: "BROKER", tagColor: "#f5a623", text: "Winner: LAB-01 at $3.10/sample ✓" },
  { tag: "ESCROW", tagColor: "#f5a623", text: "Milestone locked: $310.00 + $31.00 bond on Base Sepolia" },
  { tag: "KERNEL", tagColor: "#34d399", text: "Job accepted. Starting HPLC analysis..." },
] as const;

export const STAT_CARDS = [
  { value: 25, label: "Packages", suffix: "", color: "#94b8ff" },
  { value: 3300, label: "Tests Passing", suffix: "+", color: "#34d399" },
  { value: 347, label: "API Endpoints", suffix: "", color: "#f5a623" },
  { value: 154, label: "Agent Tools", suffix: "", color: "#34d399" },
  { value: 34, label: "A2A Intents", suffix: "", color: "#94b8ff" },
  { value: 54, label: "Route Files", suffix: "", color: "#94b8ff" },
  { value: 6, label: "Sponsor Integrations", suffix: "", color: "#f5a623" },
  { value: 6, label: "SSE Streams", suffix: "", color: "#94b8ff" },
  { value: 52, label: "Dashboard Routes", suffix: "+", color: "#34d399" },
] as const;

export const OLD_VS_NEW = {
  old: [
    { text: "Manual RFQs & phone calls", delay: 0 },
    { text: "3-7 day turnaround", delay: 5 },
    { text: "20-40% platform fees", delay: 10 },
    { text: "No verification of work", delay: 15 },
    { text: "Trust-based, opaque pricing", delay: 20 },
  ],
  new: [
    { text: "AI agents discover & negotiate", delay: 0 },
    { text: "Minutes, not days", delay: 5 },
    { text: "1.5% protocol fee", delay: 10 },
    { text: "Cryptographic proof of execution", delay: 15 },
    { text: "Competitive auction pricing", delay: 20 },
  ],
} as const;

// ─── NEW: DnB TRAILER DATA ───

/** Code fragments that float as background texture */
export const CODE_FRAGMENTS = [
  `await capability.execute({`,
  `  type: "hplc",`,
  `  assurance: Tier.SOVEREIGN,`,
  `  evidence: true`,
  `})`,
  `const proof = await verifier.score(bundle)`,
  `escrow.release({ milestone: 1 })`,
  `agent.discover({ radius: "50km" })`,
  `kernel.emit("evidence:collected")`,
  `did:pcc:operator:biolab-alpha`,
  `const bid = await auction.submit({`,
  `  price: "3.10", currency: "USDC"`,
  `})`,
  `cNFT.mint({ soulbound: true })`,
  `import { ShopKernel } from "@pcc/kernel"`,
  `const workflow = scheduler.compile(dag)`,
  `await payments.x402({ amount: 280 })`,
] as const;

/** Rapid-fire fracture pairs — OLD vs NEW, full-screen cuts */
export const FRACTURE_PAIRS = [
  { old: "LAYERS OF MIDDLEMEN", new: "DIRECT CONNECTION", oldSub: "every layer takes a cut", newSub: "operators & users, nothing in between" },
  { old: "ADMIN OVERHEAD EATS MARGINS", new: "OPERATORS KEEP MORE", oldSub: "bureaucracy billed to everyone", newSub: "work rewarded, not coordination" },
  { old: "USERS PAY FOR BUREAUCRACY", new: "USERS PAY FOR WORK", oldSub: "platform costs passed to buyers", newSub: "price reflects the capability, not the overhead" },
  { old: "OPAQUE PRICING", new: "TRANSPARENT ON-CHAIN", oldSub: "trust the platform's number", newSub: "competitive auction, every bid recorded" },
  { old: "TRUST THE PLATFORM", new: "VERIFY THE EVIDENCE", oldSub: "no audit trail, no recourse", newSub: "cryptographic proof of every step" },
] as const;

/** Ancient scene — giant text lines, revealed slowly */
export const ANCIENT_LINES = [
  { text: "Every machine.", delay: 0 },
  { text: "Every lab.", delay: 60 },
  { text: "Every factory on Earth.", delay: 120 },
  { text: "Just became", delay: 210 },
  { text: "a programmable endpoint.", delay: 280 },
] as const;

/** Stats that slam in one-by-one (not grid) */
export const SLAM_STATS = [
  { value: "25", label: "PACKAGES", color: "#94b8ff" },
  { value: "3,300+", label: "TESTS PASSING", color: "#34d399" },
  { value: "154", label: "AGENT TOOLS", color: "#34d399" },
  { value: "347", label: "API ENDPOINTS", color: "#f5a623" },
  { value: "34", label: "A2A INTENTS", color: "#94b8ff" },
  { value: "$3.5T", label: "ADDRESSABLE MARKET", color: "#f5a623" },
] as const;
