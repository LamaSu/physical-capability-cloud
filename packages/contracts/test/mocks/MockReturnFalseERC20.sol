// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../src/interfaces/IERC20.sol";

/**
 * @title MockReturnFalseERC20
 * @notice ERC-20 that returns `false` from transfer/transferFrom but does NOT
 *         revert — simulates legacy tokens that silently fail. SafeERC20 MUST
 *         revert when returndata decodes to `false`.
 */
contract MockReturnFalseERC20 is IERC20 {
    string public name = "Mock False";
    string public symbol = "mFLS";
    uint8 public decimals = 18;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _totalSupply;

    constructor(uint256 initialSupply) {
        _totalSupply = initialSupply;
        _balances[msg.sender] = initialSupply;
    }

    function totalSupply() external view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view override returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure override returns (bool) {
        return false; // always fail silently
    }

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false;
    }

    function mint(address to, uint256 amount) external {
        _totalSupply += amount;
        _balances[to] += amount;
    }
}
