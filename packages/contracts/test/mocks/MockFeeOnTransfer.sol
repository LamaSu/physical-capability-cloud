// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../src/interfaces/IERC20.sol";

/**
 * @title MockFeeOnTransfer
 * @notice Fee-on-transfer ERC-20 used to verify MilestoneEscrow REJECTS
 *         deflationary tokens cleanly. Each transfer burns `feeBps/10000`
 *         of the amount, so the recipient receives less than the caller
 *         passed as `amount`. This breaks naive accounting and must revert
 *         in the escrow's balance-delta check.
 */
contract MockFeeOnTransfer is IERC20 {
    string public name = "Mock FoT";
    string public symbol = "mFOT";
    uint8 public decimals = 18;

    uint16 public feeBps = 100; // 1% burn on every transfer

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        _mint(msg.sender, initialSupply);
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

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transferWithFee(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= amount, "Insufficient allowance");
        _allowances[from][msg.sender] = allowed - amount;
        _transferWithFee(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _transferWithFee(address from, address to, uint256 amount) internal {
        require(_balances[from] >= amount, "Insufficient balance");
        uint256 fee = (amount * feeBps) / 10000;
        uint256 sent = amount - fee;

        _balances[from] -= amount;
        _balances[to] += sent;
        // Burn the fee — total supply decreases
        _totalSupply -= fee;

        emit Transfer(from, to, sent);
        emit Transfer(from, address(0), fee);
    }

    function _mint(address to, uint256 amount) internal {
        _totalSupply += amount;
        _balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
