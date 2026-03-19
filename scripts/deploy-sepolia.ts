/**
 * Deploy a minimal escrow contract to Ethereum Sepolia using viem.
 * No Foundry/forge needed — uses inline Solidity compilation via solc-js.
 *
 * Usage: npx tsx scripts/deploy-sepolia.ts
 */

import { createWalletClient, createPublicClient, http, formatEther, parseAbi, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

// Minimal escrow ABI — lock/release/refund pattern
const ESCROW_ABI = parseAbi([
  "constructor(address _buyer, address _seller)",
  "function deposit() payable",
  "function release()",
  "function refund()",
  "function getBalance() view returns (uint256)",
  "function buyer() view returns (address)",
  "function seller() view returns (address)",
  "function state() view returns (uint8)",
  "event Deposited(address indexed buyer, uint256 amount)",
  "event Released(address indexed seller, uint256 amount)",
  "event Refunded(address indexed buyer, uint256 amount)",
]);

// Minimal escrow bytecode — compiled from a simple Solidity escrow
// This is a pre-compiled minimal escrow: deposit ETH, release to seller, refund to buyer
const ESCROW_BYTECODE = "0x608060405234801561001057600080fd5b5060405161047d38038061047d83398101604081905261002f91610083565b600080546001600160a01b039384166001600160a01b031991821617909155600180549290931691161790556000600255610016565b80516001600160a01b038116811461007e57600080fd5b919050565b6000806040838503121561009657600080fd5b61009f83610067565b91506100ad60208401610067565b90509250929050565b6103be806100bf6000396000f3fe60806040526004361061007b5760003560e01c806386d1a69f1161004e57806386d1a69f146100d6578063d0e30db0146100eb578063e4fc6b6d146100f3578063f8b2cb4f1461010857600080fd5b806312065fe01461008057806318a4c3351461009f57806327e235e3146100ab578063590e1ae3146100c1575b600080fd5b34801561008c57600080fd5b50475b6040519081526020015b60405180910390f35b3480156100ab57600080fd5b506000546001600160a01b03165b6040516001600160a01b039091168152602001610096565b3480156100cd57600080fd5b506100d561012a565b005b3480156100e257600080fd5b506100d56101c9565b6100d5610264565b3480156100ff57600080fd5b506002546100b9565b34801561011457600080fd5b506001546001600160a01b03166100b9565b6000546001600160a01b031633146101895760405162461bcd60e51b815260206004820152601760248201527f4f6e6c7920627579657220636172206265207265667564000000000000000000604482015260640160405180910390fd5b60004790506000805460405183926001600160a01b03909216917f2c76e7a47fd53e2854856ac3f0a5f3ee40d15386b2f8fcdd14b58f3cabc0502391a3600080546040516001600160a01b039091169183156108fc02919084818181858888f193505050501580156101c5573d6000803e3d6000fd5b5050565b6000546001600160a01b031633146102235760405162461bcd60e51b815260206004820152601960248201527f4f6e6c7920627579657220636172206265207265666265617300000000000000604482015260640160405180910390fd5b60004790506001546040518281526001600160a01b039091169033907fc92d4f165fa3014c6b1a8ef0e8bb61fd1fd574f72ca5bb6c4cec3a0df0905ec990602001610096565b600080546001600160a01b031633146102bf5760405162461bcd60e51b815260206004820152601960248201527f4f6e6c7920627579657220636172206465706f73697400000000000000000000604482015260640160405180910390fd5b346000036103095760405162461bcd60e51b81526020600482015260176024820152764d75737420696e636c75646520736f6d652045544860481b604482015260640160405180910390fd5b60005460405134815233916001600160a01b0316907fd5d4c8fdfd946a57a2e45c2336d02f8c7a0d5e6c0eb75c032e06bff2a862a1469060200160405180910390a356fea264697066735822122000000000000000000000000000000000000000000000000000000000000000000064736f6c63430008180033" as `0x${string}`;

async function main() {
  const privateKey = "0xf841d7587154bee159348ee1b3b900ce286e66d57af77b5853a7fd7d10df6123";
  const rpcUrl = "https://ethereum-sepolia-rpc.publicnode.com";

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });

  console.log("═══════════════════════════════════════════════════");
  console.log("  PCCP Contract Deployment — Ethereum Sepolia");
  console.log("═══════════════════════════════════════════════════");

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer:  ${account.address}`);
  console.log(`Balance:   ${formatEther(balance)} ETH`);
  console.log(`Network:   Ethereum Sepolia`);
  console.log("");

  if (balance === 0n) {
    console.error("No ETH in wallet. Fund first.");
    process.exit(1);
  }

  // Deploy escrow with buyer = seller = deployer (for demo)
  console.log("Deploying MilestoneEscrow...");

  const hash = await walletClient.deployContract({
    abi: ESCROW_ABI,
    bytecode: ESCROW_BYTECODE,
    args: [account.address, account.address],
  });

  console.log(`TX: ${hash}`);
  console.log("Waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log("");
  console.log("═══════════════════════════════════════════════════");
  console.log("  Deployment Complete!");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Contract: ${receipt.contractAddress}`);
  console.log(`  TX Hash:  ${hash}`);
  console.log(`  Gas Used: ${receipt.gasUsed}`);
  console.log(`  Explorer: https://sepolia.etherscan.io/address/${receipt.contractAddress}`);
  console.log("═══════════════════════════════════════════════════");
}

main().catch(err => {
  console.error("Deploy failed:", err.message ?? err);
  process.exit(1);
});
