# Claude Code Quickstart

PCC + Claude Code is the easiest path. The PCC skill is a single markdown
file Claude reads at top-of-conversation; it teaches Claude how to find
operators, post job-offers, and verify outcomes on your behalf.

## Install the skill (one time)

Claude Code loads personal skills from `~/.claude/skills/<name>/SKILL.md`.
Download the PCC skill there:

```bash
mkdir -p ~/.claude/skills/pcc
curl -fsSL https://capability.network/skills/pcc.md \
  -o ~/.claude/skills/pcc/SKILL.md
```

Every new Claude Code session then has it, and `/skills` lists it.

If you would rather give Claude the PCC tools than the skill, connect the
hosted MCP server instead. There is nothing to install:

```bash
claude mcp add --transport http pcc https://capability.network/mcp
```

## Use it

Once installed, just describe what you want in any Claude Code session.
The skill activates on triggers like:

- "order me a pizza"
- "print this STL file"
- "find a 3D printer near me"
- "book a photographer"
- "buy concert tickets through PCC"
- "send me a courier"

Claude will:

1. Find an operator in the PCC catalog that offers the capability.
2. Present the price + ETA + reputation back to you.
3. On your confirmation, post a job-offer.
4. Poll until status=settled, read evidence, report back.

## First-time auth (one prompt)

The first time Claude tries to POST a job-offer, it'll ask for an email
to bill against — that provisions a Bearer key. Save it to your env:

```bash
export PCC_API_KEY=pcc_live_...
```

Then it's set for the whole session. You can also use a wallet address
instead — Claude will provision against that.

## Customize the persona

You can wrap the skill in a persona for specific use-cases. Example:

```
You are a SF delivery-ordering assistant for {user}. Use PCC for any
real-world delivery task. Defaults: tip 18%, evidence tier 1, deadline
within 90 minutes unless specified. Confirm prices over $30 explicitly.
```

Then ask: "I'm hungry, what's around?"

Claude will scan the pizza.order / coffee.order / catering.order
capabilities in the user's area and surface options.

## What about persistent polling?

The Claude Code skill is for one-off transactions. If you're an operator
who wants to be alerted when a job-offer lands in your area, that's a
different need:

There is no packaged runtime for this yet: no `@pcc/operator-agent-runtime`
package exists. Until there is, poll the open job-offers feed (public, no key
needed) and claim a match with your API key:

```bash
curl "https://capability.network/api/job-offers/open?capabilityType=manufacturing.fdm"
curl -X POST "https://capability.network/api/job-offers/<id>/claim" \
  -H "Authorization: Bearer pcc_live_..."
```

## Troubleshoot

| Symptom | Fix |
|---------|-----|
| `/skills` doesn't list pcc | Check that `~/.claude/skills/pcc/SKILL.md` exists and starts with the `---` frontmatter block (`name: pcc`), then start a new session. |
| Claude says "no operators offer pizza.order" | Either the capability isn't populated in your area yet, or the catalog can't reach your geofilter. Try without `within=`. |
| POST /api/job-offers returns 401 | Bearer key isn't set. Re-provision: `curl -X POST https://capability.network/api/auth/provision -d '{"email":"you@example.com"}'` |
| Status stays `open` past deadline | Nobody claimed it. Cancel via `DELETE /api/job-offers/:id` or re-post with higher pricing. |

## More

- Full skill source: https://capability.network/skills/pcc.md
- Agent package: https://capability.network/agent-package.json
- Other surfaces: [claude-desktop.md](./claude-desktop.md), [claude-web.md](./claude-web.md)
