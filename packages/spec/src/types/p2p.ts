/**
 * P2P Types — peer identity, capability announcements, and encrypted envelopes
 * for the distributed Physical Capability Cloud.
 */

/** Peer identity — DID + key + endpoints */
export interface PeerIdentity {
  did: string;
  publicKey: string; // hex-encoded Ed25519/X25519
  kernelId?: string;
  agentId?: string;
  endpoints: PeerEndpoint[];
}

export interface PeerEndpoint {
  transport: TransportType;
  url: string;
  priority: number; // lower = preferred
}

/** Signed capability announcement — self-contained, verifiable */
export interface CapabilityAnnouncement {
  kernelDid: string;
  kernelId: string;
  capabilities: CapabilitySummary[];
  endpoints: PeerEndpoint[];
  ttlSeconds: number;
  timestamp: string;
  signature: string; // Ed25519 over canonical JSON (without this field)
}

export interface CapabilitySummary {
  type: string;
  materials?: string[];
  priceRange?: { min: number; max: number; currency: string };
  queueDepth?: number;
}

/** Encrypted envelope — NaCl box wrapping any payload */
export interface EncryptedEnvelope {
  ciphertext: string; // base64
  ephemeralPublicKey: string; // hex
  nonce: string; // base64
}

/** Connection state */
export type ConnectionState = "connecting" | "connected" | "encrypted" | "disconnected";

/** Transport type */
export type TransportType = "websocket-direct" | "websocket-relay" | "webrtc" | "http-poll";

/** Announcement that encrypted evidence is available on IPFS */
export interface EvidenceAnnouncement {
  type: "evidence";
  bundleId: string;
  cid: string;                    // IPFS CID of encrypted bundle
  litNetwork: string;             // "chipotle"
  accessConditions: object[];     // Lit access conditions (on-chain checks)
  escrowAddress: string;          // MilestoneEscrow contract address
  jobId: string;
  operatorDid: string;            // did:pcc:operator:...
  timestamp: string;              // ISO 8601
  signature: string;              // Ed25519 over canonical JSON (minus signature field)
}
