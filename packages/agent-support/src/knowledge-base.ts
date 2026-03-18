/**
 * KnowledgeBase — Complete PCC platform knowledge for the support agent.
 *
 * Contains structured answers to common questions about:
 * - Adapter protocols and interfaces
 * - Capability types and configuration
 * - Evidence collection and assurance tiers
 * - Settlement and escrow lifecycle
 * - A2A protocol and intents
 * - Network connectivity troubleshooting
 * - Onboarding flow
 */

export interface KnowledgeEntry {
  topic: string;
  keywords: string[];
  question: string;
  answer: string;
  relatedTopics?: string[];
}

export class KnowledgeBase {
  private entries: KnowledgeEntry[] = [];

  constructor() {
    this.loadEntries();
  }

  /** Search knowledge base by keywords or free text */
  search(query: string, maxResults = 5): KnowledgeEntry[] {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const scored = this.entries.map(entry => {
      let score = 0;

      // Exact topic match
      if (entry.topic.toLowerCase().includes(queryLower)) score += 10;

      // Keyword matches
      for (const keyword of entry.keywords) {
        if (queryLower.includes(keyword.toLowerCase())) score += 5;
      }

      // Word matches in question and answer
      for (const word of queryWords) {
        if (entry.question.toLowerCase().includes(word)) score += 2;
        if (entry.answer.toLowerCase().includes(word)) score += 1;
      }

      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => s.entry);
  }

  /** Get all entries for a specific topic */
  getByTopic(topic: string): KnowledgeEntry[] {
    return this.entries.filter(e => e.topic === topic);
  }

  /** Get all unique topics */
  getTopics(): string[] {
    return [...new Set(this.entries.map(e => e.topic))];
  }

  private loadEntries(): void {
    this.entries = [
      // ── Adapters ──────────────────────────────────────────────

      {
        topic: "adapters",
        keywords: ["adapter", "machine", "interface", "wrap", "device", "api"],
        question: "What adapter interfaces does PCC support?",
        answer: "PCC defines three adapter interfaces: MachineAdapter (for equipment that runs jobs — getStatus, execute, getProgress, onEvidence), SensorAdapter (for monitoring — startRecording, stopRecording, getCurrentReading, onEvidence), and CameraAdapter (for vision/QC — captureSnapshot, runInspection, onEvidence). All adapters emit EvidenceEvents through the onEvidence callback.",
        relatedTopics: ["evidence", "protocols"],
      },
      {
        topic: "adapters",
        keywords: ["http", "rest", "octoprint", "api", "endpoint"],
        question: "How do I wrap an HTTP/REST API device?",
        answer: "Use GenericHttpAdapter from @pcc/onboard-kit or OctoPrintAdapter from @pcc/kernel as a reference. Configure: baseUrl, endpoints (status GET, progress GET, loadProgram POST, start POST, stop POST), statusMapping (map device states to PCC MachineStatus), progressMapping (extract 0-100 from response). The adapter handles polling, evidence emission, and mock mode automatically.",
      },
      {
        topic: "adapters",
        keywords: ["opcua", "opc-ua", "cnc", "plc", "siemens", "fanuc", "haas", "kuka"],
        question: "How do I connect an OPC-UA device?",
        answer: "Use OPCUAAdapter from @pcc/kernel. Configure: endpoint (opc.tcp://host:4840), machineType, nodeMap (map OPC-UA node IDs to semantic names like SpindleSpeed, FeedRate, Position, ProgramProgress), pollIntervalMs, securityMode. The adapter reads CNC state nodes and emits execution_progress at 25% intervals. Mock mode available for testing without real hardware.",
      },
      {
        topic: "adapters",
        keywords: ["modbus", "sensor", "power", "temperature", "plc", "register"],
        question: "How do I connect a Modbus TCP sensor?",
        answer: "Use ModbusSensorAdapter from @pcc/kernel. Configure: host, port (default 502), unitId, registerMap (array of {channel, label, address, registerType, dataType, unit, scale, offset}). The adapter polls registers and emits SensorReadings. Each register maps to a channel with a physical unit. Supports holding, input, coil, and discrete registers.",
      },
      {
        topic: "adapters",
        keywords: ["sila", "lab", "instrument", "hamilton", "tecan", "liquid", "handler"],
        question: "How do I connect a SiLA 2 lab instrument?",
        answer: "Use SiLAAdapter from @pcc/kernel. Configure: deviceId, kernelId, silaServerUrl (gRPC endpoint). The adapter exposes getCapabilities() returning LabCapability[] and executeAssay(config) for running protocols. Emits LiquidHandlingEvents for each aspirate/dispense operation with pressure curves and QC metrics (CV%, R-squared, Z-prime).",
      },
      {
        topic: "adapters",
        keywords: ["evidence", "event", "emit", "callback", "listener"],
        question: "My adapter isn't emitting evidence events",
        answer: "Check: 1) Your adapter calls this.emit() with the event object (type, timestamp, source, payload). 2) Listeners are registered via onEvidence() BEFORE execution starts. 3) EvidenceEmitter.registerStep() was called for the job/step. 4) The event type is a valid EvidenceEventType (gcode_received, execution_started, execution_progress, execution_completed, power_profile_sample, camera_snapshot, cv_inspection_result, sensor_data_summary). 5) The source.deviceType matches your device.",
      },

      // ── Capabilities ──────────────────────────────────────────

      {
        topic: "capabilities",
        keywords: ["capability", "type", "register", "define", "44"],
        question: "What capability types are available?",
        answer: "PCC defines 44 built-in types. Manufacturing (26): cnc-3axis, cnc-5axis, fdm, sla, sls, dmls, lathe, laser-cut, waterjet, edm-wire, edm-sinker, injection-mold, sheet-metal-bend, sheet-metal-punch, welding-mig/tig/laser, surface/cylindrical-grinding, polishing, anodizing, plating, heat-treat, cmm-inspection, surface-profilometry, xray-ct-inspection. Biotech (18): hplc, gc-ms, lc-ms, pcr, qpcr, sequencing, mass-spec, spectrophotometer, cell-culture, bioreactor, flow-cytometry, centrifuge, autoclave, lyophilizer, liquid-handler, plate-reader, microscopy, balance. Logistics (2): courier-pickup, courier-delivery.",
      },
      {
        topic: "capabilities",
        keywords: ["pricing", "cost", "price", "minute", "gram", "minimum"],
        question: "How do I set pricing for my capability?",
        answer: "Each capability has a PricingModel: baseCost (flat fee per job), perMinute (per minute of machine time), perGram (per gram of material, optional), minimum (minimum charge). All values are strings in the selected currency (USDC, ETH, DAI, SOL). The broker calculates total price as: max(minimum, baseCost + perMinute * estimatedMinutes + perGram * estimatedGrams). Machine profiles can override base pricing for specific devices.",
      },
      {
        topic: "capabilities",
        keywords: ["not found", "discover", "search", "missing", "invisible"],
        question: "Users can't discover my capability",
        answer: "Checklist: 1) Capability type is a valid BuiltinCapabilityType (check spelling). 2) brokerAgent.registerKernelCapabilities() was called with your kernel ID and capabilities array. 3) Kernel agent is started (kernelAgent.start()). 4) Kernel agent is connected to the same MessageBus or NetworkTransport as the broker. 5) Capability has at least one material listed. 6) Pricing model has valid currency and non-negative values. Run the validator: npx pcc-onboard validate --config your-config.json",
      },

      // ── Evidence ──────────────────────────────────────────────

      {
        topic: "evidence",
        keywords: ["tier", "assurance", "evidence", "requirement", "0", "1", "2", "3"],
        question: "What evidence is required for each assurance tier?",
        answer: "Tier 0: gcode_hash_verified + execution_completed (minimum 2 events). Tier 1: Tier 0 + power_profile_summary (minimum 3 events, requires sensor adapter). Tier 2: Tier 1 + camera_snapshot + cv_inspection_result (minimum 5 events, requires camera adapter). Tier 3: Tier 2 + encrypted bundle + ZK proof + Bittensor consensus. Each tier adds: higher operator bonds (0/5/15/25%), longer challenge windows (1h/4h/24h/72h), and more verifier requirements.",
      },
      {
        topic: "evidence",
        keywords: ["bundle", "hash", "mismatch", "invalid", "integrity"],
        question: "Evidence bundle hash mismatch error",
        answer: "Bundle hashes are SHA-256 of canonical JSON (keys sorted lexicographically). Common causes: 1) Bundle modified after finalizeBundle(). 2) Non-deterministic JSON serialization (use the canonical hash utility from @pcc/spec). 3) Event hashes computed incorrectly. 4) Bundle was deserialized and re-serialized with different key ordering. Fix: let EvidenceEmitter handle all hashing — don't compute hashes manually.",
      },
      {
        topic: "evidence",
        keywords: ["ipfs", "helia", "archive", "storage", "cid"],
        question: "How do I enable IPFS evidence storage?",
        answer: "Import EvidenceStorageService from '@pcc/kernel/dist/evidence-storage.js' (ESM-only path). Call init() to start an in-process Helia node, then set it on the evidence emitter: evidenceEmitter.setStorageService(storageService). Bundles are automatically archived after finalization. The CID is attached to the bundle. Call stop() on shutdown. Note: Helia is ESM-only — import from the dist path, not the package entry point.",
      },

      // ── Settlement ────────────────────────────────────────────

      {
        topic: "settlement",
        keywords: ["escrow", "payment", "milestone", "release", "fund"],
        question: "How does milestone escrow settlement work?",
        answer: "Flow: 1) User funds MilestoneEscrow contract (USDC locked per milestone). 2) Kernel completes job, submits evidenceBundleHash via settlement.submitEvidence(). 3) Verifier attests evidence, submits attestationHash. 4) Challenge window opens (duration depends on tier). 5) If no dispute filed, anyone calls release() after window expires. 6) USDC transferred to operator wallet. Operator bonds are returned if no slashing. The SettlementClient in @pcc/agent-runtime handles batched operations via the gateway.",
      },
      {
        topic: "settlement",
        keywords: ["bond", "slash", "dispute", "challenge", "window"],
        question: "How do operator bonds and disputes work?",
        answer: "Operator bonds: Tier 0=0%, Tier 1=5%, Tier 2=15%, Tier 3=25% of milestone amount. Deposited before job starts via settlement.depositBond(). If evidence is invalid, a challenger can file a dispute by staking a challenger bond (10-20% of milestone). Arbiter reviews and decides: if challenger wins, operator bond is slashed to reward challenger + payer is refunded. If operator wins, challenger bond is slashed. Challenge windows: Tier 0=1h, 1=4h, 2=24h, 3=72h.",
      },
      {
        topic: "settlement",
        keywords: ["release", "stuck", "not releasing", "payment", "pending"],
        question: "Settlement not releasing funds",
        answer: "Checklist: 1) Evidence was submitted: check settlement.submitEvidence() returned successfully (mode: 'batched' with operationId). 2) Verifier attested: settlement.submitAttestation() for Tier 1+. 3) Challenge window hasn't expired yet — check milestones[i].challengeWindowEnd timestamp. 4) No active dispute filed. 5) Gateway batch settler is running and has flushed the batch. Check /api/settlement/status for pending operations. 6) Wallet has enough ETH for gas.",
      },

      // ── Network / Connectivity ────────────────────────────────

      {
        topic: "network",
        keywords: ["connect", "websocket", "relay", "transport", "offline", "reconnect"],
        question: "How does network connectivity work?",
        answer: "In-process: agents share a MessageBus (testing). Networked: agents use NetworkTransport which connects via WebSocket to the gateway relay at /ws/a2a?agentId=xxx. Auto-reconnects every 3 seconds. Messages queued while offline (max 100 per agent) are delivered on reconnect. Agents POST messages to /api/a2a/send for HTTP fallback. Check /api/a2a/agents to verify your agent is registered. Health check: GET /api/health on the gateway.",
      },
      {
        topic: "network",
        keywords: ["message", "lost", "timeout", "intent", "handler", "no response"],
        question: "Messages aren't being delivered or handled",
        answer: "Checklist: 1) Agent started (agent.start()). 2) Agent subscribed to bus (bus.subscribe() called internally by start()). 3) Intent handler registered for the message type (check agent.supportedIntents). 4) Message 'to' field matches agent ID. 5) Signature valid (sender's wallet signed the message). 6) No error intent returned (check conversation for error responses). 7) For networked: WebSocket connected (transport.connect() succeeded). 8) Agent visible in /api/a2a/agents.",
      },

      // ── Jobs ──────────────────────────────────────────────────

      {
        topic: "jobs",
        keywords: ["stuck", "executing", "progress", "timeout", "hang"],
        question: "Job stuck in executing status",
        answer: "Causes: 1) Adapter getProgress() not returning updated values — check your device API is responding. 2) Adapter not emitting execution_completed when done — verify your completion detection logic. 3) JobRunner wait loop timeout (default 120s) — increase if your jobs take longer. 4) Unhandled error in execute() — wrap in try/catch, emit execution_failed event. 5) Polling timer not started — ensure startPolling() is called after execute('start'). Debug: check adapter.getStatus() and adapter.getProgress() manually.",
      },
      {
        topic: "jobs",
        keywords: ["queue", "order", "concurrency", "parallel"],
        question: "How does job queuing work?",
        answer: "KernelAgent maintains a jobQueue (FIFO). When a job arrives via execute_job intent, it's added to the queue. processQueue() runs async, dequeuing one job at a time (sequential by default). Each job goes through: status='queued' → 'executing' → 'completed'/'failed'. The kernel reports queue depth in its heartbeat and capability advertisement. Users see queue depth when requesting quotes. For parallel execution, implement a custom job scheduler.",
      },

      // ── Contract Builder ──────────────────────────────────────

      {
        topic: "contract-builder",
        keywords: ["profile", "machine", "parameter", "override", "constraint", "pricing"],
        question: "How do machine profiles work in the contract builder?",
        answer: "Machine profiles override the base capability template for a specific device. They contain: paramOverrides (restrict material options, set min/max for numeric params, exclude values), pricingOverrides (custom base/perMinute/minimum for this machine), and constraints (cross-parameter rules like 'if material=stainless, exclude tolerance=standard'). Profiles are passed to KernelAgent on construction. When users send get_build_options, the broker returns the profile's resolved parameters with pricing impacts.",
      },

      // ── DePIN ─────────────────────────────────────────────────

      {
        topic: "depin",
        keywords: ["reward", "epoch", "certificate", "soulbound", "nft", "score"],
        question: "How do DePIN rewards work?",
        answer: "Kernels earn rewards per epoch. Score = (jobsCompleted × 0.4) + (qualityScore × 0.25) + (uptimePercent × 0.15) + (capabilityDiversity × 0.1) + (scarcityBonus × 0.1). Soulbound capability certificates (cNFTs) are minted via Metaplex Core as track record grows. Reward claims submitted via ClaimRewardsIntent, settled on Solana or Base. Treasury balance tracked per-agent per-chain.",
      },

      // ── Identity ──────────────────────────────────────────────

      {
        topic: "identity",
        keywords: ["did", "credential", "wallet", "key", "sign", "verify"],
        question: "How does identity and signing work?",
        answer: "Each agent has: 1) An Ethereum wallet (viem) for message signing (EIP-191) and on-chain transactions. 2) A W3C DID (did:pcc:kernel:kernelId or did:key:...) for verifiable identity. 3) Optional Solana wallet for multi-chain settlement. All A2A messages are signed by the sender's wallet. Evidence bundles are signed by the kernel. Verifiable Credentials (VCs) issued for capability certificates and attestations. Private keys stored in environment variables — never hardcode.",
      },

      // ── Onboarding ────────────────────────────────────────────

      {
        topic: "onboarding",
        keywords: ["start", "begin", "onboard", "setup", "first", "new"],
        question: "How do I get started onboarding a device?",
        answer: "Use @pcc/onboard-kit. Steps: 1) Define capabilities (type, materials, tolerances, pricing). 2) Write device adapters (MachineAdapter for your API, SensorAdapter if tier>=1, CameraAdapter if tier>=2). 3) Create EvidenceEmitter + JobRunner. 4) Create KernelAgent with your capabilities. 5) Register with broker. 6) Connect to network. Quick start: import { quickStart } from '@pcc/onboard-kit' — one function call in mock mode. Full guide: see AGENT_INSTRUCTIONS.md in the package.",
      },
    ];
  }
}
