# OpenAI Codex -- Analysis for PCC Integration

**Date**: 2026-03-30
**Researcher**: Claude Opus 4.6 (researcher agent)
**Repo**: https://github.com/openai/codex
**Version analyzed**: v0.117.0 (March 26, 2026)

---

## 1. What Is It?

OpenAI Codex (2025-2026 iteration, not the deprecated 2021 code-completion API) is a **terminal-based coding agent** written in Rust. It ships as:

- **Codex CLI** (`@openai/codex` on npm, `brew install --cask codex`) -- full-screen TUI that reads, edits, and runs code locally
- **Codex App** -- Electron/Tauri desktop wrapper around the same engine
- **Codex Cloud** -- cloud-hosted variant at chatgpt.com/codex (sandboxed VMs)
- **VS Code / Cursor / Windsurf extension** -- IDE integration
- **Codex SDK** (`@openai/codex-sdk`) -- TypeScript library for programmatic control
- **Codex MCP Server** (`codex mcp-server`) -- exposes the agent as an MCP server over stdio

### Key Metrics

| Metric | Value |
|--------|-------|
| Stars | 68,500+ |
| Forks | 9,200+ |
| License | Apache 2.0 |
| Language | 94.6% Rust, 3% Python, 1.4% TypeScript |
| Build system | Bazel + pnpm |
| Total commits | 4,958 on main |
| Total releases | 660+ |
| Latest release | v0.117.0 (Mar 26, 2026) |
| Models | GPT-5.4 (default), GPT-5.3-Codex, GPT-5.3-Codex-Spark |
| Auth | ChatGPT account (Plus/Pro/Team/Edu/Enterprise) or API key |

---

## 2. Architecture

### Core Agent Loop

The Codex agent operates as a sandboxed loop:

1. User prompt enters the TUI or exec mode
2. Model reasons over codebase context + AGENTS.md instructions
3. Model emits tool calls: file reads, file edits, shell commands
4. Each tool call is sandboxed (macOS Seatbelt / Linux Landlock)
5. Results feed back into the model for the next step
6. User can approve/reject at each step (configurable: auto / read-only / full-access)

### Three Approval Modes

| Mode | File Read | File Edit | Shell Exec | Network |
|------|-----------|-----------|------------|---------|
| Read-only | Yes | No | No | No |
| Auto (default) | Yes | Yes (workdir) | Yes (workdir) | No |
| Full Access | Yes | Yes (machine-wide) | Yes | Yes |

### MCP Integration (Bidirectional)

**Codex consumes MCP servers**: Configure in `~/.codex/config.toml` or project `.codex/config.toml`. Supports STDIO and streamable HTTP servers with OAuth, bearer token, and env-var auth. Managed via `codex mcp add/list/remove/login/logout`.

**Codex runs AS an MCP server**: `codex mcp-server` exposes two tools over stdio:
- `codex(prompt, approval-policy, sandbox, model, cwd, base-instructions)` -- start a session
- `codex-reply(prompt, threadId)` -- continue an existing session

This allows any MCP client (including the OpenAI Agents SDK, Claude Code, or another Codex instance) to orchestrate Codex programmatically.

### Multi-Agent

v0.117.0 introduced readable path-based agent addresses (`/root/agent_a`) with structured inter-agent messaging. Agents run in isolated Git worktrees for parallel execution. The Agents SDK cookbook shows PM -> Designer -> Frontend Dev -> Backend Dev -> Tester hand-off chains.

---

## 3. Plugin System (Launched Mar 26, 2026)

This is the "new" part the user likely saw. Plugins are now **first-class** in Codex as of v0.117.0.

### Plugin Structure

```
my-plugin/
  .codex-plugin/plugin.json    # manifest (required)
  skills/                      # SKILL.md files
  .app.json                    # app/connector mappings (optional)
  .mcp.json                    # MCP server config (optional)
  assets/                      # icons, screenshots
```

### Plugin Manifest (plugin.json)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "...",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "displayName": "My Plugin",
  "category": "Productivity",
  "capabilities": ["code-review", "deployment"]
}
```

### Distribution

- **Repo-scoped**: `.agents/plugins/marketplace.json` at repo root
- **Personal**: `~/.codex/plugins/` with marketplace at `~/.agents/plugins/marketplace.json`
- **Public directory**: Coming soon (curated by OpenAI, ~20 plugins currently)

### Available Plugins (curated, Mar 2026)

Gmail, Google Drive, Slack, Figma, Notion, Box, Linear, Sentry, Hugging Face, "build web app" (bundles Stripe + Supabase + Vercel MCP servers + skills), and the notable **codex-plugin-cc** (Claude Code integration).

### Skills Format

Skills live in `skills/<name>/SKILL.md` with YAML frontmatter:

```yaml
---
name: hello
description: Greet the user
---

Instructions for the agent go here.
```

Skills activate implicitly (model picks them based on task match) or explicitly (`$skill-name` or `/skills`). Progressive disclosure: only metadata loads until activated.

### AGENTS.md

Equivalent to Claude Code's `CLAUDE.md`. Codex reads `AGENTS.md` (or `AGENTS.override.md`) from `~/.codex/`, repo root, and every directory down to cwd. Closest wins. Contains build commands, test instructions, conventions, and repo-specific guidance.

---

## 4. The Claude Code Plugin (codex-plugin-cc)

**Repo**: https://github.com/openai/codex-plugin-cc
**Version**: v1.0.1 (March 31, 2026)
**Stars**: 1,900
**Language**: 100% JavaScript
**License**: Apache 2.0

This plugin lets Claude Code users delegate work to Codex:

| Command | What It Does |
|---------|-------------|
| `/codex:review` | Read-only code review of uncommitted changes or branch diffs |
| `/codex:adversarial-review` | Challenge review that pressures design assumptions |
| `/codex:rescue` | Delegate a task to Codex (bug fix, feature, continued work) |
| `/codex:status` | Check background job progress |
| `/codex:result` | Get completed task output |
| `/codex:cancel` | Kill an active background job |
| `/codex:setup` | Validate installation, configure review gate |

It wraps the local Codex CLI binary, reuses existing Codex auth, and executes locally. It can run tasks in the background while Claude Code continues working.

---

## 5. Codex SDK (Programmatic Control)

```typescript
import { Codex } from '@openai/codex-sdk';

const codex = new Codex();
const thread = codex.startThread();
const result = await thread.run("Implement the feature described in SPEC.md");
// continue
const result2 = await thread.run("Now write tests for it");
// resume later
const thread2 = codex.resumeThread(threadId);
```

Node.js 18+, server-side only. Enables CI/CD integration, custom tooling, and building Codex into internal applications.

---

## 6. PCC Integration Analysis

### 6A. Could Codex replace or complement PCC's agent package?

**No -- different layer entirely.**

PCC's agent package (197 tools, served at `/agent-package.json`) is a **domain-specific tool manifest** for physical capability orchestration. Codex is a **coding agent** -- it writes and edits code. They operate at different levels:

| Concern | PCC Agent Package | Codex |
|---------|-------------------|-------|
| Purpose | Physical capability discovery, pricing, escrow, verification | Code writing, editing, testing |
| Consumer | Any AI agent (Claude, GPT, Gemini, custom) | Developers and CI/CD |
| Transport | REST API over HTTPS | Local CLI / MCP stdio |
| Domain | Physical equipment, jobs, escrow, ZK proofs | Software engineering |

However, Codex **could consume PCC's tools** via MCP. If we expose the PCC MCP server to Codex, it could:
- Write integration code that calls PCC APIs
- Debug PCC client libraries
- Generate protocol templates
- Help operators write custom automation scripts

**Verdict: Complementary, not competitive. Different layers.**

### 6B. Could Codex be a distribution channel for PCC tools?

**YES -- high value. This is the most actionable finding.**

PCC could be packaged as a **Codex plugin** that bundles:

1. **Skills**: Operator onboarding workflow, capability discovery, job submission, escrow management
2. **MCP Server**: The existing `packages/mcp-server` (29 tools) -- already built for stdio
3. **AGENTS.md**: PCC-specific instructions for Codex when working on PCC-integrated projects

This would put PCC into the Codex plugin ecosystem, making it discoverable to the 68,500+ GitHub star community. The plugin structure maps almost 1:1 to what PCC already has:

```
pcc-codex-plugin/
  .codex-plugin/plugin.json
  skills/
    onboard-operator/SKILL.md      # 5-step self-onboarding flow
    submit-job/SKILL.md            # DHT discovery -> escrow -> execution
    verify-evidence/SKILL.md       # ZK proof generation + human verification
    manage-escrow/SKILL.md         # Fund, release, dispute
    discover-capabilities/SKILL.md # Search the network
  .mcp.json                        # Points to @pcc/mcp-server
  assets/
    logo.png
    screenshot-dashboard.png
```

**Effort estimate**: 2-3 hours. PCC already has the MCP server and the skill descriptions in `AGENT-SKILLS.md`. Just needs repackaging into Codex plugin format.

### 6C. Could Codex help operators onboard?

**YES -- medium value.**

Two paths:

1. **Codex plugin path** (described above): An operator installs the PCC plugin in their Codex, runs `$pcc-onboard`, and Codex walks them through kernel creation, device registration, and test job submission -- all via MCP tool calls to the PCC gateway.

2. **AGENTS.md path**: PCC could ship an `AGENTS.md` at repo root (alongside the existing `CLAUDE.md`) with PCC-specific guidance. Any Codex user who clones the PCC repo would automatically get PCC-aware agent assistance. This is trivial -- 30 minutes of work, basically a translated `CLAUDE.md`.

3. **Codex SDK in PCC setup agent**: The `docs/SETUP_AGENT_SPEC.md` operator onboarding system could optionally use `@openai/codex-sdk` as an alternative agent runtime (alongside Claude). This would give operators choice of agent.

### 6D. Could agents built with Codex interact with PCC?

**YES -- this is already possible via MCP.**

Any Codex user can:

```bash
codex mcp add pcc -- npx @pcc/mcp-server
```

And immediately get all 29 MCP tools available inside Codex. The MCP server we already built (`packages/mcp-server`) is compatible -- same stdio protocol.

For the OpenAI Agents SDK path:

```python
async with MCPServerStdio(
    name="PCC",
    params={"command": "npx", "args": ["-y", "@pcc/mcp-server"]},
) as pcc_mcp:
    operator_agent = Agent(
        name="PCC Operator",
        instructions="Help users interact with the Physical Capability Cloud...",
        mcp_servers=[pcc_mcp],
    )
    await Runner.run(operator_agent, "Find labs that can do HPLC analysis")
```

### 6E. Is there an MCP or tool-use integration?

**YES -- deep MCP integration on both sides.**

- PCC has an MCP server: `packages/mcp-server` (29 tools, stdio transport)
- Codex consumes MCP servers: `codex mcp add` (stdio + HTTP, OAuth/bearer auth)
- Codex runs AS an MCP server: `codex mcp-server` (2 tools: codex + codex-reply)
- Claude Code can run Codex via the `codex-plugin-cc` plugin

The interop matrix:

```
Claude Code --[codex-plugin-cc]--> Codex --[MCP]--> PCC MCP Server
Claude Code --[MCP]--> PCC MCP Server (direct, already working)
Codex --[MCP]--> PCC MCP Server (would work with codex mcp add)
OpenAI Agents SDK --[MCP]--> Codex --[MCP]--> PCC MCP Server
OpenAI Agents SDK --[MCP]--> PCC MCP Server (direct)
```

---

## 7. Decision Matrix

| Item | Type | Integration | Value | Status | Action |
|------|------|-------------|-------|--------|--------|
| Codex CLI | Terminal agent | Already MCP-compatible | MEDIUM | Available | Document in PCC README |
| Codex Plugin System | Distribution format | Package PCC as plugin | HIGH | New (Mar 26) | Build PCC Codex plugin |
| codex-plugin-cc | Claude Code plugin | Cross-agent delegation | MEDIUM | Available | Install for code review |
| Codex SDK | TypeScript library | Alt agent runtime | LOW | Available | Skip for now |
| Codex Cloud | Cloud VM agent | Could run PCC jobs | LOW | Available | Skip (no local hardware) |
| AGENTS.md format | Convention | Ship alongside CLAUDE.md | HIGH | Trivial | Create AGENTS.md |
| Codex MCP Server mode | MCP server | Orchestrate Codex from Claude | MEDIUM | Available | Useful for multi-agent |

---

## 8. Recommended Actions (Ordered by Value)

### Action 1: Create AGENTS.md for PCC repo (HIGH value, 30 min)

Translate existing `CLAUDE.md` conventions into `AGENTS.md` format so Codex users who clone the PCC repo get PCC-aware assistance automatically. Include:
- Build commands (pnpm, turbo, vitest)
- Test commands
- Package structure
- Gateway URL and auth flow
- Coding conventions from CLAUDE.md

**Why**: Zero-cost distribution. Anyone running `codex` in the PCC repo gets intelligent help.

### Action 2: Package PCC as Codex Plugin (HIGH value, 2-3 hours)

Create `plugins/pcc-codex-plugin/` with:
- `plugin.json` manifest
- 5 skills translated from AGENT-SKILLS.md
- `.mcp.json` pointing to `@pcc/mcp-server`
- Local marketplace.json for testing

**Why**: Makes PCC discoverable in the Codex ecosystem. When OpenAI opens their public plugin directory, PCC would be the first physical capability plugin.

### Action 3: Document MCP interop in PCC README (MEDIUM value, 15 min)

Add a section showing:
```bash
codex mcp add pcc -- npx @pcc/mcp-server
```

**Why**: One-line onboarding for the 68K+ Codex user base.

### Action 4: Install codex-plugin-cc for dev workflow (MEDIUM value, 10 min)

The adversarial review and rescue delegation features could be useful during PCC development. Use Codex as a second opinion / parallel worker.

**Why**: Free code review from a different model (GPT-5.4 vs Claude).

### Action 5: Evaluate Codex SDK for pcc-node CLI (LOW value, future)

The `@openai/codex-sdk` could theoretically power an alternative agent experience in `pcc-node`. Not a priority -- the current agent package + MCP server covers this well.

**Why**: Only relevant if PCC wants to offer GPT-native agent experience alongside Claude.

---

## 9. Skipped (Low Value or Not Applicable)

| Item | Reason |
|------|--------|
| Codex Cloud | Runs in sandboxed VMs with no hardware access -- useless for physical capabilities |
| Codex VS Code extension | IDE-specific, not relevant to PCC's agent-first architecture |
| Codex Desktop App | Wrapper around CLI, no additional integration surface |
| Codex multi-agent (worktrees) | Interesting but PCC already has its own multi-agent harness |
| GPT-5.4 / GPT-5.3-Codex models | Model choice is orthogonal to PCC integration |

---

## 10. Competitive/Strategic Notes

1. **AGENTS.md vs CLAUDE.md**: These are converging standards. Both are markdown files at repo root that guide coding agents. PCC should ship both (`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex). The content is 90% identical.

2. **Plugin ecosystems are fragmenting**: Codex plugins, Claude Code skills, Cursor rules, Windsurf rules -- every tool has its own format. PCC's MCP server is the universal adapter. MCP is the interop layer. Investing in MCP (which PCC already has) is the right bet over any single plugin format.

3. **Codex's plugin format bundles MCP + skills**: This is exactly what PCC's agent package does (tools + system prompt + instructions). The Codex plugin format is just a different packaging of the same concept. Translation is mechanical.

4. **The codex-plugin-cc bridge is notable**: OpenAI built a first-party plugin for Claude Code integration. This signals that cross-agent interop is a real use case, not just theoretical. PCC benefits from being present in both ecosystems.

5. **Distribution play**: If/when OpenAI opens the public plugin directory, being early with a "physical capability" plugin could establish PCC as the reference implementation for hardware-agent integration in the Codex ecosystem, much like the "build web app" plugin is for web dev.

---

## Sources

- [openai/codex GitHub repo](https://github.com/openai/codex)
- [openai/codex-plugin-cc GitHub repo](https://github.com/openai/codex-plugin-cc)
- [Codex Plugins documentation](https://developers.openai.com/codex/plugins)
- [Build plugins guide](https://developers.openai.com/codex/plugins/build)
- [Codex CLI features](https://developers.openai.com/codex/cli/features)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex MCP documentation](https://developers.openai.com/codex/mcp)
- [Codex + Agents SDK guide](https://developers.openai.com/codex/guides/agents-sdk)
- [Codex SDK documentation](https://developers.openai.com/codex/sdk)
- [Codex Skills documentation](https://developers.openai.com/codex/skills)
- [Codex Customization](https://developers.openai.com/codex/concepts/customization)
- [AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)
- [Codex Changelog](https://developers.openai.com/codex/changelog)
- [Codex Releases](https://github.com/openai/codex/releases)
- [Introducing Codex (OpenAI blog)](https://openai.com/index/introducing-codex/)
