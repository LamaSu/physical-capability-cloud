# PCCP Execution Calendar — Next 2 Weeks

## Week 1: Chain + Agents (March 17-23)

### Monday Mar 17
- [ ] **Morning**: Get testnet tokens (Base Sepolia ETH + USDC + Solana devnet SOL)
- [ ] **Afternoon**: Deploy MilestoneEscrow.sol to Base Sepolia
- [ ] **Evening**: Verify contract on Etherscan, update chain-config.ts

### Tuesday Mar 18
- [ ] **Morning**: Wire gateway escrow routes to real chain-client (read/write)
- [ ] **Afternoon**: Test: `curl /api/escrow` returns real on-chain data
- [ ] **Evening**: Integrate NetworkedBus into gateway (relay routes)

### Wednesday Mar 19
- [ ] **Morning**: Build agent runner scripts (run-agent.ts for each role)
- [ ] **Afternoon**: Test 3 agents in separate terminals talking through relay
- [ ] **Evening**: Switch to RealLitEncryptionService (datil-test)

### Thursday Mar 20
- [ ] **All day**: End-to-end integration testing
- [ ] Wire: UserAgent → discover → bid → lock escrow (real USDC) → evidence → encrypt (real Lit) → IPFS → settle
- [ ] Fix whatever breaks

### Friday Mar 21
- [ ] **Morning**: Polish the demo flow — make it reliable and repeatable
- [ ] **Afternoon**: Record the real e2e demo (screen + voiceover)
- [ ] **Evening**: Push updates to Railway, update live site

## Week 2: Polish + Outreach (March 24-30)

### Monday Mar 24
- [ ] Deploy PCC NFTs to Solana devnet (capability certificates)
- [ ] Create real Meteora DLMM pool with seed liquidity (if worth it for demo)

### Tuesday Mar 25
- [ ] Write the pitch deck final version (Gamma or manual)
- [ ] Record polished 3-min investor video

### Wednesday Mar 26
- [ ] Apply: DePIN Base Camp (Outlier Ventures)
- [ ] Apply: Solana Foundation grants
- [ ] Apply: NSF SBIR Phase I

### Thursday Mar 27
- [ ] Outreach: Contact POA/Provenonce team about integration partnership
- [ ] Outreach: Contact Arkhai team about hackathon challenge
- [ ] Outreach: 3 potential operator partners (fab labs, CROs)

### Friday Mar 28
- [ ] Write ITAR compliance memo (engage counsel if possible)
- [ ] Draft operator onboarding guide (how to connect your machine)
- [ ] Weekly review: what worked, what didn't, adjust plan

## Daily Habits
- **9:00 AM**: Check Claude Code cron reminders
- **12:00 PM**: Midday progress check — are you on track for today's goals?
- **6:00 PM**: End of day — commit and push whatever is done
- **Before bed**: Update docs/EXECUTION_CALENDAR.md with what actually happened
