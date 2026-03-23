import { createPublicClient, http, formatEther } from "viem";
import { sepolia, baseSepolia } from "viem/chains";

async function main() {
  const sepoliaClient = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
  const escrowCode = await sepoliaClient.getCode({ address: "0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454" });
  const usdcCode = await sepoliaClient.getCode({ address: "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb" });
  console.log("Sepolia L1 MilestoneEscrow:", escrowCode && escrowCode !== "0x" ? `DEPLOYED (${escrowCode.length / 2} bytes)` : "NOT FOUND");
  console.log("Sepolia L1 MockUSDC:", usdcCode && usdcCode !== "0x" ? `DEPLOYED (${usdcCode.length / 2} bytes)` : "NOT FOUND");

  const baseClient = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const balance = await baseClient.getBalance({ address: "0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B" });
  console.log("Deployer Base Sepolia balance:", formatEther(balance), "ETH");
}
main();
