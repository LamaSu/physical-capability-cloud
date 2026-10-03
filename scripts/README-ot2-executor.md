# OT-2 relay scripts: do not run against a public gateway

> **Warning (status board rows N4a/N4b).** `ot2-executor.py` and `ot2-agent.py daemon`
> run whatever the PCC relay hands them. That includes a shell-command tool, arbitrary
> protocol uploads (an Opentrons protocol is Python code), and, in `ot2-agent.py`, an
> LLM that holds the shell. (An earlier self-update tool that downloaded code from a URL is now disabled; see below.)
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
private network -- plus the one fixed external origin the agent needs, the Claude API
(`https://api.anthropic.com`), which only `ot2-agent.py` interactive and daemon register
after their start. `ot2-executor.py` and `ot2-agent.py daemon` need a local `PCC_BASE` and
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
  tool dispatcher `execute_tool()` and the underlying `_execute_tool()` (the shell tool included), and the loops (`run()`,
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

## Each approval runs once

`GET /api/operator/approvals?status=approved` lists every approval whose status is
`approved`, and no gateway route moves one out of that status on its own, so
`ot2-agent.py daemon` sees the same record on every poll, every `POLL_INTERVAL` seconds.
Two layers keep it from running twice (steward P0 #4698, readmodels #4558):

1. **A local marker, written before anything is dispatched.** `claim_job_once()` writes
   one file per approval -- named by the SHA-256 hex of its `id` (or, if it has none, its
   `jobId`) -- in `OT2_AGENT_STATE_DIR` (default `~/.pcc/ot2-agent/handled`), using
   `O_CREAT | O_EXCL` so that of any number of threads or processes racing to claim the
   same approval, exactly one wins. This alone is at-most-once *on this machine only*: a
   crash or power cut right after the marker is written loses that run instead of
   repeating it, and whatever keeps the marker from being written at all (a read-only
   directory, a full disk) fails closed -- the job is not run, and it is picked up again
   once the problem is fixed.

   **Durability.** A marker only survives a power cut if its directory entry, and the entry
   of every directory on the state path, reach the disk. So after each marker is written,
   every directory from `OT2_AGENT_STATE_DIR` up to the filesystem root is fsynced, on
   every claim. That includes directories an earlier, failed attempt created and never
   synced. When that can't be done
   (an I/O error; or Windows, where a directory can't be fsynced this way), the marker is
   kept, and:
   - with `OT2_AGENT_SERVER_CONSUME=off`, where the marker is the ONLY record, the job is
     **not run**: after a power cut the marker could be gone and the approval run again.
     Fix the state directory and approve the job again;
   - with the default `required`, the job still runs once the gateway consumes the
     approval, because the gateway's consume is then the durable record: a consumed
     approval never appears in the approved listing again. A WARNING says the local
     marks aren't durable.
2. **The gateway's consume route, for every other machine.** A marker on this machine
   cannot stop a *different* machine from running the same approval. So, with the default
   `OT2_AGENT_SERVER_CONSUME=required`, winning the local claim is necessary but not
   sufficient: this process must also ask the gateway to consume the approval,
   `POST /api/operator/approvals/<id>/consume` (gateway WP-C, PR #445) -- a compare-and-set
   on the approval itself, `approved -> consumed`, that answers 200 to exactly one caller
   and 409 to every other, and the approved listing never shows a consumed approval again.

| The gateway answers | consume_on_gateway() | Does the job run? | The local marker |
|---|---|---|---|
| 200 `{"consumed": true}` | "consumed" | yes | stays |
| 409, e.g. `approval_not_consumable` | "refused" | no | stays -- a later poll does not ask again |
| 409 `kernel_emergency_stopped` | "refused" | no | stays; logged as a WARNING |
| no usable approval `id` on the record (only a `jobId`, or a bool/non-string/non-integer `id`) | "refused" | no | stays; no gateway call is made at all |
| anything else -- 401/403/404/5xx, a 200 without `"consumed": true`, a transport error | "retry" | no | released -- a later poll claims the approval again and asks again |

A gateway that predates WP-C has no consume route and answers 404, which is the last row
above: under the default, **no job runs** against such a gateway -- every approval is
claimed, asked, refused by the 404, and released, over and over, until either the route
is deployed or the operator sets `OT2_AGENT_SERVER_CONSUME=off` knowingly.

`OT2_AGENT_SERVER_CONSUME` (case-insensitive, surrounding whitespace ignored):

- `required` -- the default; also what an unset or empty value means.
- `off` -- skips the gateway consume call entirely, for a gateway that predates the
  route. The local marker is then the only protection, and only on this machine;
  `daemon_mode()` logs a WARNING at start that cross-machine at-most-once is **not**
  enforced in this mode.
- anything else is logged once at ERROR and treated as `required`.

**Running a refused approval again.** A "retry" outcome already asks again on the next
poll, with nothing to do. For a "refused" approval (any 409, or a record with no usable
id) there are two ways: approve the job again, which is a new approval with a new `id`
and so runs once more; or delete its marker file -- named by the SHA-256 hex of the
approval's `id` (or `jobId`) -- from `OT2_AGENT_STATE_DIR`. Only do the latter when no
other agent might still be running that approval, since the marker is the only thing
stopping a second run on this machine. An approval refused because the kernel's
emergency stop was engaged does not start on its own once the stop is cleared -- approve
it again to run it.

## What serving PCC from an OT-2 will look like

That waits on row N4b. The robot will run only protocols the operator installed,
identified by a committed content hash. A PCC job selects one of those protocols and
supplies runtime parameters: customers send data, never code. The node waits for the run
to finish and reports the real outcome and a signed run log. Each run needs operator
approval, because someone has to load the deck. There is no shell tool.

The gateway half of N4b retires the legacy `/api/ot2/*` routes. It also takes command
classes from `packages/spec/src/tool-manifests/opentrons.tools.json`, where `shell` is
`privileged`, and mints execution scopes only on the server, for an accepted job.
