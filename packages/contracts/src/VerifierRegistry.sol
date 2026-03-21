// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title VerifierRegistry
 * @notice Stake-based registry for human verifiers in the PCC network.
 *
 * Verifiers stake tokens to register. They can request unstaking and withdraw
 * after a 7-day cooldown. The arbiter (governance/owner) can slash stake for
 * bad behavior. An approved attestation submitter can reward verifiers.
 *
 * Reputation is tracked in basis points (0-10000).
 */
contract VerifierRegistry {
    IERC20 public immutable stakeToken;
    uint256 public constant MIN_STAKE = 100e6; // 100 USDC (6 decimals)
    uint256 public constant COOLDOWN_PERIOD = 7 days;

    struct Verifier {
        address addr;
        uint256 stake;
        uint256 reputation; // 0-10000 (basis points)
        uint256 registeredAt;
        uint256 unstakeRequestedAt; // 0 if not requested
        bool active;
    }

    mapping(address => Verifier) public verifiers;
    address[] public verifierList;

    // Simple access control — can be tightened later
    address public arbiter;
    address public rewardSource;

    // ── Events ────────────────────────────────────────────────────────────

    event VerifierRegistered(address indexed verifier, uint256 stake);
    event VerifierUnstakeRequested(address indexed verifier);
    event VerifierWithdrawn(address indexed verifier, uint256 amount);
    event VerifierSlashed(address indexed verifier, uint256 amount, string reason);
    event VerifierRewarded(address indexed verifier, uint256 amount);
    event ReputationUpdated(address indexed verifier, uint256 newReputation);

    // ── Errors ────────────────────────────────────────────────────────────

    error InsufficientStake(uint256 provided, uint256 required);
    error AlreadyRegistered(address verifier);
    error NotRegistered(address verifier);
    error NotActive(address verifier);
    error UnstakeNotRequested(address verifier);
    error CooldownNotElapsed(uint256 remaining);
    error Unauthorized(address caller);
    error SlashExceedsStake(uint256 amount, uint256 stake);
    error RewardTransferFailed();
    error InvalidReputation(uint256 value);

    // ── Constructor ───────────────────────────────────────────────────────

    constructor(address _stakeToken) {
        stakeToken = IERC20(_stakeToken);
        arbiter = msg.sender;
        rewardSource = msg.sender;
    }

    // ── Modifiers ─────────────────────────────────────────────────────────

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert Unauthorized(msg.sender);
        _;
    }

    modifier onlyRewardSource() {
        if (msg.sender != rewardSource) revert Unauthorized(msg.sender);
        _;
    }

    modifier onlyRegistered(address verifier) {
        if (verifiers[verifier].registeredAt == 0) revert NotRegistered(verifier);
        _;
    }

    // ── Write Functions ───────────────────────────────────────────────────

    /**
     * @notice Register as a verifier by staking tokens.
     * @param stakeAmount Amount of stake tokens to lock. Must be >= MIN_STAKE.
     */
    function register(uint256 stakeAmount) external {
        if (stakeAmount < MIN_STAKE) revert InsufficientStake(stakeAmount, MIN_STAKE);
        if (verifiers[msg.sender].registeredAt != 0) revert AlreadyRegistered(msg.sender);

        // Transfer stake from caller to this contract
        stakeToken.transferFrom(msg.sender, address(this), stakeAmount);

        verifiers[msg.sender] = Verifier({
            addr: msg.sender,
            stake: stakeAmount,
            reputation: 5000, // Start at 50% reputation (5000 bps)
            registeredAt: block.timestamp,
            unstakeRequestedAt: 0,
            active: true
        });

        verifierList.push(msg.sender);

        emit VerifierRegistered(msg.sender, stakeAmount);
    }

    /**
     * @notice Request to unstake. Begins the 7-day cooldown period.
     * Deactivates the verifier immediately (will not be assigned new requests).
     */
    function requestUnstake() external onlyRegistered(msg.sender) {
        Verifier storage v = verifiers[msg.sender];
        v.active = false;
        v.unstakeRequestedAt = block.timestamp;

        emit VerifierUnstakeRequested(msg.sender);
    }

    /**
     * @notice Withdraw stake after the cooldown period has elapsed.
     */
    function withdraw() external onlyRegistered(msg.sender) {
        Verifier storage v = verifiers[msg.sender];
        if (v.unstakeRequestedAt == 0) revert UnstakeNotRequested(msg.sender);

        uint256 elapsed = block.timestamp - v.unstakeRequestedAt;
        if (elapsed < COOLDOWN_PERIOD) {
            revert CooldownNotElapsed(COOLDOWN_PERIOD - elapsed);
        }

        uint256 amount = v.stake;
        v.stake = 0;
        v.active = false;

        stakeToken.transfer(msg.sender, amount);

        emit VerifierWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Slash a verifier's stake for misbehavior.
     * @param verifier Address of the verifier to slash.
     * @param amount   Amount to slash from their stake.
     * @param reason   Human-readable reason for the slash.
     */
    function slash(
        address verifier,
        uint256 amount,
        string calldata reason
    ) external onlyArbiter onlyRegistered(verifier) {
        Verifier storage v = verifiers[verifier];
        if (amount > v.stake) revert SlashExceedsStake(amount, v.stake);

        v.stake -= amount;
        if (v.stake < MIN_STAKE) {
            v.active = false;
        }

        // Slashed tokens go to the arbiter (treasury)
        stakeToken.transfer(arbiter, amount);

        emit VerifierSlashed(verifier, amount, reason);
    }

    /**
     * @notice Reward a verifier for correct behavior.
     * @param verifier Address of the verifier to reward.
     * @param amount   Token amount to send.
     */
    function reward(
        address verifier,
        uint256 amount
    ) external onlyRewardSource onlyRegistered(verifier) {
        // Transfer reward tokens from the reward source to the verifier
        stakeToken.transferFrom(msg.sender, verifier, amount);

        emit VerifierRewarded(verifier, amount);
    }

    /**
     * @notice Update a verifier's reputation score.
     * @param verifier       Address of the verifier.
     * @param newReputation  New reputation in basis points (0-10000).
     */
    function updateReputation(
        address verifier,
        uint256 newReputation
    ) external onlyArbiter onlyRegistered(verifier) {
        if (newReputation > 10000) revert InvalidReputation(newReputation);

        verifiers[verifier].reputation = newReputation;

        emit ReputationUpdated(verifier, newReputation);
    }

    // ── Admin ─────────────────────────────────────────────────────────────

    /**
     * @notice Transfer arbiter role to a new address.
     */
    function setArbiter(address newArbiter) external onlyArbiter {
        arbiter = newArbiter;
    }

    /**
     * @notice Set the reward source address (allowed to call reward()).
     */
    function setRewardSource(address newRewardSource) external onlyArbiter {
        rewardSource = newRewardSource;
    }

    // ── Views ─────────────────────────────────────────────────────────────

    /**
     * @notice Get all currently active verifier addresses.
     */
    function getActiveVerifiers() external view returns (address[] memory) {
        uint256 total = verifierList.length;
        uint256 activeCount = 0;

        // Count active verifiers first
        for (uint256 i = 0; i < total; i++) {
            if (verifiers[verifierList[i]].active) {
                activeCount++;
            }
        }

        address[] memory active = new address[](activeCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < total; i++) {
            if (verifiers[verifierList[i]].active) {
                active[idx++] = verifierList[i];
            }
        }

        return active;
    }

    /**
     * @notice Get the total number of registered verifiers (active + inactive).
     */
    function getVerifierCount() external view returns (uint256) {
        return verifierList.length;
    }

    /**
     * @notice Check if a verifier is currently active.
     */
    function isActive(address verifier) external view returns (bool) {
        return verifiers[verifier].active;
    }
}
