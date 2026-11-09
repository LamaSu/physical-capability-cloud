import type { RecheckField } from "./types.js";

/** Every call/code read uses EIP-1898 { blockHash: asOfBlockHash, requireCanonical: true }.
 * Logs scan [fromBlock, asOfBlock]; each log hash must be canonical at its number. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const PHASE_BY_STATE: Readonly<Record<number, string>> = Object.freeze({
  1: "active", 2: "contest", 3: "contest", 4: "escalation", 5: "escalation",
  6: "allocated", 7: "allocated", 8: "settled", 9: "settled",
});
export const FINAL_STATE_BY_STATE: Readonly<Record<number, string | null>> = Object.freeze({
  1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null,
  8: "SETTLED_RELEASED", 9: "SETTLED_REFUNDED",
});
export const TERMINAL_STATES: readonly number[] = Object.freeze([8, 9]);
export const ALLOCATED_STATES: readonly number[] = Object.freeze([6, 7]);

export const SETTLEMENT_RECHECK_MAPS: Readonly<Record<"vnext-read-v1", readonly RecheckField[]>> = freeze({
  "vnext-read-v1": [
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/chainId", "source": "chain-header", "reads": [{"kind": "header", "what": "eth_chainId"}], "rule": "Equals eth_chainId and /deployment/chainId.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/escrow", "source": ["chain-code", "chain-state"], "reads": [{"kind": "code", "contract": "escrow", "check": "eip1167"}, {"kind": "call", "contract": "escrow", "fn": "initialized", "args": [], "output": "0"}, {"kind": "call", "contract": "escrow", "fn": "unitExists", "args": ["unitId"], "output": "0"}], "rule": "Code is the EIP-1167 runtime 0x363d3d373d3d3d363d73 followed by the known implementation and 0x5af43d82803e903d91602b57fd5bf3; initialized() is true (only the factory initializes a clone), and the unit exists.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/unitId", "source": ["echo", "chain-state"], "reads": [{"kind": "call", "contract": "escrow", "fn": "unitExists", "args": ["unitId"], "output": "0"}], "rule": "Equals the requested unit, which exists at the pin.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/deployment", "source": "kit", "reads": [], "rule": "An object with exactly chainId, factory, implementation and recordSha256.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/deployment/chainId", "source": "chain-header", "reads": [{"kind": "header", "what": "eth_chainId"}], "rule": "Equals eth_chainId.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/deployment/factory", "source": "chain-state", "reads": [{"kind": "call", "contract": "escrow", "fn": "factory", "args": [], "output": "0"}], "rule": "Equals escrow.factory() and the known deployment's factory.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/deployment/implementation", "source": ["chain-state", "chain-code"], "reads": [{"kind": "call", "contract": "factory", "fn": "implementation", "args": [], "output": "0"}, {"kind": "code", "contract": "implementation", "check": "codehash"}], "rule": "Equals factory.implementation(); keccak256(code) equals the known deployment's implementationCodehash.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/deployment/recordSha256", "source": "kit", "reads": [], "rule": "Names a KNOWN_DEPLOYMENTS entry whose chainId, factory and implementation equal /deployment/chainId, /deployment/factory and /deployment/implementation.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/asOfBlock", "source": "chain-header", "reads": [{"kind": "header", "what": "block by hash: asOfBlockHash"}], "rule": "The block exists and its number equals this decimal string.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/asOfBlockHash", "source": "chain-header", "reads": [{"kind": "header", "what": "block by number: asOfBlock"}], "rule": "The canonical block at asOfBlock has this hash.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/finality", "source": "chain-header", "reads": [{"kind": "header", "what": "block finalized"}], "rule": "Equals finalized, and asOfBlock is at most the node's finalized number.", "money": true},
    {"routes": ["lifecycle", "receipt", "provenance"], "pointer": "/logCompleteness", "source": "gateway-claim", "reads": [], "rule": "Reported, not checked; UNKNOWN log fields read as NOT_CLAIMED.", "money": false},
    {"routes": ["lifecycle"], "pointer": "/unitState", "source": "chain-state", "reads": [{"kind": "call", "contract": "escrow", "fn": "settlement", "args": ["unitId"], "output": "state_"}], "rule": "Equals settlement state_.", "money": true},
    {"routes": ["lifecycle", "receipt"], "pointer": "/phase", "source": "derived", "reads": [], "rule": "Equals PHASE_BY_STATE: 1 active; 2-3 contest; 4-5 escalation; 6-7 allocated; 8-9 settled.", "money": true, "inputs": ["/unitState"]},
    {"routes": ["lifecycle", "receipt"], "pointer": "/finalState", "source": "derived", "reads": [], "rule": "State 8 gives SETTLED_RELEASED; 9 gives SETTLED_REFUNDED; otherwise null.", "money": true, "inputs": ["/unitState"]},
    {"routes": ["lifecycle"], "pointer": "/isTerminal", "source": "derived", "reads": [], "rule": "True exactly when state is in TERMINAL_STATES {8, 9}.", "money": true, "inputs": ["/unitState"]},
    {"routes": ["lifecycle", "receipt"], "pointer": "/isAllocated", "source": "derived", "reads": [], "rule": "True exactly when state is in ALLOCATED_STATES {6, 7}.", "money": true, "inputs": ["/unitState"]},
    {"routes": ["lifecycle"], "pointer": "/windowEndsAt", "source": "derived", "reads": [{"kind": "call", "contract": "escrow", "fn": "settlement", "args": ["unitId"], "output": "assertedAt_"}, {"kind": "call", "contract": "escrow", "fn": "settlement", "args": ["unitId"], "output": "challengedAt_"}, {"kind": "call", "contract": "escrow", "fn": "unitTerms", "args": ["unitId"], "output": "reclaimAt_"}, {"kind": "call", "contract": "escrow", "fn": "emergencyAnchorOf", "args": ["unitId"], "output": "0"}], "rule": "States 2 and 5: assertedAt + challengeWindowSec; state 3: challengedAt + appealWindowSec, capped at a non-zero emergency anchor; state 4: reclaimAt - challengeWindowSec - appealWindowSec; otherwise null, with non-null results as decimal strings.", "money": true, "knownDrift": "E4.3", "inputs": ["/unitState", "deployment.challengeWindowSec", "deployment.appealWindowSec"]},
    {"routes": ["receipt"], "pointer": "/network", "source": "echo", "reads": [], "rule": "An object with exactly chainId.", "money": true},
    {"routes": ["receipt"], "pointer": "/network/chainId", "source": "echo", "reads": [], "rule": "Equals /chainId.", "money": true, "inputs": ["/chainId"]},
    {"routes": ["receipt"], "pointer": "/assetReality", "source": "registry", "reads": [], "rule": "Null or the registry envelope, whose verdict is NOT_CHAIN_CHECKABLE.", "money": true, "knownDrift": "E2"},
    {"routes": ["receipt"], "pointer": "/assetReality/value", "source": "registry", "reads": [], "rule": "One of real, test or unknown; NOT_CHAIN_CHECKABLE.", "money": true},
    {"routes": ["receipt"], "pointer": "/assetReality/source", "source": "derived", "reads": [], "rule": "The constant registry.", "money": false, "inputs": []},
    {"routes": ["receipt"], "pointer": "/assetReality/contractOrRegistryId", "source": "registry", "reads": [], "rule": "NOT_CHAIN_CHECKABLE.", "money": false},
    {"routes": ["receipt"], "pointer": "/assetReality/revision", "source": "registry", "reads": [], "rule": "NOT_CHAIN_CHECKABLE.", "money": false},
    {"routes": ["receipt"], "pointer": "/assetReality/attests", "source": "derived", "reads": [], "rule": "The constant identity-not-liveness.", "money": true, "inputs": []},
    {"routes": ["receipt"], "pointer": "/economics", "source": "derived", "reads": [{"kind": "call", "contract": "escrow", "fn": "unitCounters", "args": ["unitId"], "output": "payoutCount_"}], "rule": "Null is NOT_CLAIMED; non-null is allowed only when payoutCount_ is 1.", "money": true, "knownDrift": "E2", "inputs": []},
    {"routes": ["receipt"], "pointer": "/economics/amount", "source": "chain-state", "reads": [{"kind": "call", "contract": "escrow", "fn": "payoutAt", "args": ["unitId", "0"], "output": "amount"}], "rule": "The recipient's amount (net of the fee): equals payoutAt amount, which for one leg equals feeAmountsOf n_, never the buyer's gross.", "money": true, "knownDrift": "E2"},
    {"routes": ["receipt"], "pointer": "/economics/feeAmount", "source": "chain-state", "reads": [{"kind": "call", "contract": "escrow", "fn": "feeAmountsOf", "args": ["unitId"], "output": "f_"}], "rule": "Equals feeAmountsOf f_.", "money": true},
    {"routes": ["receipt"], "pointer": "/economics/recipient", "source": "chain-state", "reads": [{"kind": "call", "contract": "escrow", "fn": "payoutAt", "args": ["unitId", "0"], "output": "recipient"}], "rule": "Equals payoutAt recipient, compared lower-case.", "money": true, "knownDrift": "E2"},
    {"routes": ["receipt"], "pointer": "/economics/token", "source": "chain-state", "reads": [{"kind": "call", "contract": "escrow", "fn": "USDC", "args": [], "output": "0"}], "rule": "Equals USDC() and the known deployment's usdc.", "money": true},
    {"routes": ["receipt"], "pointer": "/economics/assuranceTier", "source": "chain-state", "reads": [{"kind": "call", "contract": "escrow", "fn": "requiredTierOf", "args": ["unitId"], "output": "0"}], "rule": "Equals requiredTierOf; at funding requiredTier must equal requestedTier.", "money": true, "knownDrift": "E2"},
    {"routes": ["receipt"], "pointer": "/refundReason", "source": "chain-log", "reads": [{"kind": "logs", "contract": "escrow", "event": "Finalized", "unitIdTopic": 1}, {"kind": "logs", "contract": "escrow", "event": "EscalationResolved", "unitIdTopic": 1}], "rule": "Null unless state is 7 or 9; witnessed causes are Finalized reason 2 BACKUP_NO_RELEASE, 3 EMERGENCY_SILENCE, 4 DEADLINE_RECLAIM, or EscalationResolved not upheld with role 1 APPEAL_OVERTURN or role 2 EMERGENCY_OVERTURN; UNKNOWN is NOT_CLAIMED.", "money": true, "knownDrift": "E4.1"},
    {"routes": ["receipt"], "pointer": "/refundReason/value", "source": "chain-log", "reads": [{"kind": "logs", "contract": "escrow", "event": "Finalized", "unitIdTopic": 1}, {"kind": "logs", "contract": "escrow", "event": "EscalationResolved", "unitIdTopic": 1}], "rule": "Equals the witnessed refund cause.", "money": true, "knownDrift": "E4.1"},
    {"routes": ["receipt"], "pointer": "/refundReason/source", "source": "derived", "reads": [], "rule": "The constant log.", "money": false, "inputs": []},
    {"routes": ["receipt"], "pointer": "/refundReason/chain", "source": "derived", "reads": [], "rule": "Equals eip155: followed by chainId.", "money": false, "inputs": ["/chainId"]},
    {"routes": ["receipt"], "pointer": "/refundReason/contractOrRegistryId", "source": "echo", "reads": [], "rule": "Equals /escrow.", "money": false, "inputs": ["/escrow"]},
    {"routes": ["receipt"], "pointer": "/refundReason/blockNumber", "source": "echo", "reads": [], "rule": "Equals /asOfBlock (the pin, not the log's block).", "money": false, "inputs": ["/asOfBlock"]},
    {"routes": ["receipt"], "pointer": "/refundReason/blockHash", "source": "echo", "reads": [], "rule": "Equals /asOfBlockHash.", "money": false, "inputs": ["/asOfBlockHash"]},
    {"routes": ["receipt"], "pointer": "/refundReason/finality", "source": "echo", "reads": [], "rule": "Equals /finality.", "money": false, "inputs": ["/finality"]},
    {"routes": ["receipt"], "pointer": "/refundReason/completeness", "source": "echo", "reads": [], "rule": "Equals /logCompleteness.", "money": false, "inputs": ["/logCompleteness"]},
    {"routes": ["receipt"], "pointer": "/finalizedBlock", "source": "chain-log", "reads": [{"kind": "logs", "contract": "escrow", "event": "ReleaseAllocated", "unitIdTopic": 1}, {"kind": "logs", "contract": "escrow", "event": "RefundAllocated", "unitIdTopic": 1}, {"kind": "logs", "contract": "escrow", "event": "ClaimCreated", "unitIdTopic": 2}, {"kind": "logs", "contract": "escrow", "event": "ClaimDischarged", "unitIdTopic": 2}], "rule": "Null unless state is 8 or 9; inline settlement uses the allocation event block when claimCount is 0, and deferred settlement uses the ClaimDischarged block that discharged the last job-class claim (classes 0-2); UNKNOWN is NOT_CLAIMED.", "money": true, "knownDrift": "E4.2"},
    {"routes": ["receipt"], "pointer": "/finalizedBlock/value", "source": "chain-log", "reads": [{"kind": "logs", "contract": "escrow", "event": "ReleaseAllocated", "unitIdTopic": 1}, {"kind": "logs", "contract": "escrow", "event": "RefundAllocated", "unitIdTopic": 1}, {"kind": "logs", "contract": "escrow", "event": "ClaimCreated", "unitIdTopic": 2}, {"kind": "logs", "contract": "escrow", "event": "ClaimDischarged", "unitIdTopic": 2}], "rule": "Equals that settlement block number as a decimal string.", "money": true, "knownDrift": "E4.2"},
    {"routes": ["receipt"], "pointer": "/finalizedBlock/source", "source": "derived", "reads": [], "rule": "The constant log.", "money": false, "inputs": []},
    {"routes": ["receipt"], "pointer": "/finalizedBlock/chain", "source": "derived", "reads": [], "rule": "Equals eip155: followed by chainId.", "money": false, "inputs": ["/chainId"]},
    {"routes": ["receipt"], "pointer": "/finalizedBlock/contractOrRegistryId", "source": "echo", "reads": [], "rule": "Equals /escrow.", "money": false, "inputs": ["/escrow"]},
    {"routes": ["receipt"], "pointer": "/finalizedBlock/blockNumber", "source": "echo", "reads": [], "rule": "Equals /asOfBlock (the pin, not the log's block).", "money": false, "inputs": ["/asOfBlock"]},
    {"routes": ["receipt"], "pointer": "/finalizedBlock/blockHash", "source": "echo", "reads": [], "rule": "Equals /asOfBlockHash.", "money": false, "inputs": ["/asOfBlockHash"]},
    {"routes": ["receipt"], "pointer": "/finalizedBlock/finality", "source": "echo", "reads": [], "rule": "Equals /finality.", "money": false, "inputs": ["/finality"]},
    {"routes": ["receipt"], "pointer": "/finalizedBlock/completeness", "source": "echo", "reads": [], "rule": "Equals /logCompleteness.", "money": false, "inputs": ["/logCompleteness"]},
    {"routes": ["provenance"], "pointer": "/provenanceAvailability", "source": ["derived", "gateway-claim"], "reads": [{"kind": "call", "contract": "escrow", "fn": "unitTerms", "args": ["unitId"], "output": "compositionSchemaVersion_"}], "rule": "When compositionSchemaVersion_ is 0 (non-composed), UNANCHORED is required; otherwise this is the gateway DA claim and NOT_CHAIN_CHECKABLE.", "money": false, "inputs": []},
    {"routes": ["provenance"], "pointer": "/compositionRoot", "source": "chain-state", "reads": [{"kind": "call", "contract": "escrow", "fn": "compositionRootOf", "args": ["unitId"], "output": "0"}], "rule": "Equals compositionRootOf when provenanceAvailability is AVAILABLE.", "money": false},
    {"routes": ["provenance"], "pointer": "/revision", "source": "offchain", "reads": [], "rule": "NOT_CHAIN_CHECKABLE.", "money": false},
    {"routes": ["provenance"], "pointer": "/leaves", "source": "offchain", "reads": [], "rule": "NOT_CHAIN_CHECKABLE.", "money": false},
    {"routes": ["provenance"], "pointer": "/leaves/*", "source": "offchain", "reads": [], "rule": "NOT_CHAIN_CHECKABLE.", "money": false},
    {"routes": ["provenance"], "pointer": "/leaves/*/kind", "source": "offchain", "reads": [], "rule": "NOT_CHAIN_CHECKABLE.", "money": false},
    {"routes": ["provenance"], "pointer": "/leaves/*/value", "source": "offchain", "reads": [], "rule": "NOT_CHAIN_CHECKABLE.", "money": false},
    {"routes": ["provenance"], "pointer": "/nextCursor", "source": "offchain", "reads": [], "rule": "NOT_CHAIN_CHECKABLE.", "money": false},
  ],
});
