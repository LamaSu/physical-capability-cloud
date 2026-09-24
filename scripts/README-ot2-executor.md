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
own machine or a private network. Any public gateway, `https://capability.network`
included, is refused even with the flag. That is for local development against your own
gateway, nothing else:

```
PCC_BASE=http://127.0.0.1:8080 PCC_API_KEY=... python3 scripts/ot2-executor.py --unsafe-local
PCC_BASE=http://192.168.1.20:8080 PCC_API_KEY=... ANTHROPIC_API_KEY=... python3 scripts/ot2-agent.py daemon --unsafe-local
```

The rules are in `scripts/ot2_local_guard.py`, and neither script starts without it:

- **Addresses, not names.** `PCC_BASE` and `OT2_BASE` must name an IP address in canonical
  form, in loopback (127/8, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7) or
  link-local (169.254/16, fe80::/10) space, or the name `localhost`, which is pinned to
  127.0.0.1. Nothing is looked up in DNS, and requests go to the exact address that was
  checked. Hostnames (`spark`, `ot2.local`), integer, hex or octal spellings
  (`http://134744072` is 8.8.8.8), `0.0.0.0`, IPv4-mapped IPv6, credentials, queries and
  schemes other than http/https are refused.
- **One transport.** Every PCC and robot request ignores `HTTP(S)_PROXY`/`ALL_PROXY`,
  never follows a redirect (the 3xx is treated as a failed call) and verifies TLS. For a
  local gateway with its own certificate, set `PCC_CA_FILE` to its CA. Robot uploads use
  `curl --noproxy '*'`.
- **Nothing runs unauthorised.** The polling loops (`run()`, `daemon_mode()`) and the PCC
  and robot request helpers exit 2 unless `start_guard()` accepted this process, so
  importing a script and calling them does nothing.
- **Self-update is disabled** in `ot2-agent.py`. It installed code downloaded from any URL.

What this guard cannot do: once started, the relayed shell tool and uploaded protocols
run as code on the robot and can open their own connections. The guard keeps the
scripts from being driven by a public gateway; it does not make a relayed command safe.
That is row N4b.

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
