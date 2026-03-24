// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ChainlinkEvidenceVerifier
 * @notice Chainlink Functions consumer contract for PCC evidence verification.
 *
 * Sends evidence bundle hashes to Chainlink DON nodes for off-chain verification.
 * DON nodes run a JavaScript source that evaluates the evidence hash and required
 * tier, returning a uint256 score (0-100).
 *
 * Deploy to Base Sepolia, add this contract as consumer to your Chainlink
 * Functions subscription, then set CHAINLINK_CONSUMER_ADDRESS in .env.
 *
 * Setup:
 *   1. Deploy: npx tsx scripts/deploy-oracle-contracts.ts
 *   2. Create subscription at https://functions.chain.link/base-sepolia
 *   3. Fund with LINK and add this contract as consumer
 *   4. Set CHAINLINK_CONSUMER_ADDRESS and CHAINLINK_SUB_ID in .env
 */

/// @dev Minimal Chainlink Functions interfaces to avoid npm dependency in Foundry.

interface IFunctionsRouter {
    function sendRequest(
        uint64 subscriptionId,
        bytes calldata data,
        uint16 dataVersion,
        uint32 callbackGasLimit,
        bytes32 donId
    ) external returns (bytes32 requestId);
}

interface IFunctionsClient {
    function handleOracleFulfillment(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) external;
}

contract ChainlinkEvidenceVerifier is IFunctionsClient {
    // ── Events ────────────────────────────────────────────────────────────────

    event EvidenceRequestSent(
        bytes32 indexed requestId,
        bytes32 indexed bundleHash,
        uint8 requiredTier
    );

    event EvidenceResponseReceived(
        bytes32 indexed requestId,
        uint256 score,
        bool passed
    );

    event RequestFailed(
        bytes32 indexed requestId,
        bytes error
    );

    // ── State ─────────────────────────────────────────────────────────────────

    IFunctionsRouter public immutable router;
    bytes32 public immutable donId;
    uint64 public immutable subscriptionId;

    /// @dev Minimum passing score (0-100). Default: 60.
    uint256 public constant MIN_SCORE = 60;

    /// @dev Gas limit for the DON callback.
    uint32 public constant CALLBACK_GAS_LIMIT = 300_000;

    /// @dev Data version for Chainlink Functions requests.
    uint16 public constant DATA_VERSION = 1;

    /// @dev Owner (deployer) — can update JS source.
    address public owner;

    /// @dev JavaScript source executed by DON nodes.
    string public jsSource;

    /// @dev Response bytes keyed by requestId.
    mapping(bytes32 => bytes) public responses;

    /// @dev Error bytes keyed by requestId (non-empty = request failed).
    mapping(bytes32 => bytes) public requestErrors;

    /// @dev bundleHash keyed by requestId (for event correlation).
    mapping(bytes32 => bytes32) public requestToBundleHash;

    /// @dev Last fulfilled requestId (for simple polling).
    bytes32 public lastRequestId;

    /// @dev Last response bytes (for simple polling).
    bytes public lastResponse;

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param _router Chainlink Functions router address
     *                Base Sepolia: 0xf9B8fc078197181C841c296C876945aaa425B278
     * @param _donId  DON identifier (bytes32-encoded string)
     *                Base Sepolia: bytes32("fun-base-sepolia-1")
     * @param _subscriptionId Funded Chainlink Functions subscription ID
     * @param _jsSource JavaScript source code DON nodes will execute
     */
    constructor(
        address _router,
        bytes32 _donId,
        uint64 _subscriptionId,
        string memory _jsSource
    ) {
        router = IFunctionsRouter(_router);
        donId = _donId;
        subscriptionId = _subscriptionId;
        jsSource = _jsSource;
        owner = msg.sender;
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyRouter() {
        require(msg.sender == address(router), "Only router");
        _;
    }

    // ── External Functions ────────────────────────────────────────────────────

    /**
     * @notice Submit an evidence bundle for Chainlink DON verification.
     * @param bundleHash SHA-256 hash of the evidence bundle (bytes32).
     * @param requiredTier Minimum assurance tier required (0-3).
     * @return requestId Chainlink request ID for tracking.
     */
    function sendEvidenceRequest(
        bytes32 bundleHash,
        uint8 requiredTier
    ) external returns (bytes32 requestId) {
        // Encode args: [bundleHash (hex string), requiredTier (number string)]
        string[] memory args = new string[](2);
        args[0] = _bytes32ToHexString(bundleHash);
        args[1] = _uint8ToString(requiredTier);

        // Encode the Chainlink Functions request
        bytes memory encodedRequest = _encodeRequest(jsSource, args);

        requestId = router.sendRequest(
            subscriptionId,
            encodedRequest,
            DATA_VERSION,
            CALLBACK_GAS_LIMIT,
            donId
        );

        requestToBundleHash[requestId] = bundleHash;

        emit EvidenceRequestSent(requestId, bundleHash, requiredTier);
    }

    /**
     * @notice Called by the Chainlink router when DON fulfills the request.
     * @dev IFunctionsClient implementation.
     */
    function handleOracleFulfillment(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) external override onlyRouter {
        lastRequestId = requestId;

        if (err.length > 0) {
            requestErrors[requestId] = err;
            emit RequestFailed(requestId, err);
            return;
        }

        responses[requestId] = response;
        lastResponse = response;

        // Decode score (uint256, 0-100)
        uint256 score = response.length >= 32
            ? abi.decode(response, (uint256))
            : 0;
        bool passed = score >= MIN_SCORE;

        emit EvidenceResponseReceived(requestId, score, passed);
    }

    /**
     * @notice Update the JS source (owner only).
     */
    function updateJsSource(string calldata newSource) external onlyOwner {
        jsSource = newSource;
    }

    /**
     * @notice Get the last response bytes (for simple polling by TypeScript).
     */
    function getLastResponse() external view returns (bytes memory) {
        return lastResponse;
    }

    /**
     * @notice Get the last request ID (for simple polling by TypeScript).
     */
    function getLastRequestId() external view returns (bytes32) {
        return lastRequestId;
    }

    // ── Internal Helpers ──────────────────────────────────────────────────────

    /**
     * @dev Encode a Chainlink Functions request (inline JS + string args).
     * Format: abi.encode(location, language, source, args, bytesArgs, secrets)
     * where location=0 (inline), language=0 (JavaScript).
     */
    function _encodeRequest(
        string memory source,
        string[] memory args
    ) internal pure returns (bytes memory) {
        return abi.encode(
            uint8(0),   // Location.Inline
            uint8(0),   // CodeLanguage.JavaScript
            source,
            args,
            new bytes[](0),  // bytesArgs (none)
            bytes("")        // secrets (none)
        );
    }

    /// @dev Convert bytes32 to "0x..." hex string for DON args.
    function _bytes32ToHexString(bytes32 b) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory result = new bytes(66);
        result[0] = "0";
        result[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            result[2 + i * 2] = hexChars[uint8(b[i]) >> 4];
            result[3 + i * 2] = hexChars[uint8(b[i]) & 0x0f];
        }
        return string(result);
    }

    /// @dev Convert uint8 to decimal string for DON args.
    function _uint8ToString(uint8 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint8 tmp = v;
        uint8 digits;
        while (tmp != 0) { digits++; tmp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (v != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buffer);
    }
}
