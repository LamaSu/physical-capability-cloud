// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {O5AttesterBase} from "./O5AttesterBase.sol";

/**
 * @title Fixed2of3O5Attester
 * @notice MAINNET cohort attester (addendum §J.3): a fixed 2-of-3 threshold verifier whose signer set
 *         and quorum are IMMUTABLE by construction. Three constructor-set signer EOAs, a compile-time
 *         threshold of 2, and no upgrade/module/guard/rotation/re-enable/setter — so freezing the
 *         address freezes the trust root (a mutable Safe cannot be swapped in behind it).
 * @dev    Quorum rule: EXACTLY two signatures whose recovered signers are STRICTLY ASCENDING (⇒ unique
 *         AND sorted) and each a member of the immutable 3-signer set. Strict-ascending is what blocks a
 *         duplicate-signer "quorum". Recovery + malleability guards live in {O5AttesterBase}.
 */
contract Fixed2of3O5Attester is O5AttesterBase {
    uint256 private constant THRESHOLD = 2;

    address public immutable signer0;
    address public immutable signer1;
    address public immutable signer2;

    constructor(
        address signer0_,
        address signer1_,
        address signer2_,
        address eas_,
        bytes32 o5SchemaUid_,
        uint64 cohortId_,
        address revoker_
    ) O5AttesterBase(eas_, o5SchemaUid_, cohortId_, revoker_) {
        if (signer0_ == address(0) || signer1_ == address(0) || signer2_ == address(0)) revert ZeroSigner();
        if (signer0_ == signer1_ || signer0_ == signer2_ || signer1_ == signer2_) revert DuplicateSigner();
        signer0 = signer0_;
        signer1 = signer1_;
        signer2 = signer2_;
    }

    /// @notice True iff `a` is one of the three immutable cohort signers.
    function isSigner(address a) public view returns (bool) {
        return a == signer0 || a == signer1 || a == signer2;
    }

    /// @inheritdoc O5AttesterBase
    function _verifySignatures(bytes32 digest, bytes[] calldata signatures) internal view override {
        if (signatures.length != THRESHOLD) revert WrongSignatureCount();
        address last = address(0);
        for (uint256 i; i < THRESHOLD; ++i) {
            address rec = _recoverEOA(digest, signatures[i]);
            if (rec <= last) revert SignersNotSortedOrUnique(); // strictly ascending ⇒ unique + sorted
            if (!isSigner(rec)) revert NotAuthorizedSigner();
            last = rec;
        }
    }
}
