import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const E = "0x2d8a6217130ce49328077013c7c4d645e7506792" as `0x${string}`;
const U = "0x60AD7350b7b957A1B5bA8F2bafB62dDA62169b5e" as `0x${string}`;

const msAbi = [{ name: "milestones", type: "function" as const, inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "stepId", type: "bytes32" },{ name: "operator", type: "address" },{ name: "amount", type: "uint256" },{ name: "operatorBond", type: "uint256" },{ name: "status", type: "uint8" },{ name: "evidenceBundleHash", type: "bytes32" },{ name: "verifierAttestationHash", type: "bytes32" },{ name: "challengeWindowSeconds", type: "uint256" },{ name: "challengeWindowEnd", type: "uint256" }], stateMutability: "view" as const }] as const;
const balAbi = [{ name: "balanceOf", type: "function" as const, inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" as const }] as const;
const totalAbi = [{ name: "totalAmount", type: "function" as const, inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" as const }] as const;
const protocolAbi = [{ name: "protocolRoot", type: "function" as const, inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" as const }] as const;

async function main() {
  const m = await pub.readContract({ address: E, abi: msAbi, functionName: "milestones", args: [0n] });
  console.log("Milestone 0:");
  console.log("  operator:", m[1]);
  console.log("  amount (raw):", m[2].toString());
  console.log("  operatorBond (raw):", m[3].toString());
  console.log("  status:", m[4]);
  console.log("  challengeWindowEnd:", m[8].toString());
  console.log("  payout would be:", (m[2] + m[3]).toString());

  const bal = await pub.readContract({ address: U, abi: balAbi, functionName: "balanceOf", args: [E] });
  console.log("\nEscrow USDC balance (raw):", bal.toString());
  console.log("Enough?", bal >= (m[2] + m[3]));

  const total = await pub.readContract({ address: E, abi: totalAbi, functionName: "totalAmount" });
  console.log("totalAmount (raw):", total.toString());

  const root = await pub.readContract({ address: E, abi: protocolAbi, functionName: "protocolRoot" });
  console.log("protocolRoot:", root);
}
main();
