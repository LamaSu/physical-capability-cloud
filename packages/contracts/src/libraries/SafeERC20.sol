// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";

/**
 * @title SafeERC20
 * @notice Minimal drop-in replacement for OpenZeppelin's SafeERC20 that tolerates
 *         non-compliant ERC-20 tokens such as USDT (Tether on Ethereum mainnet),
 *         which does NOT return a boolean from `transfer` / `transferFrom` / `approve`.
 *
 * Semantics:
 *   - If the token returns no data, the call is considered successful.
 *   - If the token returns data, it MUST decode to `true`.
 *   - Any revert propagates.
 *
 * This makes MilestoneEscrow safe for use with the real-world USDT contract and
 * any other non-standard ERC-20 while still enforcing correctness for compliant
 * tokens like USDC, DAI, PYUSD, USDP, FRAX, etc.
 */
library SafeERC20 {
    error SafeERC20FailedOperation(address token);

    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(
            address(token),
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        _callOptionalReturn(
            address(token),
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value)
        );
    }

    /**
     * @dev Imitates OZ's internal `_callOptionalReturn`. We use a low-level call so
     *      that calls to non-compliant tokens that return NO data (USDT) do not revert
     *      on ABI decoding, while still catching the case where a token explicitly
     *      returns `false`.
     */
    function _callOptionalReturn(address token, bytes memory data) private {
        // Must have code — guards against calling an EOA / non-contract
        require(token.code.length > 0, "SafeERC20: not a contract");

        (bool success, bytes memory returndata) = token.call(data);
        if (!success) {
            // Propagate revert reason if present
            if (returndata.length > 0) {
                assembly {
                    let returndata_size := mload(returndata)
                    revert(add(32, returndata), returndata_size)
                }
            } else {
                revert SafeERC20FailedOperation(token);
            }
        }

        // If there IS returndata, it must decode to `true`. If there's none, silent success is fine.
        if (returndata.length > 0 && !abi.decode(returndata, (bool))) {
            revert SafeERC20FailedOperation(token);
        }
    }
}
