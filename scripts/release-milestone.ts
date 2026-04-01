import { createWalletClient, createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const pk = process.env.PCC_GATEWAY_PRIVATE_KEY as `0x${string}`;
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http("https://sepolia.base.org") });
const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

const ESCROW = "0x2d8a6217130ce49328077013c7c4d645e7506792" as `0x${string}`;
const USDC = "0x60AD7350b7b957A1B5bA8F2bafB62dDA62169b5e" as `0x${string}`;

const releaseAbi = [{ name: "release", type: "function" as const, inputs: [{ name: "milestoneIndex", type: "uint256" }], outputs: [], stateMutability: "nonpayable" as const }] as const;
const balAbi = [{ name: "balanceOf", type: "function" as const, inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" as const }] as const;
const stateAbi = [{ name: "milestones", type: "function" as const, inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "stepId", type: "bytes32" },{ name: "operator", type: "address" },{ name: "amount", type: "uint256" },{ name: "operatorBond", type: "uint256" },{ name: "status", type: "uint8" },{ name: "evidenceBundleHash", type: "bytes32" },{ name: "verifierAttestationHash", type: "bytes32" },{ name: "challengeWindowSeconds", type: "uint256" },{ name: "challengeWindowEnd", type: "uint256" }], stateMutability: "view" as const }] as const;

async function main() {
  const m = await pub.readContract({ address: ESCROW, abi: stateAbi, functionName: "milestones", args: [0n] });
  console.log("Milestone status:", m[4], "(4=Attested, 5=Released)");
  console.log("Challenge window end:", m[8].toString());

  const block = await pub.getBlock();
  console.log("Current block.timestamp:", block.timestamp.toString());
  console.log("Window passed:", block.timestamp >= m[8]);

  const balBefore = await pub.readContract({ address: USDC, abi: balAbi, functionName: "balanceOf", args: [account.address] });
  console.log("USDC before:", formatUnits(balBefore, 6));

  console.log("\nReleasing milestone 0...");
  const tx = await wallet.writeContract({ address: ESCROW, abi: releaseAbi, functionName: "release", args: [0n] });
  console.log("TX:", tx);
  const receipt = await pub.waitForTransactionReceipt({ hash: tx });
  console.log("Block:", receipt.blockNumber, "Status:", receipt.status);

  const balAfter = await pub.readContract({ address: USDC, abi: balAbi, functionName: "balanceOf", args: [account.address] });
  console.log("USDC after:", formatUnits(balAfter, 6));
  console.log("\nSETTLED. USDC released to operator.");
}

main().catch(e => console.log("ERR:", e.shortMessage || e.message));
