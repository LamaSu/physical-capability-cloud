# First Real E2E Demo — Runbook

From "scripts that simulate" to "agents that actually settle on-chain."

## Prerequisites (you need these accounts/wallets)

- [ ] MetaMask or any EVM wallet (for Base Sepolia)
- [ ] Phantom or any Solana wallet (for devnet)
- [ ] GitHub account (you have this)

---

## Step 1: Get Testnet Tokens (30 min)

### Base Sepolia ETH
- Go to: https://www.alchemy.com/faucets/base-sepolia
- Paste your EVM address (from UnifiedKeychain or MetaMask)
- Get 0.1 Base Sepolia ETH (enough for hundreds of transactions)

### Base Sepolia USDC
- Go to: https://faucet.circle.com/
- Select "Base Sepolia" + "USDC"
- Paste same EVM address
- Get 10 USDC (enough for demo escrows)

### Solana Devnet SOL
- Run: `solana airdrop 2 YOUR_SOLANA_ADDRESS --url devnet`
- Or go to: https://faucet.solana.com/
- Get 2 SOL devnet (enough for NFT mints + pool creation)

**Checkpoint**: You should have:
- 0.1 Base Sepolia ETH
- 10 USDC on Base Sepolia
- 2 SOL on Solana devnet

---

## Step 2: Deploy MilestoneEscrow to Base Sepolia (1 hour)

The contract and deploy script already exist.

```bash
cd C:\Users\globa\physical-capability-cloud

# Set your deployer private key (the EVM key from UnifiedKeychain)
export DEPLOYER_PRIVATE_KEY=0x...your_key...

# Deploy
cd packages/contracts
forge script script/DeployLocal.s.sol:DeployLocalScript \
  --rpc-url https://sepolia.base.org \
  --broadcast -vvvv
```

If forge isn't set up for Base Sepolia, use the TypeScript deployer:
```bash
npx tsx scripts/deploy-base-sepolia.ts
```

**Checkpoint**: Note the deployed contract address. Update `packages/contracts/ts/chain-config.ts` with the real address.

---

## Step 3: Wire Gateway to Real Chain (half day)

Currently gateway routes return mock data. Need to:

1. Set env vars on the gateway:
```bash
export PCC_NETWORK=base-sepolia
export ESCROW_CONTRACT_ADDRESS=0x...deployed_address...
export DEPLOYER_PRIVATE_KEY=0x...
```

2. The chain-client.ts already has readEscrow(), fundEscrow(), releaseMilestone() — they just need the real contract address.

3. Update gateway routes to call chain-client instead of returning mock data for:
   - `/api/escrow` — read from on-chain
   - `/api/escrow/:id` — read specific escrow
   - `/api/jobs` — track jobs in SQLite, milestones on-chain

**Checkpoint**: `curl https://pcc-gateway-production.up.railway.app/api/escrow` returns real on-chain data.

---

## Step 4: Switch to Real Lit Encryption (2 hours)

The `RealLitEncryptionService` in `packages/kernel/src/lit-encryption-real.ts` is already written.

1. In the gateway or demo script, swap:
```typescript
// Before
import { EncryptionService } from "@pcc/kernel";
// After
import { RealLitEncryptionService as EncryptionService } from "@pcc/kernel";
```

2. Set env var:
```bash
export LIT_PROTOCOL_REAL=true
```

3. The service connects to `datil-test` (free testnet). No capacity credits needed.

**Checkpoint**: Evidence bundles are encrypted by real Lit nodes (threshold crypto, not just local AES).

---

## Step 5: Networked Agents (being built now)

The NetworkedBus (WebSocket + REST relay) is being built. Once done:

1. Start the gateway with relay enabled:
```bash
pnpm dev  # Gateway starts on :3200 with WebSocket relay at /ws/a2a
```

2. Start each agent as a separate process:
```bash
# Terminal 1: UserAgent
npx tsx scripts/run-agent.ts --role user --relay http://localhost:3200

# Terminal 2: BrokerAgent
npx tsx scripts/run-agent.ts --role broker --relay http://localhost:3200

# Terminal 3: KernelAgent (BioLab)
npx tsx scripts/run-agent.ts --role kernel --id kernel_lab_sf --relay http://localhost:3200
```

3. Send a request from UserAgent:
```bash
curl -X POST http://localhost:3200/api/a2a/send -H 'Content-Type: application/json' -d '{
  "from": "user_agent_1",
  "to": "broker_agent_1",
  "intent": { "type": "discover_capabilities", "capabilityType": "hplc" },
  "conversationId": "conv_demo_001"
}'
```

**Checkpoint**: Agents in separate terminals exchange real messages through the gateway relay.

---

## Step 6: Fund Wallets + Run Real E2E (30 min)

With everything wired:

1. Fund the demo wallets (the UnifiedKeychain-derived addresses) with testnet USDC
2. Run the investor demo but pointing at real chain:
```bash
export PCC_REAL_CHAIN=true
npx tsx scripts/investor-demo.ts
```

3. Watch: real escrow locks on Base Sepolia, real USDC moves, real Lit encryption, real IPFS CIDs

**Checkpoint**: Etherscan shows the MilestoneEscrow transactions. IPFS gateway shows the evidence CIDs. Lit explorer shows the access conditions.

---

## What's NOT Real Yet (and that's OK for demo)

- Bittensor/POA verification runs locally (mock miners) — real subnet comes later
- Solana NFTs are mock — devnet deployment is a follow-up
- DLMM pools are mock — real Meteora pools need seed capital
- Machine adapters are mock — real OPC-UA/SiLA comes with first operator
- Agent "intelligence" is scripted — real LLM reasoning comes with Gatecraft proxy

The demo proves: **the settlement pipeline works end-to-end on real chains with real crypto.** That's what matters for investors.
