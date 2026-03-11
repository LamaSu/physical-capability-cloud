export { createGateway } from "./server.js";
export { initStore, getRepos, getStore, closeStore } from "./db.js";
export { broadcastNotification } from "./sse/notifications.js";
export { createSession, getSession, getOrCreateSession } from "./session.js";
export { getPublicClient, readEscrow, readTokenBalance, readTokenAllowance, getEscrowEvents } from "./chain-client.js";
export type { OnChainEscrow, OnChainMilestone } from "./chain-client.js";
export {
  getEscrowState,
  getDispute,
  getEvents,
  fundEscrow,
  approveToken,
  releaseMilestone,
  fileDispute,
  depositBond,
  submitEvidence,
  submitAttestation,
  isWriteEnabled,
  getSignerAddress,
} from "./contracts/escrow-client.js";
export type { OnChainEscrowState, OnChainDispute, EscrowEvent, WriteResult } from "./contracts/escrow-client.js";
export { initAgentBridge, shutdownAgentBridge, isAgentBridgeReady, getAgentStatus } from "./agent-bridge.js";
export { resolveSession } from "./auth/siwe-auth.js";
export { requireAuth, optionalAuth } from "./auth/require-auth.js";
