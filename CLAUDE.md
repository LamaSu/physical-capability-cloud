# Physical Capability Cloud (PCC) — Agent Integration Guide

PCC is AWS for the physical world — a cloud control plane for physical manufacturing capabilities.

- **Shop Kernels** = Availability Zones. Each kernel is a physical site (lab, workshop, factory) with equipment.
- **Capabilities** = billable units. Not machines — what machines can DO (3D printing, CNC milling, HPLC analysis).
- **Assurance Tiers** = SLAs. Evidence depth + liability + dispute rules, graded 0-3.
- **Settlement** = milestone escrow on-chain (Base Sepolia). Funds release only when evidence meets tier requirements.
- **Agents** = first-class citizens. Every operation is an API call. Human dashboards and AI agents use the same endpoints.

**Live gateway**: https://capability.network
**Agent package** (219 tools, JSON): https://capability.network/agent-package.json
**Full reference**: [docs/AGENT_INTEGRATION.md](./docs/AGENT_INTEGRATION.md)

---

## Quick Start

### 1. Provision an API key

```bash
curl -X POST https://capability.network/api/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"email": "operator@example.com", "name": "My Workshop", "capability": "FDM 3D printing"}'
```

Save the `api_key` from the response. You can also provision with a wallet address: `{"walletAddress": "0x...", "name": "..."}`. With an invite code, use `POST /api/onboard/redeem` to provision key + wallet + identity + LLM proxy in one call.

### 2. Authenticate every request

Set `Authorization: Bearer <key>` on every request. Without it, all endpoints return 401.

### 3. Discover capabilities

```bash
curl -H "Authorization: Bearer $PCC_KEY" https://capability.network/api/capabilities/types
# → {"types": ["3d-printing", "cnc", "laser-cutting", "hplc", "pcb", ...]}
```

### 4. Build a contract (discovery → escrow)

```bash
curl -X POST https://capability.network/api/build/options  -H "Authorization: Bearer $PCC_KEY" -d '{"type":"3d-printing"}'
curl -X POST https://capability.network/api/build/price    -H "Authorization: Bearer $PCC_KEY" -d '{"type":"3d-printing","selections":{"material":"PLA","infill":20}}'
curl -X POST https://capability.network/api/build/contract -H "Authorization: Bearer $PCC_KEY" -d '{"type":"3d-printing","selections":{"material":"PLA","infill":20},"assuranceTier":1}'
```

### 5. Submit & monitor

Fund the escrow, submit the job, then poll `GET /api/jobs/:jobId` or subscribe to `/sse/stream/job/:jobId` for real-time updates.

---

## Where to go next

| I want to… | Go to |
|---|---|
| Onboard a real device (OctoPrint, Modbus, OPC-UA…) | `docs/AGENT_INTEGRATION.md` §2 Operator Onboarding |
| See every endpoint | `docs/AGENT_INTEGRATION.md` §1 API Reference |
| Load the 219-tool package into my LLM | `GET /agent-package.json` |
| Connect via MCP | `docs/AGENT_INTEGRATION.md` §7 (49 MCP tools) |
| Understand ALCOA+ / drift / assurance tiers | `docs/AGENT_INTEGRATION.md` §5 Safety & Compliance |
| Run a PCC node on my own machine | `docs/AGENT_INTEGRATION.md` §11 (`pip install pcc-node`) |
| Subscribe to real-time events | `docs/AGENT_INTEGRATION.md` §10 SSE Streams |
| Configure environment | `docs/AGENT_INTEGRATION.md` §9 Env Vars |
