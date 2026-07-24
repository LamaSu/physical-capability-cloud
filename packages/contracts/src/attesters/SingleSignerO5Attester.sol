// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {O5AttesterBase} from "./O5AttesterBase.sol";

/**
 * @title SingleSignerO5Attester
 * @notice TESTNET cohort attester (addendum §J.3): a single immutable signer, threshold 1, no value at
 *         stake. Same {IOracleAttester} surface + one-way kill-switch as the mainnet cohort so testnet
 *         exercises the identical escrow funding/release paths — only the quorum posture differs.
 * @dev    NEVER deploy this to mainnet; it exists so composed units + the DA/manifest path can be proven
 *         out at zero value-at-risk (§J.4).
 */
contract SingleSignerO5Attester is O5AttesterBase {
    address public immutable signer;

    constructor(address signer_, address eas_, bytes32 o5SchemaUid_, uint64 cohortId_, address revoker_)
        O5AttesterBase(eas_, o5SchemaUid_, cohortId_, revoker_)
    {
        if (signer_ == address(0)) revert ZeroSigner();
        // L-03 separation of duties (parity with Fixed2of3O5Attester): the kill-switch holder must not also
        // be the signing key, or one compromised key could both sign AND permanently disable the cohort.
        // Low-value on testnet, but kept uniform. (revoker_ != 0 is already enforced in O5AttesterBase.)
        if (revoker_ == signer_) revert RevokerIsSigner();
        signer = signer_;
    }

    /// @inheritdoc O5AttesterBase
    function _verifySignatures(bytes32 digest, bytes[] calldata signatures) internal view override {
        if (signatures.length != 1) revert WrongSignatureCount();
        if (_recoverEOA(digest, signatures[0]) != signer) revert NotAuthorizedSigner();
    }
}
