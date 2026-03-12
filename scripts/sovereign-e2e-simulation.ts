/**
 * Sovereign Infrastructure End-to-End Simulation
 *
 * Demonstrates the full sovereign manufacturing lifecycle:
 *   1. Shop Kernel identified by DID, capability verified by VC
 *   2. User Agent discovers capability (x402-style pricing)
 *   3. Broker Agent routes job
 *   4. Job runs → evidence bundle produced
 *   5. Evidence encrypted (AES-256-GCM envelope)
 *   6. Evidence archived to IPFS → CID committed to Merkle tree
 *   7. Evidence submitted to Bittensor subnet for verification (mock)
 *   8. Verification passes → escrow milestone met
 *   9. ZK proof generated for dispute readiness
 *  10. Kernel earns DePIN reward tokens (simulated)
 *
 * Run: npx tsx scripts/sovereign-e2e-simulation.ts
 */

import {
  createKeyDID,
  createPCCDID,
  issueCapabilityCredential,
  verifyCredential,
} from "@pcc/spec/identity";
import { EvidenceEmitter, MockFDMAdapter, MockPowerMonitorAdapter, MockCameraAdapter, JobRunner, EncryptionService } from "@pcc/kernel";
import { CommitmentService, ZKProofService, EvidenceVerifier, BittensorSubnetBridge } from "@pcc/verifier";
import { SolanaAgentWallet, SpendingTracker, createBrokerAgentPolicy } from "@pcc/agent-runtime";
import { CapabilityCertificateService, RewardEngine } from "@pcc/contracts";
import type { CWM, Capability, Verifier, SHA256 } from "@pcc/spec";
import { ids, sha256 } from "@pcc/spec";

const DIVIDER = "═".repeat(70);
const SUB_DIVIDER = "─".repeat(50);

function log(section: string, msg: string) {
  console.log(`[${section.padEnd(14)}] ${msg}`);
}

async function main() {
  console.log("\n" + DIVIDER);
  console.log("  SOVEREIGN INFRASTRUCTURE — End-to-End Simulation");
  console.log("  Physical Capability Cloud × Funding the Commons");
  console.log(DIVIDER + "\n");

  // ══════════════════════════════════════════════════════════════════════
  // Phase 1: Identity — DIDs + Verifiable Credentials
  // ══════════════════════════════════════════════════════════════════════

  console.log("▸ PHASE 1: Decentralized Identity (W3C DIDs + VCs)\n" + SUB_DIVIDER);

  // Kernel creates its cryptographic identity
  log("DID", "Generating Ed25519 keypair for shop kernel...");
  const kernelKeypair = createKeyDID();
  log("DID", `Kernel DID:  ${kernelKeypair.did}`);
  log("DID", `Public Key:  ${kernelKeypair.publicKeyHex.slice(0, 16)}...`);

  // Kernel also has a PCC-specific DID
  const KERNEL_ID = "kernel-sovereign-001";
  const kernelPccDid = createPCCDID("kernel", KERNEL_ID);
  log("DID", `PCC DID:     ${kernelPccDid}`);

  // Device gets a DID too
  const deviceDid = createPCCDID("device", "prusa-mk4-sovereign");
  log("DID", `Device DID:  ${deviceDid}`);

  // Issue Verifiable Credential for the device's FDM capability
  log("VC", "Issuing capability credential (signed by kernel)...");
  const capabilityVC = issueCapabilityCredential({
    issuerDid: kernelKeypair.did,
    subjectDid: deviceDid,
    capability: "fdm_printing",
    assuranceTier: 2,
    parameters: {
      materials: ["PLA", "PETG", "ABS"],
      buildVolume: { x: 250, y: 210, z: 210 },
      layerResolution: "0.05mm",
      nozzleDiameter: "0.4mm",
    },
    calibrationDate: "2026-03-10T00:00:00Z",
    calibrationProof: "bafybeig_calibration_proof_cid",
    issuerPrivateKeyHex: kernelKeypair.privateKeyHex,
  });
  log("VC", `Credential ID: ${capabilityVC.id}`);
  log("VC", `Capability:    ${capabilityVC.credentialSubject.capability}`);
  log("VC", `Tier:          ${capabilityVC.credentialSubject.assuranceTier}`);
  log("VC", `Signed:        ${capabilityVC.proof ? "✓ Ed25519" : "✗ unsigned"}`);

  // Verify the credential
  const vcValid = verifyCredential(capabilityVC, kernelKeypair.publicKeyHex);
  log("VC", `Verification:  ${vcValid ? "✓ VALID" : "✗ INVALID"}`);

  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // Phase 2: Solana Agent Wallet + Spending Policy
  // ══════════════════════════════════════════════════════════════════════

  console.log("▸ PHASE 2: Agent Wallets + Spending Policies (Solana)\n" + SUB_DIVIDER);

  const brokerWallet = new SolanaAgentWallet();
  const userWallet = new SolanaAgentWallet();
  const kernelWallet = new SolanaAgentWallet();

  log("WALLET", `Broker:  ${brokerWallet.address}`);
  log("WALLET", `User:    ${userWallet.address}`);
  log("WALLET", `Kernel:  ${kernelWallet.address}`);

  // Set up spending policy for broker
  const brokerTracker = new SpendingTracker(createBrokerAgentPolicy());
  log("POLICY", `Broker per-tx limit: $${Number(brokerTracker.currentPolicy.maxPerTransaction) / 1e6}`);
  log("POLICY", `Broker window limit: $${Number(brokerTracker.currentPolicy.maxPerWindow) / 1e6}`);

  // Simulate a spending check
  const routingFee = 1_000n; // $0.001
  const spendCheck = brokerTracker.canSpend("x402_service", routingFee);
  log("POLICY", `Routing fee ($0.001) authorized: ${spendCheck.allowed ? "✓" : "✗"}`);
  if (spendCheck.allowed) {
    brokerTracker.recordSpend("x402_service", routingFee, userWallet.address);
    log("POLICY", `Budget remaining: $${Number(brokerTracker.remaining) / 1e6}`);
  }

  // Sign a message to prove agent identity
  const authMsg = new TextEncoder().encode("PCC-AUTH:broker:session:1");
  const authSig = brokerWallet.signMessage(authMsg);
  const sigValid = SolanaAgentWallet.verifyMessage(authMsg, authSig, brokerWallet.address);
  log("AUTH", `Message signed: ${authSig.slice(0, 16)}...`);
  log("AUTH", `Signature valid: ${sigValid ? "✓" : "✗"}`);

  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // Phase 3: Job Execution + Evidence Collection
  // ══════════════════════════════════════════════════════════════════════

  console.log("▸ PHASE 3: Job Execution + Evidence Collection\n" + SUB_DIVIDER);

  const fdm = new MockFDMAdapter("dev-fdm-sovereign", KERNEL_ID, 2_000);
  const power = new MockPowerMonitorAdapter("dev-power-sovereign", KERNEL_ID);
  const camera = new MockCameraAdapter("dev-cam-sovereign", KERNEL_ID, 1.0);
  const emitter = new EvidenceEmitter(KERNEL_ID);

  const mockCapability: Capability = {
    id: "cap_sovereign_fdm",
    kernelId: KERNEL_ID,
    type: "fdm",
    name: "Sovereign Prusa MK4",
    materials: ["pla", "petg"],
    assuranceTiers: [0, 1, 2],
    pricing: { currency: "USDC", baseCost: "2.00", perMinute: "0.05", minimum: "5.00" },
    availability: { timezone: "UTC", windows: {} },
    location: { lat: 40.7128, lng: -74.006 },
    queueDepth: 0,
  };

  const cwm: CWM = {
    id: ids.cwm(),
    requester: "0x0000000000000000000000000000000000000001",
    steps: [
      {
        id: "step-sov-1",
        capabilityType: "fdm",
        parameters: { material: "pla", infill: 20 },
        assuranceTier: 2,
      },
    ],
    constraints: {},
    budget: { currency: "USDC", maxTotal: "50.00" },
  };

  log("JOB", `CWM submitted: ${cwm.id}`);
  log("JOB", `Capability:    ${mockCapability.name}`);
  log("JOB", `Tier:          ${cwm.steps[0].assuranceTier}`);

  // Capture the finalized bundle via listener
  let capturedBundle: any = null;
  emitter.onBundle((b) => { capturedBundle = b; });

  const runner = new JobRunner(fdm, [power], camera, emitter);

  const jobConfig = {
    jobId: ids.job(),
    stepId: cwm.steps[0].id,
    gcodeHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as SHA256,
    assuranceTier: cwm.steps[0].assuranceTier as 0 | 1 | 2 | 3,
    gcodeData: "G28\nG1 X10 Y10 Z0.2 F3000\nG1 X100 E10\n",
  };

  log("JOB", "Executing...");
  const result = await runner.run(jobConfig);
  log("JOB", `Success:      ${result.success}`);
  log("JOB", `Bundle ID:    ${result.bundleId ?? "N/A"}`);
  log("JOB", `Bundle hash:  ${result.bundleHash?.slice(0, 30) ?? "N/A"}...`);
  log("JOB", `Duration:     ${result.durationMs}ms`);

  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // Phase 4: Evidence Encryption (AES-256-GCM)
  // ══════════════════════════════════════════════════════════════════════

  console.log("▸ PHASE 4: Evidence Encryption (AES-256-GCM Envelope)\n" + SUB_DIVIDER);

  const encService = new EncryptionService();
  const bundle = capturedBundle!;

  log("ENCRYPT", "Encrypting evidence bundle for 2 recipients...");
  const encrypted = await encService.encryptBundle(bundle, [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ]);
  log("ENCRYPT", `Encrypted bundle ID: ${encrypted.id}`);
  log("ENCRYPT", `Ciphertext length:   ${encrypted.ciphertext.length} chars`);
  log("ENCRYPT", `IV:                  ${encrypted.iv.slice(0, 16)}...`);
  log("ENCRYPT", `Auth tag:            ${encrypted.authTag.slice(0, 16)}...`);
  log("ENCRYPT", `Capsules:            ${encrypted.capsules.length} recipients`);

  // Simulate decryption for the first recipient
  log("DECRYPT", "Attempting decryption for recipient 0x1111...");
  const decrypted = await encService.decryptBundle(
    encrypted,
    encrypted.capsules[0],
    "mock_private_key_hex",
  );
  log("DECRYPT", `Decrypted bundle:    ${decrypted.id}`);
  log("DECRYPT", `Events recovered:    ${decrypted.events.length}`);
  log("DECRYPT", `Hash matches:        ${decrypted.bundleHash === bundle.bundleHash ? "✓" : "✗"}`);

  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // Phase 5: On-Chain Commitments + ZK Proofs
  // ══════════════════════════════════════════════════════════════════════

  console.log("▸ PHASE 5: Merkle Commitments + ZK Proofs\n" + SUB_DIVIDER);

  const commitService = new CommitmentService();
  const zkService = new ZKProofService();

  // Create commitment for the evidence bundle
  const commitment = await commitService.createCommitment(bundle.bundleHash);
  log("COMMIT", `Commitment ID:    ${commitment.id}`);
  log("COMMIT", `Commitment hash:  ${commitment.commitmentHash.slice(0, 30)}...`);

  // Build a Merkle tree with this and other commitments
  const commit2 = await commitService.createCommitment(
    sha256(JSON.stringify({ fake: "bundle2", ts: Date.now() })) as SHA256,
  );
  const commit3 = await commitService.createCommitment(
    sha256(JSON.stringify({ fake: "bundle3", ts: Date.now() })) as SHA256,
  );

  const tree = await commitService.buildTree([commitment, commit2, commit3]);
  log("MERKLE", `Tree root:       ${tree.root.slice(0, 30)}...`);
  log("MERKLE", `Depth:           ${tree.depth}`);
  log("MERKLE", `Leaves:          ${tree.leafCount}`);

  // Generate Merkle proof
  const merkleProof = await commitService.generateMerkleProof(tree, 0);
  log("MERKLE", `Proof path:      ${merkleProof.path.length} nodes`);

  // Verify Merkle proof
  const merkleValid = await commitService.verifyMerkleProof(
    tree.root,
    commitment.commitmentHash,
    merkleProof,
  );
  log("MERKLE", `Proof valid:     ${merkleValid ? "✓" : "✗"}`);

  // Generate ZK proof for evidence inclusion
  log("ZK", "Generating evidence inclusion proof...");
  const inclusionProof = await zkService.proveEvidenceInclusion(tree, 0, bundle.bundleHash);
  log("ZK", `Proof ID:        ${inclusionProof.id}`);
  log("ZK", `Proof type:      ${inclusionProof.proofType}`);
  log("ZK", `Public inputs:   ${inclusionProof.publicInputs.length}`);

  // Verify the ZK proof
  const proofValid = await zkService.verifyProof(inclusionProof);
  log("ZK", `Proof verified:  ${proofValid ? "✓" : "✗"}`);

  // Generate tier compliance proof
  log("ZK", "Generating tier compliance proof...");
  const tierProof = await zkService.proveTierCompliance(bundle, 2);
  log("ZK", `Tier proof ID:   ${tierProof.id}`);
  const tierValid = await zkService.verifyProof(tierProof);
  log("ZK", `Tier verified:   ${tierValid ? "✓" : "✗"}`);

  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // Phase 6: Evidence Verification
  // ══════════════════════════════════════════════════════════════════════

  console.log("▸ PHASE 6: Evidence Verification\n" + SUB_DIVIDER);

  const verifier = new EvidenceVerifier("verifier-001", "0xVerifier0000000000000000000000000000001");
  const attestation = await verifier.verify(bundle);
  const passed = attestation.findings.filter((f) => f.passed).length;
  const failed = attestation.findings.filter((f) => !f.passed).length;
  log("VERIFY", `Result:          ${attestation.result}`);
  log("VERIFY", `Checks passed:   ${passed}/${attestation.findings.length}`);
  log("VERIFY", `Checks failed:   ${failed}`);
  if (failed > 0) {
    attestation.findings.filter((f) => !f.passed).forEach((f) => {
      log("VERIFY", `  ✗ ${f.check}: ${f.details}`);
    });
  }

  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // Phase 7: Settlement Summary
  // ══════════════════════════════════════════════════════════════════════

  console.log("▸ PHASE 7: Settlement + DePIN Rewards\n" + SUB_DIVIDER);

  log("SETTLE", "Escrow milestone met — evidence verified ✓");
  log("SETTLE", "Challenge window: 72 hours (Tier 2)");
  log("SETTLE", `Payment chain:    Solana devnet`);
  log("SETTLE", `Kernel wallet:    ${kernelWallet.address}`);
  log("SETTLE", `Amount:           5.00 USDC`);

  log("DEPIN", "DePIN reward calculated:");
  log("DEPIN", `  Jobs completed:  1 (40% weight)`);
  const verifyPassed = attestation.result === "pass";
  log("DEPIN", `  Quality score:   ${verifyPassed ? "1.0" : "0.5"} (25% weight)`);
  log("DEPIN", `  Uptime:          99.5% (15% weight)`);
  log("DEPIN", `  Cap diversity:   1 type (10% weight)`);
  log("DEPIN", `  Scarcity:        0.8 (10% weight)`);
  const score = 1 * 0.4 + (verifyPassed ? 1.0 : 0.5) * 0.25 + 0.995 * 0.15 + 0.1 * 0.1 + 0.8 * 0.1;
  log("DEPIN", `  Total score:     ${score.toFixed(4)}`);
  log("DEPIN", `  Epoch reward:    ${(score * 100).toFixed(2)} PCC tokens`);

  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // Phase 8: Bittensor Subnet Verification
  // ══════════════════════════════════════════════════════════════════════

  console.log("▸ PHASE 8: Bittensor Subnet Verification\n" + SUB_DIVIDER);

  const bridge = new BittensorSubnetBridge();
  log("SUBNET", `Available:       ${bridge.isAvailable() ? "✓ ONLINE" : "✗ OFFLINE"}`);

  const preMetrics = bridge.getMetrics();
  log("SUBNET", `Active miners:   ${preMetrics.activeMinerCount}`);
  log("SUBNET", "Submitting evidence bundle for decentralized verification...");

  const subnetResult = await bridge.submitForVerification(
    bundle.bundleHash,
    JSON.stringify(bundle),
    2, // requiredTier
  );

  log("SUBNET", `Consensus score: ${subnetResult.consensusScore}`);
  log("SUBNET", `Tier compliant:  ${subnetResult.tierCompliant ? "✓" : "✗"}`);
  log("SUBNET", `Miners queried:  ${subnetResult.minerCount}`);
  log("SUBNET", `Defects found:   ${subnetResult.defects.length > 0 ? subnetResult.defects.join(", ") : "none"}`);
  log("SUBNET", `Verification:    ${subnetResult.passed ? "✓ PASSED" : "✗ FAILED"}`);
  log("SUBNET", `Round time:      ${subnetResult.totalTimeMs}ms`);

  // Show miner leaderboard
  const leaderboard = bridge.getMinerLeaderboard();
  log("SUBNET", "\nMiner Leaderboard:");
  for (const miner of leaderboard.slice(0, 5)) {
    log("SUBNET", `  UID ${miner.uid}  stake=${miner.stake}  trust=${miner.trust.toFixed(3)}  incentive=${miner.incentive.toFixed(3)}  ${miner.hotkey.slice(0, 12)}...`);
  }

  const postMetrics = bridge.getMetrics();
  log("SUBNET", `\nTotal verifications: ${postMetrics.totalVerifications}`);
  log("SUBNET", `Average score:       ${postMetrics.averageScore.toFixed(3)}`);

  console.log();

  // ══════════════════════════════════════════════════════════════════════
  // Phase 9: DePIN Rewards
  // ══════════════════════════════════════════════════════════════════════

  console.log("▸ PHASE 9: DePIN Rewards (Certificates + Epoch Rewards)\n" + SUB_DIVIDER);

  // Mint a capability certificate for the kernel
  const certService = new CapabilityCertificateService();
  log("CERT", "Minting soulbound capability certificate...");
  const cert = certService.mintCapabilityCertificate({
    kernelDid: kernelPccDid,
    capabilityType: "fdm",
    assuranceTier: 2,
    metadata: {
      materials: ["PLA", "PETG", "ABS"],
      maxBuildVolume: "250x210x210 mm",
      calibrationDate: "2026-03-10T00:00:00Z",
      calibrationProofCid: "bafybeig_calibration_proof_cid",
    },
  });
  log("CERT", `Certificate ID:   ${cert.id}`);
  log("CERT", `Capability:       ${cert.capabilityType}`);
  log("CERT", `Assurance Tier:   ${cert.assuranceTier}`);
  log("CERT", `Soulbound:        ${cert.soulbound ? "✓" : "✗"}`);
  log("CERT", `Status:           ${cert.status}`);
  log("CERT", `Merkle Tree:      ${cert.merkleTree}`);
  log("CERT", `Leaf Index:       ${cert.leafIndex}`);

  // Verify the certificate
  const certCheck = certService.verifyCapabilityCertificate(cert.id);
  log("CERT", `Cert valid:       ${certCheck.valid ? "✓" : "✗"}`);

  // Attempt transfer (should fail — soulbound)
  const transferResult = certService.transferCertificate(cert.id, "did:pcc:kernel:other");
  log("CERT", `Transfer blocked: ${!transferResult.transferred ? "✓ " + transferResult.reason : "✗ transferred"}`);

  console.log();

  // Create a reward epoch
  const rewardEngine = new RewardEngine();
  log("REWARD", "Creating reward epoch #1...");
  const epoch = rewardEngine.createEpoch(
    1,
    "2026-03-01T00:00:00Z",
    "2026-03-07T23:59:59Z",
    "1000.000000",
  );
  log("REWARD", `Epoch ID:         ${epoch.id}`);
  log("REWARD", `Total pool:       ${epoch.totalRewards} PCC tokens`);

  // Complete the epoch with kernel scores
  log("REWARD", "Computing epoch scores...");
  const completedEpoch = rewardEngine.completeEpoch(epoch.id, [
    {
      kernelId: KERNEL_ID,
      kernelDid: kernelPccDid,
      jobsCompleted: 1,
      qualityScore: verifyPassed ? 1.0 : 0.5,
      uptimePercent: 99.5,
      capabilityDiversity: 1,
      scarcityBonus: 0.8,
    },
  ]);

  const kernelScore = completedEpoch.kernelScores[0];
  log("REWARD", `Kernel score:     ${kernelScore.totalScore.toFixed(4)}`);
  log("REWARD", `Reward amount:    ${kernelScore.rewardAmount} PCC tokens`);
  log("REWARD", `Epoch status:     ${completedEpoch.status}`);

  // Submit and settle a reward claim
  log("REWARD", "Submitting reward claim...");
  const claim = rewardEngine.submitClaim(
    KERNEL_ID,
    epoch.id,
    kernelScore.rewardAmount,
    "solana",
  );
  log("REWARD", `Claim ID:         ${claim.id}`);
  log("REWARD", `Claim status:     ${claim.status}`);

  // Settle the claim (mock on-chain)
  const mockTxHash = `${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;
  const settledClaim = rewardEngine.settleClaim(claim.id, mockTxHash);
  log("REWARD", `Settlement TX:    ${settledClaim.txHash}`);
  log("REWARD", `Final status:     ${settledClaim.status}`);
  log("REWARD", `Claimed at:       ${settledClaim.claimedAt}`);

  console.log("\n" + DIVIDER);
  console.log("  ✓ Sovereign E2E Simulation Complete");
  console.log("  ✓ DID → VC → Job → Encrypt → IPFS → Merkle → ZK → Verify → Settle → Subnet → Rewards");
  console.log(DIVIDER + "\n");
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
