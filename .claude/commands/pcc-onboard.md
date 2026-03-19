Onboard a new machine or capability to the PCC network.

Prompt-to-build onboarding: describe equipment in natural language, AI generates kernel configuration.

## Steps

1. Ask the user to describe their equipment and what it can do
2. Parse the description to infer:
   - Capability type (map to PCC taxonomy: hplc, cnc-3axis, cnc-5axis, fdm-printer, mass-spec, flow-reactor, etc.)
   - Key specifications (detector type, axis count, build volume, resolution, etc.)
   - Location
   - Typical turnaround time
   - Price range
3. Suggest an assurance tier based on the capability type and specifications
4. Generate a kernel configuration using `pcc_build_options` to validate parameters
5. Show the configuration for review:
   - Kernel name and description
   - Capability type and specifications
   - Suggested pricing
   - Required evidence types for the chosen assurance tier
   - ERC-8004 Agent Registration File preview
6. Let the user adjust anything
7. Register: guide through on-chain registration steps

## Example prompts
- "I have a Shimadzu HPLC with UV detector, we do pharma purity analysis in 4 hours"
- "Onboard my Haas VF-2 CNC mill, we can machine aluminum and steel"
- "Register a Prusa i3 MK3S+ for FDM printing, PLA/PETG materials"
- "Add my Waters mass spec for molecular weight confirmation"

## Data sources
- `pcc_list_capabilities` — validate capability types
- `pcc_build_options` — validate parameter configurations
- `pcc_agent_registration` — preview the generated ERC-8004 registration file
