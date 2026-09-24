"""OT-2 command trace as kernel-signed evidence (R46; evidence #52 ``machine.execution_log``,
``logKind: command_trace``).

When a run finishes, the robot's own record of what it did is its command list:
``GET /runs/{runId}/commands`` on the Opentrons HTTP API. This module turns that list
into evidence that both checks downstream accept:

* the #52 log-chain verifier (``packages/spec/src/evidence/verifiers/log-chain.ts``):
  one ``log_hash_chain_entry`` per command, in the robot's order, built by
  :class:`~pcc_node.log_capture.LogCapture` as a kernel-signed SHA-256 chain with full
  disclosure (``rawContent`` is present, so every ``entryHash`` can be recomputed);
* the LO-EV-9 subject binding (``verifyEvidenceSubjectBinding`` in @pcc/spec): every
  event commits ``payload.jobId``, ``payload.kernelId`` and ``payload.protocolHash``,
  its ``source.kernelId`` is the kernel that accepted the job, and it carries its own
  ``hash`` (``hashEvent``: sha256 over the canonical ``{type, timestamp, source,
  payload}``), so a bundle of these events binds to exactly one job.

This is a pure producer. Fetching is injected, and nothing here signs a bundle or talks
to the gateway. Input that is incomplete fails closed with :class:`CommandTraceError`:
a page that stops before the robot's own ``totalLength``, a command without an id, a
type or a time, or a duplicate id. A trace that silently drops commands would prove a
run the robot did not perform.
"""

from urllib.parse import quote

from .log_capture import canonicalize, sha256_hex

LOG_KIND = "command_trace"
EVENT_TYPE = "log_hash_chain_entry"
OT2_API_VERSION = "2"
DEFAULT_PAGE_LENGTH = 200
MAX_COMMANDS = 100_000

# The command-summary fields that are the robot's record of the run. Presentation
# fields (links, notes) are left out so the trace does not change when they do.
RECORDED_FIELDS = (
    "id",
    "key",
    "commandType",
    "intent",
    "status",
    "params",
    "error",
    "createdAt",
    "startedAt",
    "completedAt",
)


class CommandTraceError(ValueError):
    """The robot's command list is incomplete or malformed, so no trace is produced."""


def fetch_run_commands(http_get, ot2_base, run_id, page_length=DEFAULT_PAGE_LENGTH):
    """Every command of a run, in the robot's order.

    Reads ``GET {ot2_base}/runs/{runId}/commands`` page by page. The cursor is always
    sent: without it the robot starts from its current command, not the first.
    ``http_get(url, headers)`` returns ``(status, body)``, as ``http_util.http`` does.
    """
    if not isinstance(run_id, str) or not run_id:
        raise CommandTraceError("run_id is required")
    base = f"{ot2_base.rstrip('/')}/runs/{quote(run_id, safe='')}/commands"
    headers = {"opentrons-version": OT2_API_VERSION}
    commands = []
    total = None
    while True:
        cursor = len(commands)
        status, body = http_get(f"{base}?cursor={cursor}&pageLength={page_length}", headers)
        if (
            status != 200
            or not isinstance(body, dict)
            or not isinstance(body.get("data"), list)
            or not isinstance(body.get("meta"), dict)
        ):
            raise CommandTraceError(f"commands page at cursor {cursor}: HTTP {status}, no data/meta")
        length = body["meta"].get("totalLength")
        if isinstance(length, bool) or not isinstance(length, int) or not 0 <= length <= MAX_COMMANDS:
            raise CommandTraceError("the robot reported no usable totalLength")
        if total is None:
            total = length
        elif length != total:
            raise CommandTraceError(f"the run's command count changed while it was read ({total} -> {length})")
        page = body["data"]
        if len(commands) + len(page) > total:
            raise CommandTraceError(f"the robot returned more commands than its totalLength {total}")
        commands.extend(page)
        if len(commands) == total:
            break
        if not page:
            raise CommandTraceError(f"the robot returned {len(commands)} of {total} commands")

    ids = [c.get("id") if isinstance(c, dict) else None for c in commands]
    if len(set(ids)) != len(ids):
        raise CommandTraceError("the command list repeats a command id")
    return commands


def command_log_line(command):
    """The canonical JSON text of one command's recorded fields: the chain's ``rawContent``."""
    if not isinstance(command, dict):
        raise CommandTraceError("a command is not an object")
    for field in ("id", "commandType"):
        value = command.get(field)
        if not isinstance(value, str) or not value:
            raise CommandTraceError(f"a command has no {field}")
    return canonicalize({k: command[k] for k in RECORDED_FIELDS if k in command})


def hash_event(event):
    """``hashEvent`` from packages/spec/src/util/canonical.ts."""
    return sha256_hex(
        canonicalize(
            {
                "type": event["type"],
                "timestamp": event["timestamp"],
                "source": event["source"],
                "payload": event["payload"],
            }
        )
    )


def hash_bundle(events):
    """``hashBundle`` from packages/spec/src/util/canonical.ts: the sorted event hashes."""
    return sha256_hex(canonicalize(sorted(e["hash"] for e in events)))


def build_command_trace_events(
    commands, capture, *, job_id, kernel_id, device_id, protocol_hash, run_id
):
    """One chained, kernel-signed ``log_hash_chain_entry`` event per command.

    ``capture`` is a fresh :class:`~pcc_node.log_capture.LogCapture` for this run (its
    chain starts at GENESIS) holding the node's Ed25519 key. ``protocol_hash`` is the
    content hash of the protocol the job committed to.
    """
    for name, value in (
        ("job_id", job_id),
        ("kernel_id", kernel_id),
        ("device_id", device_id),
        ("protocol_hash", protocol_hash),
        ("run_id", run_id),
    ):
        if not isinstance(value, str) or not value:
            raise CommandTraceError(f"{name} is required")
    if not commands:
        raise CommandTraceError("a run with no commands has no trace")

    source = f"opentrons-run:{run_id}"
    events = []
    for command in commands:
        raw = command_log_line(command)
        captured_at = command.get("completedAt") or command.get("createdAt")
        if not isinstance(captured_at, str) or not captured_at:
            raise CommandTraceError(f"command {command['id']} has no completedAt or createdAt")
        entry = capture.capture(
            raw_content=raw,
            source=source,
            captured_at=captured_at,
            entry_id=command["id"],
            redacted=False,
        )
        payload = dict(entry["payload"])
        payload.update(
            {
                "jobId": job_id,
                "kernelId": kernel_id,
                "protocolHash": protocol_hash,
                "logKind": LOG_KIND,
                "runId": run_id,
            }
        )
        event = {
            "type": EVENT_TYPE,
            "timestamp": entry["timestamp"],
            "source": {"kernelId": kernel_id, "deviceId": device_id},
            "payload": payload,
        }
        event["hash"] = hash_event(event)
        events.append(event)
    return events
