# PCC Onboard — CLI

Onboard a new machine or capability to the PCC network using CLI tools.

## When to use
- "I have a new machine to add" / "Onboard my printer" / "Register equipment"
- "Set up a new kernel" / "Add my CNC mill to PCC"

## Prerequisites
- PCC gateway reachable at PCC_URL (default: https://pcc-gateway-production.up.railway.app)
- Build CLI: `cd packages/mcp-server && npx tsc`

## Commands

### Auto-detect configuration state
```bash
node packages/mcp-server/dist/cli.js setup detect [--pretty]
```
Check what's configured, what env vars are set, database status. **Start here.**

### Scan for devices on network
```bash
node packages/mcp-server/dist/cli.js discover scan [--protocols=ipp] [--timeout=3000] [--pretty]
```
Find IPP printers and other discoverable devices on the local network.

### One-command onboard pipeline
```bash
node packages/mcp-server/dist/cli.js discover onboard [--uri=ipp://192.168.1.50/ipp/print] [--protocol=ipp] [--pretty]
```
Auto-discover → generate CSD → register in PCC registry. All in one command.

### Generate kernel config
```bash
node packages/mcp-server/dist/cli.js setup config '<devicesJson>' [--kernelId=my-shop] [--mockMode] [--pretty]
```
Generate KERNEL_CONFIG JSON from device descriptions. The devicesJson is an array of `{name, type, adapterType, url?, apiKey?, host?, port?}`.

### Validate config
```bash
node packages/mcp-server/dist/cli.js setup validate [--config='{}'] [--pretty]
```
Check adapter connectivity and config completeness. Omit --config to validate current.

### Register a device
```bash
node packages/mcp-server/dist/cli.js setup register-device --kernelId=x --deviceId=y --type=machine|sensor|camera --adapter=octoprint|modbus|opcua|sila|generic-http|mock [--model="Prusa MK4"] [--pretty]
```

### Health check
```bash
node packages/mcp-server/dist/cli.js setup health [--deviceId=x] [--pretty]
```
Connectivity status and response time for all or specific devices.

### Run test job
```bash
node packages/mcp-server/dist/cli.js setup test-job [--kernelId=x] [--deviceId=y] [--tier=0] [--pretty]
```
End-to-end pipeline test: submit → execute → evidence → (optional) settlement.

### Generate .env file
```bash
node packages/mcp-server/dist/cli.js setup env dev|testnet|mainnet [--pretty]
```

### Overall setup status
```bash
node packages/mcp-server/dist/cli.js setup status [--pretty]
```

## Workflow: Full machine onboarding
1. `pcc setup detect --pretty` — check current state
2. `pcc discover scan --pretty` — find devices
3. `pcc discover onboard --pretty` — auto-onboard first found device
4. `pcc setup health --pretty` — verify connectivity
5. `pcc setup test-job --pretty` — run end-to-end test
6. `pcc setup status --pretty` — confirm everything green

## Workflow: Manual setup from scratch
1. `pcc setup env dev --pretty` — generate .env
2. `pcc setup config '[{"name":"My Printer","type":"machine","adapterType":"octoprint","url":"http://192.168.1.50"}]' --pretty`
3. `pcc setup validate --pretty`
4. `pcc setup register-device --kernelId=my-shop --deviceId=printer-01 --type=machine --adapter=octoprint --pretty`
5. `pcc setup health --deviceId=printer-01 --pretty`
6. `pcc setup test-job --kernelId=my-shop --pretty`

## Tips
- Use `--mockMode` with setup config for testing without real hardware
- Adapter types: octoprint, modbus, opcua, sila, generic-http, mock
- Device types: machine, sensor, camera
