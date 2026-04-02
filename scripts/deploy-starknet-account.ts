/**
 * Compute the correct Argent X account address with proper Signer enum calldata,
 * then deploy it once funded.
 *
 * Constructor: (owner: Signer, guardian: Option<Signer>)
 * Signer::Starknet = [0, pubkey]
 * Option::None = [1]
 * Full calldata = [0, pubkey, 1]
 */
import { Account, RpcProvider, ec, hash, CallData } from "starknet";

const privateKey = "0x27b3877bde7c77381fbfef2c4e107e06ea7ea13d1a2c14bde6618350f59e385";
const publicKey = ec.starkCurve.getStarkKey(privateKey);
const classHash = "0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f";

// Correct calldata: Signer::Starknet(pubkey), Option::None
const correctCalldata = ["0", publicKey, "1"];

const correctAddress = hash.calculateContractAddressFromHash(
  publicKey,  // salt
  classHash,
  correctCalldata,
  0,  // deployer = 0
);

console.log("Private Key:", privateKey);
console.log("Public Key: ", publicKey);
console.log("Class Hash: ", classHash);
console.log("Calldata:   ", correctCalldata);
console.log("");
console.log("Correct Address:", correctAddress);
console.log("");
console.log("Old (wrong) Address: 0x21d685eb490b3c29b2fe31d6b3b866535493ef8e1b930c37fd7df989522e97d");
console.log("900 STRK is stuck at the old address.");
console.log("");
console.log("Fund the CORRECT address above, then re-run with --deploy flag.");
console.log("Faucet: https://starknet-faucet.vercel.app/");

async function main() {
  if (!process.argv.includes("--deploy")) {
    console.log("\nRun with --deploy after funding to deploy the account.");
    return;
  }

  const provider = new RpcProvider({ nodeUrl: "https://api.cartridge.gg/x/starknet/sepolia" });

  // Check balance
  const strkToken = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
  try {
    const result = await provider.callContract({ contractAddress: strkToken, entrypoint: "balanceOf", calldata: [correctAddress] });
    const bal = Number(BigInt(result[0])) / 1e18;
    console.log(`\nSTRK balance: ${bal}`);
    if (bal === 0) {
      console.error("No STRK — fund the address first.");
      process.exit(1);
    }
  } catch (e: any) {
    console.warn("Balance check failed:", e.message?.slice(0, 80));
  }

  const account = new Account({ provider, address: correctAddress, signer: privateKey });
  console.log("Deploying...");

  const deployTx = await account.deployAccount({
    classHash,
    constructorCalldata: correctCalldata,
    addressSalt: publicKey,
  });

  console.log("TX:", deployTx.transaction_hash);
  console.log("https://sepolia.starkscan.co/tx/" + deployTx.transaction_hash);

  const receipt = await provider.waitForTransaction(deployTx.transaction_hash);
  console.log("Status:", (receipt as any).execution_status ?? (receipt as any).status);
  console.log("Account deployed:", correctAddress);
}

main().catch(e => { console.error("Failed:", e.message); process.exit(1); });
