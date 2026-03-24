# PCC Jobs — CLI

Job management and live monitoring: list kernels, inspect running jobs, and stream sensor data from physical equipment.

## When to use
- "What jobs are running?"
- "Show me job J-0047"
- "List all kernels"
- "Get kernel details for kernel-01"
- "Show sensor data for the CNC machine"
- "What channels does kernel-03 have?"
- "Is my job done yet?"
- "Monitor the HPLC run"
- "What's the status of all active jobs?"

## Prerequisites
- Build the CLI first: `cd packages/mcp-server && npx tsc`
- Gateway reachable at `PCC_URL` (default: https://pcc-gateway-production.up.railway.app)

## Commands

### Kernels List — List Shop Kernels
```bash
node packages/mcp-server/dist/cli.js kernels list
```
Lists all registered Shop Kernels with their status (online/offline/busy), location, active capability count, and DePIN score. Kernels are the physical sites — each kernel wraps one or more physical devices. Use this to see which sites are active before submitting jobs.

Optional status filter:
```bash
node packages/mcp-server/dist/cli.js kernels list --status online
```

### Kernels Get — Kernel Details
```bash
node packages/mcp-server/dist/cli.js kernels get <kernelId>
```
Returns full details for a specific kernel: registered devices, available capabilities, current job queue depth, sensor channel list, adapter configurations, and assurance tier support. Replace `<kernelId>` with the kernel's ID (e.g., `kernel-01`).

Example:
```bash
node packages/mcp-server/dist/cli.js kernels get kernel-01
```

### Jobs List — List All Jobs
```bash
node packages/mcp-server/dist/cli.js jobs list
```
Lists jobs across all kernels. Shows job ID, capability type, kernel, current status, creation time, and milestone progress. Status values: `pending`, `active`, `evidence_submitted`, `completed`, `disputed`, `cancelled`.

Filter by kernel:
```bash
node packages/mcp-server/dist/cli.js jobs list --kernel kernel-01
```

Filter by status:
```bash
node packages/mcp-server/dist/cli.js jobs list --status active
```

### Jobs Get — Job Details
```bash
node packages/mcp-server/dist/cli.js jobs get <jobId>
```
Returns complete job details: capability contract, current milestone, evidence bundles with their IPFS CIDs and verification status, escrow balance, payment schedule, and full event timeline. This is your primary command for checking job progress.

Example:
```bash
node packages/mcp-server/dist/cli.js jobs get J-0047
```

Output includes:
- Job metadata (type, kernel, operator, client)
- Milestone progress (e.g., 2/4 complete)
- Per-milestone evidence status (collected / encrypted / IPFS-stored / Bittensor-verified / ZK-proven)
- Escrow state (funded amount, amount released so far, hold amount)
- Event log (job start, evidence submitted, milestones completed)

### Sensors List — List Sensor Channels
```bash
node packages/mcp-server/dist/cli.js sensors list <kernelId>
```
Lists all sensor channels registered for a kernel. Each channel has an ID, name, data type (numeric, boolean, enum), unit, and current status (streaming/idle). Use this to discover what telemetry is available before requesting data.

Example:
```bash
node packages/mcp-server/dist/cli.js sensors list kernel-01
```

### Sensors Data — Get Sensor Readings
```bash
node packages/mcp-server/dist/cli.js sensors data <kernelId> <channel>
```
Returns the most recent sensor readings for a specific channel. Output includes timestamped data points, current value, min/max over the last window, and any active anomaly flags. Useful for live monitoring of a running job.

Example:
```bash
node packages/mcp-server/dist/cli.js sensors data kernel-01 temperature_chamber
```

Optional time window (last N seconds):
```bash
node packages/mcp-server/dist/cli.js sensors data kernel-01 spindle_rpm --window 300
```

## Workflow: Monitor a Running Job

1. Find the job you want to monitor:
   ```bash
   node packages/mcp-server/dist/cli.js jobs list --status active
   ```

2. Get full job details and milestone progress:
   ```bash
   node packages/mcp-server/dist/cli.js jobs get <jobId>
   ```

3. Identify the kernel running the job (shown in job details), then list its sensor channels:
   ```bash
   node packages/mcp-server/dist/cli.js sensors list <kernelId>
   ```

4. Stream readings from relevant channels:
   ```bash
   node packages/mcp-server/dist/cli.js sensors data <kernelId> <channel>
   ```

5. Poll job status again to check if the next milestone was completed:
   ```bash
   node packages/mcp-server/dist/cli.js jobs get <jobId>
   ```

## Workflow: Inspect a Kernel Before Submitting a Job

1. List all online kernels:
   ```bash
   node packages/mcp-server/dist/cli.js kernels list --status online
   ```

2. Inspect a promising kernel for its capabilities and queue depth:
   ```bash
   node packages/mcp-server/dist/cli.js kernels get <kernelId>
   ```

3. Check existing jobs on that kernel to gauge load:
   ```bash
   node packages/mcp-server/dist/cli.js jobs list --kernel <kernelId> --status active
   ```

4. If the queue looks manageable, proceed to build a contract (`/pcc-build`) targeting this kernel.

## Tips
- `jobs get` is your most-used command once jobs are running. It shows everything in one call — contract, milestones, evidence, escrow.
- Sensor channels are kernel-specific. Always run `sensors list <kernelId>` first to discover available channels — channel names vary by equipment and adapter.
- `kernels list --status online` is faster than full list when you just want to find somewhere to send work.
- Job status `evidence_submitted` means the operator submitted evidence but the verifier hasn't confirmed yet. Check back in a few minutes or inspect the evidence bundle directly with `/pcc-evidence`.
- For SSE streaming of live job events from the gateway, use the REST SSE endpoint directly: `GET /sse/stream/job/<jobId>` — the CLI poll approach is simpler for spot checks.
