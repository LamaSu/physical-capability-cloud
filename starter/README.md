# PCC operator starter kit

Put a machine on the Physical Capability Cloud as a **verified operator kernel**, driven by your own AI agent (Claude Code, Codex, or anything that can run a shell) or by PCC's hosted agent. The kit is plain files, so every agent reads the same instructions.

## Start
1. Put this folder next to your device's manual (or on the computer beside the device).
2. Tell your agent:
   > "Onboard the device described in DEVICE_MANUAL.md onto PCC. Follow runbook/README.md, phase by phase. The PCC gateway is `<the URL you were given>`."
3. Answer the questions it asks. There will be few, and each says why.

## What's here
| Path | What it is |
|---|---|
| `runbook/` | The runbook: 10 phases from prerequisites to a running, verified device (`runbook.json` is the machine-readable form) |
| `bin/pcc-report` | Reports each phase of the attempt to PCC (painpoints' contract v1). Standard-library Python |
| `CLAUDE.md`, `AGENTS.md` | Entry points for Claude Code and Codex. Both say the same thing |
| `.pcc/` (created as you go, git-ignored) | This attempt's state: gateway, keys (mode 600), device, intake, envelope |

## Rules the agent follows
- It uses only the gateway you give it, and never production unless you say so.
- It asks you only what it can't find out itself.
- It never guesses a price, a payout or a safety limit.
- It keeps keys out of logs and chat.
- It reports every step, including the ones that fail, so the next person's attempt goes better.
