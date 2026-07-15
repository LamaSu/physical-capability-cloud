// Coinbase CDP funded-key on-ramp (lane #017): card -> embedded wallet -> scoped,
// revocable spend-permission key. Mock-first; real-SDK wiring is a contained seam.
export {
  CdpWalletClient,
  type RegisterUserOwnedWalletParams,
} from "./wallet-client.js";
export { CdpOnrampClient, type CreateOnrampParams } from "./onramp-client.js";
export {
  CdpSpendPermissionService,
  type IssueSpendPermissionParams,
} from "./spend-permission-service.js";
export {
  CustodyViolationError,
  UserOwnedWalletRegistry,
  isUserOwned,
  isAddressShape,
  validateAddressShape,
  assertServerSignable,
  assertNoOwnerRotation,
  assertServerManaged,
  type UserOwnedWalletRecord,
} from "./custody.js";
export type {
  CdpConfig,
  CdpNetwork,
  CdpWallet,
  OnrampSession,
  SpendPermission,
} from "./types.js";
