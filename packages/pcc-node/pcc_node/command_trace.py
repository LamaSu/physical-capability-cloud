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
  event commits ``payload.jobId``, ``payload.kernelId`` and ``payload.protocolHash``
  (and ``settlementUnitId`` / ``challengeNonce`` when the gateway assigned them), its
  ``source.kernelId`` is the kernel that accepted the job, and it carries its own
  ``hash`` (``hashEvent``: sha256 over the canonical ``{type, timestamp, source,
  payload}``), so a bundle of these events binds to exactly one job;
* the public ``EvidenceEvent`` contract (``EvidenceEventSchema`` in @pcc/spec): every
  event has an ``id`` (``<opentronsRunId>:<commandId>``, unique per run) and a
  ``source.deviceType``, the one the kernel's Opentrons adapter reports.

``payload.jobId`` is always the PCC job id (evidence's reserved-field rule, bus #3219).
The robot's own run id travels as ``payload.opentronsRunId``.

This is a pure producer. Fetching is injected, and nothing here signs a bundle or talks
to the gateway. Input that is incomplete fails closed with :class:`CommandTraceError`:
a page that stops before the robot's own ``totalLength``, a command without an id or
a type, or a duplicate id. A trace that silently drops commands would prove a run the
robot did not perform.

Each entry is timed by the command's ``completedAt``. A command that never completed
(the run stopped first) is timed by the run's own end, which the caller passes as
``run_ended_at`` and which may not be earlier than any completion, so the chain's
``capturedAt`` never runs backwards for it. Its ``createdAt`` stays in ``rawContent``.
"""

import re
from datetime import datetime
from urllib.parse import quote

from .log_capture import canonicalize, sha256_hex

LOG_KIND = "command_trace"
EVENT_TYPE = "log_hash_chain_entry"
# The deviceType the kernel's Opentrons adapter reports (packages/kernel/src/opentrons/
# adapter.ts), so both runtimes name the robot the same way in EvidenceSource.
DEVICE_TYPE = "instrument"
OT2_API_VERSION = "2"
DEFAULT_PAGE_LENGTH = 200
MAX_COMMANDS = 100_000
# LO-EV-9 unit fields: 0x + 64 lowercase hex (a bytes32), as the gateway issues them.
_UNIT_FIELD = re.compile(r"^0x[0-9a-f]{64}$")

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


def _instant(value, what):
    """An aware datetime from an ISO-8601 time as the robot reports it ("Z" allowed)."""
    if not isinstance(value, str) or not value:
        raise CommandTraceError(f"{what} is not a timestamp")
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        instant = datetime.fromisoformat(text)
    except ValueError:
        raise CommandTraceError(f"{what} is not an ISO-8601 time: {value!r}") from None
    if instant.tzinfo is None:
        raise CommandTraceError(f"{what} has no time zone: {value!r}")
    return instant


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
    commands,
    capture,
    *,
    job_id,
    kernel_id,
    device_id,
    protocol_hash,
    run_id,
    settlement_unit_id=None,
    challenge_nonce=None,
    run_ended_at=None,
):
    """One chained, kernel-signed ``log_hash_chain_entry`` event per command.

    ``capture`` is a fresh :class:`~pcc_node.log_capture.LogCapture` for this run (its
    chain starts at GENESIS) holding the node's Ed25519 key. ``protocol_hash`` is the
    content hash of the protocol the job committed to. ``run_id`` is the robot's run id.
    ``settlement_unit_id`` and ``challenge_nonce``, when the gateway issued them for the
    unit being settled, are stamped on every event, as LO-EV-9 requires.
    ``run_ended_at`` is the run's own ``completedAt`` (``GET /runs/{runId}``). It is
    required when a command never completed, and times that command's entry.
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
    for name, value in (("settlement_unit_id", settlement_unit_id), ("challenge_nonce", challenge_nonce)):
        if value is not None and not (isinstance(value, str) and _UNIT_FIELD.match(value)):
            raise CommandTraceError(f"{name} must be 0x + 64 lowercase hex")
    if not commands:
        raise CommandTraceError("a run with no commands has no trace")
    completions = [
        _instant(c["completedAt"], f"command {c.get('id')!r} completedAt")
        for c in commands
        if isinstance(c, dict) and c.get("completedAt") is not None
    ]
    if run_ended_at is not None:
        ended = _instant(run_ended_at, "run_ended_at")
        if completions and ended < max(completions):
            raise CommandTraceError("run_ended_at is earlier than a command's completedAt")
    binding = {
        "jobId": job_id,
        "kernelId": kernel_id,
        "protocolHash": protocol_hash,
        "logKind": LOG_KIND,
        "opentronsRunId": run_id,
    }
    if settlement_unit_id is not None:
        binding["settlementUnitId"] = settlement_unit_id
    if challenge_nonce is not None:
        binding["challengeNonce"] = challenge_nonce

    source = f"opentrons-run:{run_id}"
    events = []
    for command in commands:
        raw = command_log_line(command)
        captured_at = command.get("completedAt")
        if captured_at is None:
            if run_ended_at is None:
                raise CommandTraceError(
                    f"command {command['id']} never completed; pass run_ended_at, the run's own completedAt"
                )
            captured_at = run_ended_at
        entry = capture.capture(
            raw_content=raw,
            source=source,
            captured_at=captured_at,
            entry_id=command["id"],
            redacted=False,
        )
        payload = dict(entry["payload"])
        payload.update(binding)
        event = {
            "id": f"{run_id}:{command['id']}",
            "type": EVENT_TYPE,
            "timestamp": entry["timestamp"],
            "source": {"kernelId": kernel_id, "deviceId": device_id, "deviceType": DEVICE_TYPE},
            "payload": payload,
        }
        event["hash"] = hash_event(event)
        events.append(event)
    return events
