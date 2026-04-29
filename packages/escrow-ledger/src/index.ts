/**
 * @pcc/escrow-ledger — explicit state machine + atomic ledger ops backing
 * the centralized PCC settlement substrate.
 */

export {
  transition,
  validTransitions,
  isTerminal,
  InvalidTransitionError,
} from "./state-machine.js";
export type { TransitionEvent } from "./state-machine.js";

export {
  EscrowLedger,
  InMemoryLedgerStore,
  InsufficientBalanceError,
  EscrowEmptyError,
  userAccount,
  operatorAccount,
  escrowAccount,
} from "./ledger.js";
export type { LedgerStore } from "./ledger.js";

export {
  ActorSchema,
  AmountSchema,
  SessionSchema,
  SessionStateSchema,
  LedgerEntrySchema,
  LedgerEntryKindSchema,
} from "./types.js";
export type {
  Actor,
  Amount,
  Session,
  SessionState,
  LedgerEntry,
  LedgerEntryKind,
  LockReceipt,
  ReleaseReceipt,
  RefundReceipt,
} from "./types.js";
