// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPCCOracle} from "./interfaces/IPCCOracle.sol";

/**
 * @title PCCVerificationOracle
 * @notice Reference on-chain verifier for off-chain PCC oracle attestations.
 *
 * The oracle daemon (off-chain) signs attestations with an ECDSA key. This
 * contract is the sole source of truth for whether a given signature
 * matches. `PCCProtocol` calls `verifyAttestation` before collecting a
 * settlement fee.
 *
 * ── Schema versioning ──────────────────────────────────────────────────
 *
 * Attestations carry a `version` field. This contract currently accepts
 * only v1 (see `SUPPORTED_VERSION`). Any other version returns `false`
 * from `verifyAttestation` — it does NOT revert, because `verifyAttestation`
 * is a view and callers may want to test candidate versions without a
 * revert.
 *
 * When bumping to v2: deploy a new oracle contract with the new version
 * constant. The escrow protocol's `oracleVerifier` immutable is also
 * per-deployment, so migration is explicit and deliberate.
 *
 * ── Signing hash ───────────────────────────────────────────────────────
 *
 * The oracle daemon signs:
 *   keccak256(abi.encode(
 *     version, escrowAddress, jobId, evidenceHash, tier,
 *     verified, timestamp, nonce, extraData
 *   ))
 *
 * Note: `signature` is deliberately excluded. `extraData` IS included,
 * so v1 attestations with a non-empty extraData will have different
 * hashes than ones with extraData = 0x. Attackers cannot swap extraData
 * after-the-fact without invalidating the signature.
 *
 * The signed bytes are wrapped in Ethereum's standard
 * "\x19Ethereum Signed Message:\n32" prefix so off-chain signers
 * can use `eth_sign` / `personal_sign` without building the raw hash
 * themselves.
 */
contract PCCVerificationOracle is IPCCOracle {
    /// @notice The attestation schema version this oracle verifies.
    uint8 public constant SUPPORTED_VERSION = 1;

    /// @notice Ethereum signed message prefix for 32-byte hashes.
    ///         Matches `personal_sign` / `eth_sign`.
    bytes private constant ETH_PREFIX =
        "\x19Ethereum Signed Message:\n32";

    /// @notice The ECDSA address whose signature is accepted. IMMUTABLE.
    address public immutable signer;

    constructor(address _signer) {
        require(_signer != address(0), "Oracle: zero signer");
        signer = _signer;
    }

    /// @inheritdoc IPCCOracle
    function oracleAddress() external view override returns (address) {
        return signer;
    }

    /// @inheritdoc IPCCOracle
    function verifyAttestation(
        Attestation calldata attestation
    ) external view override returns (bool valid) {
        // Reject unsupported versions — never silently accept forward-looking
        // v2 attestations on a v1 verifier.
        if (attestation.version != SUPPORTED_VERSION) {
            return false;
        }

        bytes32 msgHash = keccak256(
            abi.encode(
                attestation.version,
                attestation.escrowAddress,
                attestation.jobId,
                attestation.evidenceHash,
                attestation.tier,
                attestation.verified,
                attestation.timestamp,
                attestation.nonce,
                attestation.extraData
            )
        );

        bytes32 ethHash = keccak256(abi.encodePacked(ETH_PREFIX, msgHash));

        address recovered = _recover(ethHash, attestation.signature);
        if (recovered == address(0)) {
            return false;
        }
        return recovered == signer;
    }

    /**
     * @notice Public helper so off-chain signers / tests can compute the
     *         exact signing hash this contract will verify against.
     */
    function signingHash(
        Attestation calldata attestation
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encode(
                attestation.version,
                attestation.escrowAddress,
                attestation.jobId,
                attestation.evidenceHash,
                attestation.tier,
                attestation.verified,
                attestation.timestamp,
                attestation.nonce,
                attestation.extraData
            )
        );
    }

    // ── ECDSA recovery (self-contained, no external dep) ─────────────────

    /**
     * @dev Recover the signer from a 65-byte (r || s || v) or 64-byte
     *      (r || vs) signature, OpenZeppelin-compatible. Returns
     *      address(0) on malleable or malformed signatures.
     */
    function _recover(
        bytes32 hash,
        bytes calldata signature
    ) private pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;

        if (signature.length == 65) {
            // Layout: r (32) || s (32) || v (1)
            r = bytes32(signature[0:32]);
            s = bytes32(signature[32:64]);
            v = uint8(signature[64]);
        } else if (signature.length == 64) {
            // EIP-2098 compact: r (32) || vs (32). v = 27 + (vs >> 255).
            r = bytes32(signature[0:32]);
            bytes32 vs = bytes32(signature[32:64]);
            s = vs &
                0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
            v = uint8(uint256(vs) >> 255) + 27;
        } else {
            return address(0);
        }

        // Reject s-values in the upper half (malleability guard, EIP-2).
        if (
            uint256(s) >
            0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
        ) {
            return address(0);
        }
        if (v != 27 && v != 28) {
            return address(0);
        }

        return ecrecover(hash, v, r, s);
    }
}
