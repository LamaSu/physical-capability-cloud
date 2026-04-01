import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const USDC = "0x60AD7350b7b957A1B5bA8F2bafB62dDA62169b5e" as `0x${string}`;
const ESCROW = "0x2d8a6217130ce49328077013c7c4d645e7506792" as `0x${string}`;
const abi = [{ name: "balanceOf", type: "function" as const, inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" as const }] as const;
async function main() {
  const b = await pub.readContract({ address: USDC, abi, functionName: "balanceOf", args: [ESCROW] });
  console.log("Escrow USDC balance:", formatUnits(b, 6));
  console.log("Raw:", b.toString());
}
main();
