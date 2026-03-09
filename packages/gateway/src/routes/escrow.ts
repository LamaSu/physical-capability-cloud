import type { FastifyInstance } from "fastify";
import { type Address, isAddress } from "viem";
import { readEscrow, getEscrowEvents, readTokenBalance, readTokenAllowance } from "../chain-client.js";

// ---------------------------------------------------------------------------
// Mock data (used when no on-chain address is provided)
// ---------------------------------------------------------------------------

const mockMilestones = [
  {
    stepId: "step_fdm_print_01",
    operator: "0x1234567890abcdef1234567890abcdef12345678",
    amount: "50.00",
    operatorBond: "5.00",
    status: 5,
    statusName: "Released",
    evidenceBundleHash: "0xabc123...",
    verifierAttestationHash: "0xdef456...",
    challengeWindowEnd: 1741000000,
    challengeWindowSeconds: 3600,
  },
  {
    stepId: "step_fdm_print_02",
    operator: "0x1234567890abcdef1234567890abcdef12345678",
    amount: "27.00",
    operatorBond: "2.70",
    status: 4,
    statusName: "Attested",
    evidenceBundleHash: "0x789abc...",
    verifierAttestationHash: "0x012def...",
    challengeWindowEnd: Math.floor(Date.now() / 1000) + 3600,
    challengeWindowSeconds: 3600,
  },
];

const mockEscrows = [
  {
    id: "esc-001",
    cwmId: "cwm-001",
    totalAmount: "77.00",
    currency: "USDC",
    status: "active",
    milestoneCount: 2,
    milestones: mockMilestones,
    payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    arbiter: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    funded: true,
  },
  {
    id: "esc-002",
    cwmId: "cwm-002",
    totalAmount: "245.00",
    currency: "USDC",
    status: "active",
    milestoneCount: 1,
    milestones: [mockMilestones[0]],
    payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    arbiter: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    funded: true,
  },
  {
    id: "esc-003",
    cwmId: "cwm-003",
    totalAmount: "18.50",
    currency: "USDC",
    status: "funded",
    milestoneCount: 1,
    milestones: [],
    payer: "0xcccccccccccccccccccccccccccccccccccccccc",
    arbiter: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    funded: true,
  },
];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function escrowRoutes(app: FastifyInstance) {
  // List escrows (mock only — on-chain escrows are tracked by address)
  app.get("/api/escrow", async () => {
    return { escrows: mockEscrows };
  });

  // Get escrow by ID (mock) or by on-chain address
  app.get<{ Params: { escrowId: string } }>("/api/escrow/:escrowId", async (req, reply) => {
    const { escrowId } = req.params;

    // If it looks like an Ethereum address, read from chain
    if (isAddress(escrowId)) {
      try {
        const escrow = await readEscrow(escrowId as Address);
        return { escrow, source: "on-chain" };
      } catch (err) {
        return reply.status(502).send({
          error: "on_chain_read_failed",
          message: err instanceof Error ? err.message : "Failed to read escrow from chain",
        });
      }
    }

    // Otherwise use mock data
    const escrow = mockEscrows.find((e) => e.id === escrowId);
    if (!escrow) return reply.status(404).send({ error: "not_found" });
    return { escrow, source: "mock" };
  });

  // Get on-chain events for an escrow contract
  app.get<{ Params: { address: string }; Querystring: { fromBlock?: string } }>(
    "/api/escrow/chain/:address/events",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }

      try {
        const fromBlock = req.query.fromBlock ? BigInt(req.query.fromBlock) : undefined;
        const events = await getEscrowEvents(address as Address, fromBlock);
        return { events };
      } catch (err) {
        return reply.status(502).send({
          error: "event_read_failed",
          message: err instanceof Error ? err.message : "Failed to read events",
        });
      }
    },
  );

  // Read token balance for an account
  app.get<{ Params: { tokenAddress: string; account: string } }>(
    "/api/escrow/chain/token/:tokenAddress/balance/:account",
    async (req, reply) => {
      const { tokenAddress, account } = req.params;
      if (!isAddress(tokenAddress) || !isAddress(account)) {
        return reply.status(400).send({ error: "Invalid address" });
      }

      try {
        const balance = await readTokenBalance(tokenAddress as Address, account as Address);
        return { balance, token: tokenAddress, account };
      } catch (err) {
        return reply.status(502).send({
          error: "balance_read_failed",
          message: err instanceof Error ? err.message : "Failed to read balance",
        });
      }
    },
  );

  // Read token allowance
  app.get<{ Params: { tokenAddress: string; owner: string; spender: string } }>(
    "/api/escrow/chain/token/:tokenAddress/allowance/:owner/:spender",
    async (req, reply) => {
      const { tokenAddress, owner, spender } = req.params;
      if (!isAddress(tokenAddress) || !isAddress(owner) || !isAddress(spender)) {
        return reply.status(400).send({ error: "Invalid address" });
      }

      try {
        const allowance = await readTokenAllowance(
          tokenAddress as Address,
          owner as Address,
          spender as Address,
        );
        return { allowance, token: tokenAddress, owner, spender };
      } catch (err) {
        return reply.status(502).send({
          error: "allowance_read_failed",
          message: err instanceof Error ? err.message : "Failed to read allowance",
        });
      }
    },
  );
}
