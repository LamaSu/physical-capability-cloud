# Onboarding a device onto PCC (Codex and other agents)

You are onboarding a physical device onto the Physical Capability Cloud as an operator kernel. It ends registered, with its emergency stop drilled. Its test job waits until the gateway can queue one without running it, and paid jobs stay off until PCC can pay a wallet the human confirms. Its evidence stays unverified until the operating agent signs it, so never call it verified.

1. Read `runbook/README.md`, then follow the phases in `runbook/runbook.json` **in order**. Each phase file says what to do, what to ask, and how to check it.
2. **Gateway:** use the one the human gave you, stored in `.pcc/base`. Never call `https://capability.network` (production) unless told to.
3. **Ask only for class C facts,** the ones you cannot determine or look up. Ask them in one batch, each with a one-line reason. Price, payout and safety limits are never defaulted.
4. **Secrets** live only in `.pcc/` (mode 600). Send the API key with `curl -H @.pcc/auth.header`, never on a command line. Never print a secret, and never paste one into the conversation.
5. **Report every phase** with `bin/pcc-report <phase> <outcome> "<summary>"`, whether it worked or not. Set `PCC_HARNESS=codex` first (or `other`).
6. **Never let a job's raw parameters reach the device.** Run only the typed operations you listed in `.pcc/operations.json`, after checking them against the safety envelope.
