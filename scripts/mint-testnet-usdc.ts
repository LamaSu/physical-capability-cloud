import { createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const pk = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
if (!pk) { console.error("Set DEPLOYER_PRIVATE_KEY"); process.exit(1); }

const account = privateKeyToAccount(pk);
const client = createWalletClient({ account, chain: baseSepolia, transport: http() });

const USDC = "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb" as const;
const targets = [
  { name: "Spark Wallet", address: "0xdD564b558f2d34E4a09bDbe0662b2D18C257CfEF" as const },
  { name: "Deployer", address: "0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B" as const },
];

const abi = [{ name: "mint", type: "function" as const, inputs: [{ name: "to", type: "address" as const }, { name: "amount", type: "uint256" as const }], outputs: [], stateMutability: "nonpayable" as const }];

async function main() {
  console.log("Deployer:", account.address);
  for (const t of targets) {
    try {
      const tx = await client.writeContract({ address: USDC, abi, functionName: "mint", args: [t.address, parseUnits("10000", 6)] });
      console.log(`Minted 10,000 USDC to ${t.name} (${t.address}): ${tx}`);
    } catch (e: any) {
      console.error(`Failed to mint to ${t.name}: ${e.message}`);
    }
  }
}
main();
