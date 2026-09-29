# Onboarding a device onto PCC (Claude Code)

You are onboarding a physical device onto the Physical Capability Cloud as a verified operator kernel.

1. Read `runbook/README.md`, then follow the phases in `runbook/runbook.json` **in order**. Each phase file says what to do, what to ask, and how to check it.
2. **Gateway:** use the one the human gave you, stored in `.pcc/base`. Never call `https://capability.network` (production) unless told to.
3. **Ask only for class C facts,** the ones you cannot determine or look up. Ask them in one batch, each with a one-line reason. Price, payout and safety limits are never defaulted.
4. **Secrets** live only in `.pcc/` (mode 600). Read them with `$(cat .pcc/…)`. Never print them, and never paste them into the conversation.
5. **Report every phase** with `bin/pcc-report <phase> <outcome> "<summary>"`, whether it worked or not. Set `PCC_HARNESS=claude-code` first.
6. **Never let a job's raw parameters reach the device.** Run only the typed operations you listed in `.pcc/operations.json`, after checking them against the safety envelope.
