/**
 * Deploy PCC ProofRegistry contract to Starknet Sepolia.
 *
 * Phase 1 (no account): Generates a fresh OZ account keypair, prints the
 *   pre-computed address, and exits so the user can fund it from the faucet.
 *
 * Phase 2 (account set): Declares the ProofRegistry class, deploys an instance
 *   via UDC, and prints the deployed contract address.
 *
 * Usage:
 *   # Phase 1 — generate account (run first)
 *   npx tsx scripts/deploy-starknet-sepolia.ts
 *
 *   # Fund the address from https://starknet-faucet.vercel.app
 *   # Then set env vars and run Phase 2:
 *   STARKNET_PRIVATE_KEY=0x... STARKNET_ACCOUNT=0x... npx tsx scripts/deploy-starknet-sepolia.ts
 *
 * Env vars:
 *   STARKNET_PRIVATE_KEY  — private key (0x-hex) for signing transactions
 *   STARKNET_ACCOUNT      — account contract address on Starknet Sepolia
 *   STARKNET_RPC_URL      — optional override (default: blastapi sepolia)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const DIVIDER = "═".repeat(70);
const SUB = "─".repeat(50);

// ── Starknet constants ────────────────────────────────────────────────────────

/** OpenZeppelin account class hash (Cairo 1, v0.10.x, declared on Sepolia) */
const OZ_ACCOUNT_CLASS_HASH =
  "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f";

/** Universal Deployer Contract (UDC) address on all Starknet networks */
const UDC_ADDRESS =
  "0x041a78e741e5af2fec34b695679bc6891742439f7afb8484ecd7766661ad02bf";

const DEFAULT_RPC =
  "https://api.cartridge.gg/x/starknet/sepolia";

// ── Artifact path ─────────────────────────────────────────────────────────────

const SIERRA_PATH = resolve(
  ROOT,
  "packages/contracts/cairo/proof_registry/target/dev/proof_registry_ProofRegistry.contract_class.json",
);
const CASM_PATH = resolve(
  ROOT,
  "packages/contracts/cairo/proof_registry/target/dev/proof_registry_ProofRegistry.compiled_contract_class.json",
);

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${DIVIDER}`);
  console.log("  PCC ProofRegistry — Starknet Sepolia Deployment");
  console.log(`${DIVIDER}\n`);

  // Resolve starknet from the verifier package (pnpm monorepo — not hoisted)
  const starknetPath = resolve(ROOT, "packages/verifier/node_modules/starknet/dist/index.mjs");
  const starknetUrl = "file:///" + starknetPath.replace(/\\/g, "/");
  const starknet = await import(starknetUrl);
  const { ec, hash, num, RpcProvider, Account, CallData, Contract, cairo, Signer } = starknet;

  const rpcUrl = process.env.STARKNET_RPC_URL ?? DEFAULT_RPC;
  const provider = new RpcProvider({ nodeUrl: rpcUrl });

  // ── Check network ──────────────────────────────────────────────────────────

  try {
    const chainId = await provider.getChainId();
    console.log(`Network:   ${chainId}`);
    console.log(`RPC:       ${rpcUrl}\n`);
  } catch (e) {
    console.error(`Error: Cannot reach Starknet node at ${rpcUrl}`);
    console.error(e);
    process.exit(1);
  }

  // ── Phase 1: Generate account if not provided ─────────────────────────────

  const envPrivKey = process.env.STARKNET_PRIVATE_KEY;
  const envAccount = process.env.STARKNET_ACCOUNT;

  if (!envPrivKey || !envAccount) {
    console.log("No account configured. Generating a fresh OZ account keypair...\n");

    const privKeyBytes = ec.starkCurve.utils.randomPrivateKey();
    const privateKey = "0x" + Buffer.from(privKeyBytes).toString("hex");
    const publicKey = ec.starkCurve.getStarkKey(privateKey);

    const constructorCallData = CallData.compile({ publicKey });
    const accountAddress = hash.calculateContractAddressFromHash(
      publicKey,
      OZ_ACCOUNT_CLASS_HASH,
      constructorCallData,
      0,
    );

    console.log(`${SUB}`);
    console.log("Generated keypair (SAVE THESE):");
    console.log(`${SUB}`);
    console.log(`  Private key:    ${privateKey}`);
    console.log(`  Public key:     ${publicKey}`);
    console.log(`  Account address: ${accountAddress}`);
    console.log(`${SUB}\n`);

    console.log("ACTION REQUIRED:");
    console.log("  1. Fund the account address from the Starknet Sepolia faucet:");
    console.log("     https://starknet-faucet.vercel.app");
    console.log(`     Address: ${accountAddress}`);
    console.log("");
    console.log("  2. After funding, re-run with:");
    console.log(`     STARKNET_PRIVATE_KEY=${privateKey} \\`);
    console.log(`     STARKNET_ACCOUNT=${accountAddress} \\`);
    console.log("     npx tsx scripts/deploy-starknet-sepolia.ts");
    console.log("");
    console.log("  Note: The account contract also needs to be deployed (deployed by OZ UDC");
    console.log("        the first time you use it — starknet.js handles this automatically).\n");

    // Save to a local keyfile for convenience (never commit this)
    const keyfilePath = resolve(ROOT, ".starknet-key.json");
    writeFileSync(keyfilePath, JSON.stringify({ privateKey, publicKey, accountAddress }, null, 2));
    console.log(`  Keypair saved to: .starknet-key.json (DO NOT COMMIT)\n`);

    process.exit(0);
  }

  // ── Phase 2: Deploy with existing account ─────────────────────────────────

  const privateKey = envPrivKey;
  const accountAddress = envAccount;

  console.log(`Account:   ${accountAddress}`);

  // Check account balance
  let account: InstanceType<typeof Account>;
  try {
    // starknet.js v9: options object with Signer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signer = new (Signer as any)(privateKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    account = new (Account as any)({ provider, address: accountAddress, signer });
  } catch (e) {
    console.error("Error constructing account:", e);
    process.exit(1);
  }

  // Check if artifacts exist
  if (!existsSync(SIERRA_PATH)) {
    console.error(`Error: Sierra artifact not found at ${SIERRA_PATH}`);
    console.error("Run: cd packages/contracts/cairo/proof_registry && scarb build");
    process.exit(1);
  }

  const sierraContract = JSON.parse(readFileSync(SIERRA_PATH, "utf8"));
  const casmContract = JSON.parse(readFileSync(CASM_PATH, "utf8"));

  // ── Declare the contract class ─────────────────────────────────────────────

  console.log(`\n${SUB}`);
  console.log("Step 1: Declaring ProofRegistry class...");
  console.log(`${SUB}`);

  let classHash: string;

  try {
    // Check if already declared
    const computedClassHash = hash.computeContractClassHash(sierraContract);
    console.log(`  Computed class hash: ${computedClassHash}`);

    try {
      await provider.getClassByHash(computedClassHash);
      console.log("  Already declared on-chain. Skipping declaration.");
      classHash = computedClassHash;
    } catch {
      // Not declared — declare it now
      console.log("  Not yet declared. Declaring...");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const declareResponse = await (account as any).declare({
        contract: sierraContract,
        casm: casmContract,
      });

      console.log(`  Declare TX: ${declareResponse.transaction_hash}`);
      console.log("  Waiting for declaration to be accepted...");

      await provider.waitForTransaction(declareResponse.transaction_hash);
      classHash = declareResponse.class_hash;
      console.log(`  Class declared! Hash: ${classHash}`);
    }
  } catch (e) {
    console.error("Error declaring contract:", e);
    console.error("\nPossible causes:");
    console.error("  - Account not funded (fund at https://starknet-faucet.vercel.app)");
    console.error("  - Account not deployed (use starknet.js deploy account first)");
    process.exit(1);
  }

  // ── Deploy the contract instance ──────────────────────────────────────────

  console.log(`\n${SUB}`);
  console.log("Step 2: Deploying ProofRegistry instance...");
  console.log(`${SUB}`);

  // ProofRegistry has no constructor arguments
  const constructorCalldata = CallData.compile({});

  // Generate a unique salt from the deployer address + timestamp
  const salt = num.toHex(
    BigInt(accountAddress) ^ BigInt(Math.floor(Date.now() / 1000)),
  );

  let deployedAddress: string;
  let deployTxHash: string;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deployResponse = await (account as any).deployContract({
      classHash,
      salt,
      unique: true,
      constructorCalldata,
    });

    deployTxHash = deployResponse.transaction_hash;
    console.log(`  Deploy TX: ${deployTxHash}`);
    console.log("  Waiting for deployment to be accepted...");

    const receipt = await provider.waitForTransaction(deployTxHash);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deployedAddress = (receipt as any).contract_address ?? hash.calculateContractAddressFromHash(
      salt,
      classHash,
      constructorCalldata,
      accountAddress,
    );

    // If receipt doesn't have contract_address, compute it
    if (!deployedAddress || deployedAddress === "undefined") {
      deployedAddress = hash.calculateContractAddressFromHash(
        salt,
        classHash,
        constructorCalldata,
        accountAddress,
      );
    }

    console.log(`  Deployed at: ${deployedAddress}`);
  } catch (e) {
    console.error("Error deploying contract:", e);
    process.exit(1);
  }

  // ── Smoke test: call anchor_proof ─────────────────────────────────────────

  console.log(`\n${SUB}`);
  console.log("Step 3: Smoke test — calling anchor_proof...");
  console.log(`${SUB}`);

  try {
    const testHash = "0x" + "deadbeef".padEnd(62, "0");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callResponse = await (account as any).execute([
      {
        contractAddress: deployedAddress,
        entrypoint: "anchor_proof",
        calldata: [testHash],
      },
    ]);

    console.log(`  anchor_proof TX: ${callResponse.transaction_hash}`);
    await provider.waitForTransaction(callResponse.transaction_hash);
    console.log("  Smoke test passed — proof anchored successfully!");

    // Verify it was stored
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proofResult = await provider.callContract({
      contractAddress: deployedAddress,
      entrypoint: "get_proof",
      calldata: [testHash],
    });
    console.log(`  get_proof result: ${JSON.stringify(proofResult)}`);
    const anchored = proofResult[0] !== "0x0";
    console.log(`  Anchored: ${anchored}`);
  } catch (e) {
    console.warn("Warning: Smoke test failed (contract is deployed but call failed):", e);
  }

  // ── Update starknet-proof-service.ts ─────────────────────────────────────

  console.log(`\n${SUB}`);
  console.log("Step 4: Updating starknet-proof-service.ts...");
  console.log(`${SUB}`);

  const servicePath = resolve(
    ROOT,
    "packages/verifier/src/starknet-proof-service.ts",
  );
  let serviceContent = readFileSync(servicePath, "utf8");

  // Replace the placeholder address
  const oldAddress = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
  const newAddressLine = `  /**\n   * PCC ProofRegistry deployed on Starknet Sepolia.\n   * Deploy TX: ${deployTxHash}\n   * Class hash: ${classHash}\n   * Deployed: ${new Date().toISOString()}\n   */\n  private static readonly PROOF_REGISTRY_ADDRESS =\n    "${deployedAddress}";`;

  if (serviceContent.includes(oldAddress)) {
    serviceContent = serviceContent.replace(
      /\/\*\*[\s\S]*?PROOF_REGISTRY_ADDRESS =\s*"0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";/,
      newAddressLine,
    );
    writeFileSync(servicePath, serviceContent);
    console.log(`  Updated: packages/verifier/src/starknet-proof-service.ts`);
  } else {
    console.log("  Note: Old placeholder address not found — already updated or file changed.");
    console.log(`  Manually set PROOF_REGISTRY_ADDRESS to: ${deployedAddress}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${DIVIDER}`);
  console.log("  Deployment Complete!");
  console.log(`${DIVIDER}`);
  console.log(`  Network:         Starknet Sepolia`);
  console.log(`  Contract:        ProofRegistry`);
  console.log(`  Address:         ${deployedAddress}`);
  console.log(`  Class hash:      ${classHash}`);
  console.log(`  Deploy TX:       ${deployTxHash}`);
  console.log(`  Explorer:        https://sepolia.starkscan.co/contract/${deployedAddress}`);
  console.log(`${DIVIDER}\n`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
