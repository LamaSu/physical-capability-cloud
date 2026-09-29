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

Every mode of both scripts refuses to start by default:

```
$ python3 scripts/ot2-executor.py
REFUSED: ot2-executor.py is not safe to run. ...        (exit 2)
```

They run only with `--unsafe-local`, and only against addresses on your own machine or a
private network. `ot2-executor.py` and `ot2-agent.py daemon` need a local `PCC_BASE` and
`OT2_BASE`; any public gateway, `https://capability.network` included, is refused even
with the flag. `ot2-agent.py interactive` and `ot2-agent.py health` do not poll PCC, but
they drive the robot (and in interactive mode an LLM holds a shell on it), so they need
the flag and a local `OT2_BASE` too. This is for local development, nothing else:

```
PCC_BASE=http://127.0.0.1:8080 PCC_API_KEY=... python3 scripts/ot2-executor.py --unsafe-local
PCC_BASE=http://192.168.1.20:8080 PCC_API_KEY=... ANTHROPIC_API_KEY=... python3 scripts/ot2-agent.py daemon --unsafe-local
OT2_BASE=http://192.168.1.30:31950 python3 scripts/ot2-agent.py health --unsafe-local
```

The rules are in `scripts/ot2_local_guard.py`, and neither script starts without it:

- **Addresses, not names.** `PCC_BASE` and `OT2_BASE` must name an IP address in canonical
  form, in loopback (127/8, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7) or
  link-local (169.254/16, fe80::/10) space, or the name `localhost`, which is pinned to
  127.0.0.1. Nothing is looked up in DNS, and requests go to the exact address that was
  checked. Hostnames (`spark`, `ot2.local`), integer, hex or octal spellings
  (`http://134744072` is 8.8.8.8), `0.0.0.0`, IPv4-mapped IPv6, IPv6 zone ids
  (`fe80::1%eth0`), percent-encoding, credentials, queries and schemes other than
  http/https are refused, on every Python version the tests run on.
- **One HTTP transport, checked where the request is sent.** Every HTTP request the
  scripts themselves make goes through `ot2_local_guard.request()`: PCC polling and
  results, robot commands, protocol uploads, and the agent's Claude API calls. Before it
  opens a connection it exits 2 unless a start was accepted and the URL is under the
  checked `PCC_BASE`, the checked `OT2_BASE`, or `https://api.anthropic.com` (registered
  by the agent's interactive and daemon modes after their start). It ignores
  `HTTP(S)_PROXY`/`ALL_PROXY`, never follows a redirect (a 3xx comes back as a failed
  call) and verifies TLS; for a local gateway with its own certificate, set
  `PCC_CA_FILE` to its CA. Protocol uploads are built in memory as multipart/form-data:
  no curl, no temp file, and the file name must be a plain name such as `protocol.py`.
- **What a start gates.** Until `start_guard()` (executor, agent daemon) or
  `start_interactive()` (agent interactive and health) accepts the process, these exit 2:
  `request()` and each script's `http()`, `pcc()`, `ot2()` and `claude()` helpers, the
  tool dispatcher `execute_tool()` (the shell tool included), and the loops (`run()`,
  `daemon_mode()`, `interactive_mode()`). Importing a script and calling any of them
  does nothing.
- **Self-update is disabled** in `ot2-agent.py`. It installed code downloaded from any URL.

What this guard cannot do: once a start is accepted, the shell tool and uploaded
protocols run as code on the robot, and that code can open its own connections; the
guard constrains the scripts' own HTTP, not what a relayed command does. In interactive
and daemon mode the LLM holds that shell, so treat both as root access to the robot.
Camera capture runs local device tools (`v4l2-ctl`, `ffmpeg`, `dd`) and makes no network
calls. The guard keeps the scripts from being driven by a public gateway; it does not
make a relayed command safe. That is row N4b.

The tests are stdlib-only and start local fixture servers in place of the gateway, the
robot, a "public" host and a proxy:
`python3 -m unittest -v scripts/test_ot2_executor_guard.py`. CI runs them on Python 3.8,
3.10 and 3.12.

## What serving PCC from an OT-2 will look like

That waits on row N4b. The robot will run only protocols the operator installed,
identified by a committed content hash. A PCC job selects one of those protocols and
supplies runtime parameters: customers send data, never code. The node waits for the run
to finish and reports the real outcome and a signed run log. Each run needs operator
approval, because someone has to load the deck. There is no shell tool.

The gateway half of N4b retires the legacy `/api/ot2/*` routes. It also takes command
classes from `packages/spec/src/tool-manifests/opentrons.tools.json`, where `shell` is
`privileged`, and mints execution scopes only on the server, for an accepted job.
