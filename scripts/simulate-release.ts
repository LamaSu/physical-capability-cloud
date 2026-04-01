import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const pk = process.env.PCC_GATEWAY_PRIVATE_KEY as `0x${string}`;
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

const ESCROW = "0x2d8a6217130ce49328077013c7c4d645e7506792" as `0x${string}`;
const abi = [{ name: "release", type: "function" as const, inputs: [{ name: "milestoneIndex", type: "uint256" }], outputs: [], stateMutability: "nonpayable" as const }] as const;

async function main() {
  try {
    await pub.simulateContract({
      address: ESCROW,
      abi,
      functionName: "release",
      args: [0n],
      account: account.address,
    });
    console.log("Simulation PASSED — release would succeed");
  } catch (e: any) {
    console.log("Simulation FAILED:", e.shortMessage || e.message);
    if (e.cause?.data) console.log("Revert data:", e.cause.data);
  }
}
main();
