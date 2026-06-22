# Claude.ai (Web) Quickstart

You're on https://claude.ai with a Claude Max subscription, no Code, no
Desktop. You can still use PCC — just hand Claude the agent-package and
it'll transact via HTTP fetches.

## Fastest path: paste the URL

Open a new conversation and paste:

```
Use this spec to act as my agent for real-world transactions:
https://capability.network/agent-package.json

Then: order me a pizza for delivery to 728 Geary St SF.
```

Claude reads the JSON's `system_prompt`, picks the right tools from the
`tools` array, and uses its built-in WebFetch to call
`https://capability.network/api/...` endpoints. The agent-package
contains 249 tool schemas — Claude treats them like its own tool palette.

## Alternative: paste the system_prompt directly

If WebFetch isn't enabled in your Claude.ai account, paste the
system_prompt verbatim. Get it from:

```bash
curl -sL https://capability.network/agent-package.json | jq -r .system_prompt
```

Copy the output, paste it at the top of a Claude.ai conversation, then
ask for what you want.

## Limitations

Claude.ai's web environment is more restricted than Code or Desktop:

- **No persistent state.** Each conversation is fresh. You can't install
  a skill or save credentials. Re-paste each time.
- **No file upload to PCC.** Claude.ai can't `POST /api/storage` with a
  binary STL file directly. Workaround: host the STL elsewhere (Dropbox,
  IPFS) and pass the URL in `requirements.stl_url` — the operator-side
  adapter will fetch it.
- **No streaming.** SSE endpoints (`GET /sse/stream/job/:id`) don't work
  in the web client. Use polling instead: ask Claude to "check the status
  every 30 seconds" — it'll re-fetch in subsequent turns.
- **Auth provisioning still works.** Claude can POST to
  `/api/auth/provision` to get a Bearer key, but you'll need to save it
  manually (paste back into the next conversation).

## Trick: persistent context via Claude Projects

If you have Claude Projects (Pro/Max), create a project named "PCC" and
paste the system_prompt + your Bearer key as the project's persistent
instructions. Every conversation in that project starts pre-loaded with
the PCC context. The skill/MCP install equivalents for the web client.

## Example session

You (paste this whole thing):
```
Use https://capability.network/agent-package.json as your spec. My PCC
API key is pcc_live_XXXXXXXXX. My email is me@example.com. I'm in San
Francisco at 728 Geary St (37.78,-122.41).

Order me a medium pepperoni from a nearby pizza shop, delivered. Budget
ceiling $30 including tip. Confirm price with me before posting offers.
```

Claude:
1. Fetches the agent-package, reads the system_prompt.
2. `GET /api/capabilities?type=pizza.order&within=37.78,-122.41,5`.
3. Picks 2-3 options, shows you prices + ETA.
4. You pick one.
5. `POST /api/job-offers` for the pizza, then `POST /api/job-offers` for
   a courier, polls both until settled.
6. Reports back.

## When to upgrade to Code/Desktop

- You want to install once + reuse → use **Claude Code** + the skill.
- You're on a desktop and want 63 tools in the palette → use **Claude
  Desktop** + the MCP server.
- You want to script PCC programmatically → use the npm packages
  (`@pcc/decompose-skill`, `@pcc/operator-agent-runtime`, `@pcc/evidence-judge`).

## More

- Agent-package: https://capability.network/agent-package.json
- Skill file (also usable as a long-form spec): https://capability.network/skills/pcc.md
- Other surfaces: [claude-code.md](./claude-code.md), [claude-desktop.md](./claude-desktop.md)
