// Coinbase CDP funded-key on-ramp (lane #017): card -> embedded wallet -> scoped,
// revocable spend-permission key. Mock-first; real-SDK wiring is a contained seam.
export { CdpWalletClient, CDP_MOCK_ADDRESS_PREFIX, isCdpMockAddress } from "./wallet-client.js";
export { CdpOnrampClient, type CreateOnrampParams } from "./onramp-client.js";
export {
  CdpSpendPermissionService,
  CdpSpendPermissionInputError,
  CdpSpendPermissionListIncompleteError,
  CdpSpendPermissionNotFoundError,
  CdpSpendPermissionRevokeUnconfirmedError,
  CdpUserOperationFailedError,
  CdpSpendPermissionUnconfirmedError,
  type IssueSpendPermissionParams,
} from "./spend-permission-service.js";
export { cdpCredentialsComplete } from "./mode.js";
export type {
  CdpConfig,
  CdpNetwork,
  CdpWallet,
  OnrampSession,
  SpendPermission,
} from "./types.js";
