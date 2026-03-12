import React from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, GlowBadge, IPFSLink, DIDBadge, ChainTxLink } from "@pcc/ui";
import type { EncryptedEvidenceBundle, EvidenceCommitment, ZKProof } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useEvidenceExplorerStore } from "../stores/evidence-explorer-store.js";

const GATEWAY = "/api";

export function EvidenceExplorerPage() {
  const { bundleId } = useParams<{ bundleId?: string }>();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const {
    bundles, selectedBundleId, decryptedBundle, commitments, proofs, isDecrypting,
    setBundles, selectBundle, setDecrypted, addCommitment, addProof, setDecrypting,
  } = useEvidenceExplorerStore();

  React.useEffect(() => {
    setPageMeta("Evidence Explorer", bundleId ? `Bundle: ${bundleId}` : "Encrypted evidence browser");
  }, [setPageMeta, bundleId]);

  // Mock encrypted bundles (fetched from gateway in production)
  React.useEffect(() => {
    const mockBundles: EncryptedEvidenceBundle[] = [
      {
        id: "enc_001",
        bundleId: "bun_001",
        bundleHash: "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        ciphertext: "bW9ja19lbmNyeXB0ZWQ=",
        iv: "bW9ja19pdg==",
        authTag: "bW9ja190YWc=",
        encryptedAt: new Date(Date.now() - 600_000).toISOString(),
        capsules: [
          { id: "cap_001", recipientAddress: "0x1234567890abcdef1234567890abcdef12345678", encryptedKey: "key1", ephemeralPublicKey: "epk1", accessLevel: "full" },
        ],
        ipfsCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        ipfsMetadataCid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenosa7777",
        litCiphertext: "lit_enc_mock_001",
        litDataToEncryptHash: "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1",
        litAccessConditions: [
          { conditionType: "evmBasic", chain: "baseSepolia", method: "escrowBuyerOf", parameters: [":jobId"], returnValueTest: { comparator: "=", value: ":userAddress" } },
          { operator: "or" },
          { conditionType: "evmBasic", chain: "baseSepolia", method: "reputationOf", parameters: [":userAddress"], returnValueTest: { comparator: ">=", value: "100" } },
        ],
        litNetwork: "datil-test",
      },
      {
        id: "enc_002",
        bundleId: "bun_002",
        bundleHash: "sha256:f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
        ciphertext: "bW9ja19lbmNyeXB0ZWRfMg==",
        iv: "bW9ja19pdl8y",
        authTag: "bW9ja190YWdfMg==",
        encryptedAt: new Date(Date.now() - 1_200_000).toISOString(),
        capsules: [
          { id: "cap_002", recipientAddress: "0xabcdef1234567890abcdef1234567890abcdef12", encryptedKey: "key2", ephemeralPublicKey: "epk2", accessLevel: "selective" },
        ],
        ipfsCid: "bafybeihkoviema7g3gxyt6la7vd5ho32b4b3tg4tsfzqw7qxt57axi7imu",
        litNetwork: "datil-test",
      },
    ];
    setBundles(mockBundles);
    if (bundleId) selectBundle(bundleId);
  }, [bundleId]);

  const selected = bundles.find((b) => b.bundleId === (bundleId ?? selectedBundleId));

  const handleDecrypt = async () => {
    if (!selected) return;
    setDecrypting(true);
    // Mock decrypt: simulate delay then produce mock bundle
    await new Promise((r) => setTimeout(r, 800));
    setDecrypted({
      id: selected.bundleId,
      jobId: "job-001",
      stepId: "step-1",
      kernelId: "kernel-nyc",
      assuranceTier: 2,
      events: [
        {
          id: "ev_mock_1",
          type: "execution_completed",
          timestamp: new Date().toISOString(),
          source: { deviceId: "dev-001", deviceType: "controller", kernelId: "kernel-nyc" },
          payload: { success: true, duration: 3600 },
          hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        },
      ],
      bundleHash: selected.bundleHash,
      kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock" },
      createdAt: new Date().toISOString(),
    });
  };

  const handleVerifyProof = async (bundle: EncryptedEvidenceBundle) => {
    const resp = await fetch(`${GATEWAY}/zk/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleHash: bundle.bundleHash }),
    });
    const { commitment } = await resp.json();
    if (commitment) addCommitment(commitment);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-6">
        {/* Bundle list */}
        <div className="col-span-1">
          <GlassPanel padding="md">
            <h3 className="text-sm font-medium text-white/60 mb-3">Encrypted Bundles</h3>
            <div className="space-y-2">
              {bundles.map((bundle) => (
                <button
                  key={bundle.id}
                  onClick={() => selectBundle(bundle.bundleId)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-xs border transition-all ${
                    (bundleId ?? selectedBundleId) === bundle.bundleId
                      ? "bg-green-500/15 border-green-500/30"
                      : "bg-white/[0.03] border-white/[0.06] hover:border-white/[0.12]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-white/70">{bundle.bundleId}</span>
                    <GlowBadge color="gold">encrypted</GlowBadge>
                  </div>
                  <div className="text-[10px] text-white/30 mt-1 font-mono truncate">
                    {bundle.bundleHash.slice(0, 30)}...
                  </div>
                  <div className="text-[10px] text-white/20 mt-0.5">
                    {bundle.capsules.length} recipient{bundle.capsules.length !== 1 ? "s" : ""}
                  </div>
                </button>
              ))}
            </div>
          </GlassPanel>
        </div>

        {/* Bundle detail */}
        <div className="col-span-2 space-y-4">
          {selected ? (
            <>
              <GlassPanel padding="md">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-medium text-white/60">{selected.bundleId}</h3>
                  <div className="flex gap-2">
                    <button
                      onClick={handleDecrypt}
                      disabled={isDecrypting}
                      className="px-3 py-1.5 rounded-lg text-xs bg-green-500/15 border border-green-500/30 text-green-400 hover:bg-green-500/25 transition-all disabled:opacity-50"
                    >
                      {isDecrypting ? "Decrypting..." : "Decrypt"}
                    </button>
                    <button
                      onClick={() => handleVerifyProof(selected)}
                      className="px-3 py-1.5 rounded-lg text-xs bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:bg-blue-500/25 transition-all"
                    >
                      Create Commitment
                    </button>
                  </div>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex justify-between text-white/40">
                    <span>Bundle Hash</span>
                    <span className="font-mono text-white/60">{selected.bundleHash.slice(0, 40)}...</span>
                  </div>
                  <div className="flex justify-between text-white/40">
                    <span>Encrypted At</span>
                    <span className="text-white/60">{new Date(selected.encryptedAt).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-white/40">
                    <span>Recipients</span>
                    <span className="text-white/60">{selected.capsules.length}</span>
                  </div>
                  {selected.ipfsCid && (
                    <div className="flex justify-between items-center text-white/40">
                      <span>IPFS Bundle</span>
                      <IPFSLink cid={selected.ipfsCid} />
                    </div>
                  )}
                  {selected.ipfsMetadataCid && (
                    <div className="flex justify-between items-center text-white/40">
                      <span>IPFS Metadata</span>
                      <IPFSLink cid={selected.ipfsMetadataCid} label="metadata" />
                    </div>
                  )}
                  {selected.litNetwork && (
                    <div className="flex justify-between items-center text-white/40">
                      <span>Lit Network</span>
                      <GlowBadge color="gold">{selected.litNetwork}</GlowBadge>
                    </div>
                  )}
                </div>

                {/* Lit Access Conditions */}
                {selected.litAccessConditions && selected.litAccessConditions.length > 0 && (
                  <div className="mt-4">
                    <div className="text-xs text-white/40 mb-2">Lit Protocol Access Conditions</div>
                    <div className="space-y-1">
                      {selected.litAccessConditions.map((cond: any, i: number) => (
                        <div key={i} className="px-2 py-1.5 bg-white/[0.03] rounded text-xs">
                          {cond.operator ? (
                            <span className="text-gold-300 font-medium uppercase">{cond.operator}</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <GlowBadge color="gray">{cond.conditionType}</GlowBadge>
                              <span className="font-mono text-white/50">{cond.method}</span>
                              {cond.returnValueTest && (
                                <span className="text-white/30">
                                  {cond.returnValueTest.comparator} {cond.returnValueTest.value}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Key capsules */}
                <div className="mt-4">
                  <div className="text-xs text-white/40 mb-2">Key Capsules</div>
                  <div className="space-y-1">
                    {selected.capsules.map((cap) => (
                      <div key={cap.id} className="flex items-center justify-between px-2 py-1.5 bg-white/[0.03] rounded text-xs">
                        <span className="font-mono text-white/50 truncate" style={{ maxWidth: 200 }}>
                          {cap.recipientAddress}
                        </span>
                        <GlowBadge color={cap.accessLevel === "full" ? "green" : "gold"}>
                          {cap.accessLevel}
                        </GlowBadge>
                      </div>
                    ))}
                  </div>
                </div>
              </GlassPanel>

              {/* Commitment status */}
              {commitments[selected.bundleHash] && (
                <GlassPanel padding="md">
                  <h3 className="text-sm font-medium text-white/60 mb-2">Commitment</h3>
                  <div className="text-xs space-y-1 text-white/40">
                    <div>
                      Hash: <span className="font-mono text-white/60">{commitments[selected.bundleHash].commitmentHash.slice(0, 30)}...</span>
                    </div>
                    <div>
                      Timestamp: <span className="text-white/60">{new Date(commitments[selected.bundleHash].commitmentTimestamp).toLocaleString()}</span>
                    </div>
                  </div>
                </GlassPanel>
              )}

              {/* Decrypted view */}
              {decryptedBundle && (
                <GlassPanel padding="md">
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="text-sm font-medium text-white/60">Decrypted Evidence</h3>
                    <GlowBadge color="green">decrypted</GlowBadge>
                  </div>
                  <div className="text-xs space-y-2">
                    <div className="text-white/40">
                      Job: <span className="text-white/60 font-mono">{decryptedBundle.jobId}</span> ·
                      Step: <span className="text-white/60 font-mono">{decryptedBundle.stepId}</span> ·
                      Tier: <span className="text-white/60">{decryptedBundle.assuranceTier}</span>
                    </div>
                    <div className="text-white/40">Events ({decryptedBundle.events.length}):</div>
                    {decryptedBundle.events.map((ev) => (
                      <div key={ev.id} className="px-2 py-1.5 bg-white/[0.03] rounded">
                        <div className="flex items-center justify-between">
                          <span className="text-white/60">{ev.type}</span>
                          <span className="text-white/30 text-[10px]">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div className="font-mono text-[10px] text-white/20 mt-0.5 truncate">
                          {ev.hash}
                        </div>
                      </div>
                    ))}
                  </div>
                </GlassPanel>
              )}
            </>
          ) : (
            <GlassPanel padding="lg">
              <div className="text-center py-16 text-white/30 text-sm">
                Select a bundle to view details
              </div>
            </GlassPanel>
          )}
        </div>
      </div>
    </div>
  );
}
