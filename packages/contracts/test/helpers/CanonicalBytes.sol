// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CanonicalBytes
 * @notice Test helper for building canonical-JSON bytes for a RateSchedule
 *         entirely in Solidity, byte-equivalent to what
 *         `packages/spec/src/util/canonical.ts` produces off-chain.
 *
 *         Why this lives here (and not in src/):
 *           Production code never needs to construct canonical bytes on-chain
 *           — the off-chain SDK (TypeScript) produces them and the
 *           RateScheduleRegistry simply hashes whatever bytes it receives.
 *           This helper exists ONLY so end-to-end forge tests can prove the
 *           full pipeline works without spawning Node out-of-band: build the
 *           bytes in Solidity, compute sha256 in Solidity, publish to the
 *           registry in Solidity, mint an NFT against the same hash, and
 *           settle a milestone — all inside one VM transaction.
 *
 *         Canonical encoding rules (mirrors canonical.ts):
 *           1. JSON keys sorted lexicographically at every depth.
 *           2. No whitespace.
 *           3. Numbers unquoted; booleans `true`/`false`; null literal `null`.
 *           4. Strings JSON-quoted.
 *
 *         For a RateSchedule shape `{version, segments: [{kind, ...}]}` the
 *         segment object's keys sort to: bps < endTime < kind < startTime.
 *         The outer object's keys sort to: segments < version. Verified
 *         against the off-chain canonicalize() output via the comments
 *         attached to each helper below — re-verify with:
 *
 *         ```
 *         node --input-type=module -e "
 *           import {canonicalize} from './packages/spec/dist/util/canonical.js';
 *           import {createHash} from 'node:crypto';
 *           const s = {version:1,segments:[{kind:'constant',startTime:0,endTime:null,bps:250}]};
 *           const c = canonicalize(s);
 *           console.log(c);
 *           console.log(createHash('sha256').update(c, 'utf8').digest('hex'));
 *         "
 *         ```
 *
 *         If the off-chain canonicalization changes (key set, ordering,
 *         encoding rules) this helper MUST be updated in lockstep — there
 *         is no automated cross-check yet. The commit `218afa7` added the
 *         capture-class-indexed segment kind without breaking the helpers
 *         here because constant-segment encoding is unchanged; future
 *         changes might not be so kind.
 */
library CanonicalBytes {
    // ──────────────────────────────────────────────────────────────────────
    // Constant segment, endTime = null  (i.e. effective forever)
    //
    // Canonical bytes:
    //   {"segments":[{"bps":<bps>,"endTime":null,"kind":"constant","startTime":<startTime>}],"version":<version>}
    //
    // Reference vector (verified against canonicalize() on 2026-04-24):
    //   constantOpenEnded(0, 250, 1) →
    //     {"segments":[{"bps":250,"endTime":null,"kind":"constant","startTime":0}],"version":1}
    //   sha256: d0ba2ae3fe3c21f754281c31c6066a3214d2265f114f921ce8bfe7b186cd3d8b
    // ──────────────────────────────────────────────────────────────────────
    function constantOpenEnded(uint256 startTime, uint256 bps, uint256 version)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            '{"segments":[{"bps":', _u(bps),
            ',"endTime":null,"kind":"constant","startTime":', _u(startTime),
            '}],"version":', _u(version), '}'
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // Constant segment, endTime = explicit number  (closed interval upper)
    //
    // Canonical bytes:
    //   {"segments":[{"bps":<bps>,"endTime":<endTime>,"kind":"constant","startTime":<startTime>}],"version":<version>}
    //
    // Reference vector (verified against canonicalize() on 2026-04-24):
    //   constantBounded(100, 1000, 500, 1) →
    //     {"segments":[{"bps":500,"endTime":1000,"kind":"constant","startTime":100}],"version":1}
    //   sha256: a41c4e012ac749fd69949364cbcb4080596ecf09e3950ab5247f230707e88126
    // ──────────────────────────────────────────────────────────────────────
    function constantBounded(
        uint256 startTime,
        uint256 endTime,
        uint256 bps,
        uint256 version
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            '{"segments":[{"bps":', _u(bps),
            ',"endTime":', _u(endTime),
            ',"kind":"constant","startTime":', _u(startTime),
            '}],"version":', _u(version), '}'
        );
    }

    // ── Internal: uint256 → ASCII decimal ──────────────────────────────────
    function _u(uint256 n) private pure returns (string memory) {
        if (n == 0) return "0";
        uint256 j = n;
        uint256 length;
        while (j != 0) {
            length++;
            j /= 10;
        }
        bytes memory bstr = new bytes(length);
        uint256 k = length;
        while (n != 0) {
            k -= 1;
            uint8 temp = uint8(48 + n % 10);
            bstr[k] = bytes1(temp);
            n /= 10;
        }
        return string(bstr);
    }
}
