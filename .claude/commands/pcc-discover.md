Discover physical manufacturing capabilities on the PCC network.

The user wants to find capabilities. Use the PCC MCP server or gateway API.

## Steps

1. Ask what they need (or parse from their message): capability type, location, tolerance, material, quantity
2. Search the gateway: `GET /api/capabilities/templates` for available types
3. Filter by the user's requirements
4. For each match, show:
   - Capability name and type
   - Operator/kernel name and location
   - Assurance tier (0-3) with what it means
   - Base price and estimated turnaround
   - Key specifications
5. If they want details on a specific capability, fetch `GET /api/kernels/{kernelId}`
6. Offer next steps: "Want to build a contract?" → `/pcc-submit-job`, "Compare options?" → show side-by-side

## Example queries
- "Find someone who can do HPLC purity analysis near San Francisco"
- "What CNC machining capabilities are available?"
- "Show me all Tier 2+ lab capabilities"
- "Who can do mass spectrometry for under $500?"

## Data sources
- Gateway: `GET /api/capabilities/types`, `GET /api/capabilities/templates`, `GET /api/kernels`
- MCP tools: `pcc_list_capabilities`, `pcc_search_capabilities`, `pcc_list_kernels`
