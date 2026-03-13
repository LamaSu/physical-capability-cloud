/**
 * Generate a fresh wallet for Base Sepolia contract deployment.
 *
 * Usage: npx tsx scripts/generate-wallet.ts
 *
 * After generating, fund the wallet with Base Sepolia ETH:
 *   https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet
 *
 * Then deploy:
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-base-sepolia.ts
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log("═".repeat(60));
console.log("  PCC Deployer Wallet Generated");
console.log("═".repeat(60));
console.log("");
console.log(`  Address:     ${account.address}`);
console.log(`  Private Key: ${privateKey}`);
console.log("");
console.log("  ⚠  SAVE THE PRIVATE KEY — it cannot be recovered!");
console.log("");
console.log("  Next steps:");
console.log("    1. Fund with Base Sepolia ETH:");
console.log("       https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet");
console.log("");
console.log("    2. Deploy contracts:");
console.log(`       DEPLOYER_PRIVATE_KEY=${privateKey} npx tsx scripts/deploy-base-sepolia.ts`);
console.log("");
console.log("═".repeat(60));
