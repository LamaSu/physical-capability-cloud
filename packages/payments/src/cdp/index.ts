// Coinbase CDP funded-key on-ramp (lane #017): card -> embedded wallet -> scoped,
// revocable spend-permission key. Mock-first; real-SDK wiring is a contained seam.
export { CdpWalletClient } from "./wallet-client.js";
export { CdpOnrampClient, type CreateOnrampParams } from "./onramp-client.js";
export {
  CdpSpendPermissionService,
  type IssueSpendPermissionParams,
} from "./spend-permission-service.js";
export type {
  CdpConfig,
  CdpNetwork,
  CdpWallet,
  OnrampSession,
  SpendPermission,
} from "./types.js";
