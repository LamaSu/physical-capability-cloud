# OT-2 relay scripts: do not run against a public gateway

> **Warning (status board rows N4a/N4b).** `ot2-executor.py` and `ot2-agent.py daemon`
> run whatever the PCC relay hands them. That includes a shell-command tool, arbitrary
> protocol uploads (an Opentrons protocol is Python code), and, in `ot2-agent.py`, an
> LLM that holds the shell plus a self-update tool that downloads code from a URL.
>
> The relay routes they poll (`/api/ot2/*`, and `/api/relay/*`, which shares the same
> tables) do not yet bind a call to an accepted, funded job with a committed protocol
> hash. On an unfixed gateway, **any holder of a PCC API key (self-service keys are
> free) can drive the robot and run commands on it.**

## What the scripts do now

Both refuse to start by default:

```
$ python3 scripts/ot2-executor.py
REFUSED: ot2-executor.py is not safe to run. ...        (exit 2)
```

They run only with `--unsafe-local`, and only when `PCC_BASE` points at a gateway on your
own machine or a private network: loopback, a private or link-local IP, `localhost`,
`*.local`, or a single-label hostname. Any public gateway, `https://capability.network`
included, is refused even with the flag. That is for local development against your own
gateway, nothing else:

```
PCC_BASE=http://127.0.0.1:8080 PCC_API_KEY=... python3 scripts/ot2-executor.py --unsafe-local
PCC_BASE=http://127.0.0.1:8080 PCC_API_KEY=... ANTHROPIC_API_KEY=... python3 scripts/ot2-agent.py daemon --unsafe-local
```

`ot2-agent.py interactive` takes its prompts from the local terminal and does not poll
PCC. It is not guarded, but the LLM still holds a shell on the robot. Treat that mode as
root access.

## What serving PCC from an OT-2 will look like

That waits on row N4b. The robot will run only protocols the operator installed,
identified by a committed content hash. A PCC job selects one of those protocols and
supplies runtime parameters: customers send data, never code. The node waits for the run
to finish and reports the real outcome and a signed run log. Each run needs operator
approval, because someone has to load the deck. There is no shell tool.

The gateway half of N4b retires the legacy `/api/ot2/*` routes. It also takes command
classes from `packages/spec/src/tool-manifests/opentrons.tools.json`, where `shell` is
`privileged`, and mints execution scopes only on the server, for an accepted job.
