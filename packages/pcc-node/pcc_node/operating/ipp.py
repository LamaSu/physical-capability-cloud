"""The IPP wire format pcc-node reads a print job's own state with (RFC 8010 encoding, RFC 8011 semantics).

Ported from #377 (fix/pcc-node-completion-pollers @67875cd1, r31 rounds 1 to 3). There it read the
state of a job ``lp`` had spooled, once per daemon cycle. On master a device runs only through the
operating agent's typed operations, so the same reader serves the operating runtime for IPP
printers. Everything here is pure: bytes in, bytes or a verdict out, no I/O.

A job is read as COMPLETED only when ALL of these hold (RFC 8011 B.1.2.1: "The transition of the
Job object into the 'completed' state is the only indicator that the Job has been printed"):

* the HTTP status is 200 (RFC 8010 sec 3.4.3: only a 200 carries an IPP answer);
* the answer is well-formed IPP/1.x or IPP/2.x, echoes our request-id and has a successful
  status-code;
* its one Job Attributes group names exactly one job-id, equal to the job we asked about: the
  printer's own execution id for THIS job (r31 round-1 finding 2);
* its job-state is exactly one enum, 9 ('completed');
* its job-state-reasons is well-formed (RFC 8011 sec 5.1.4 keywords, r31 round-2 finding 4) and
  says the job finished cleanly.

Canceled (7) and aborted (8), and a 'completed' qualified by errors or by a stop, are FAILED.
'queued-in-device', or any reason that does not establish a clean completion, is UNOBSERVABLE:
the outcome is not known and never will be. Everything else (states 3 to 6, an unknown or
unreadable state, an error status-code, a request-id or job-id that is not ours, a malformed
answer, a transport failure) is WAITING. Fail closed: an outcome that was not observed is never
a completion.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

# Verdict of ONE completion check.
POLL_COMPLETED = "completed"      # the printer reported the job finished cleanly
POLL_FAILED = "failed"            # the printer reported a terminal failure
POLL_WAITING = "waiting"          # not finished, or not (yet) readable
# The printer says it can NEVER report the outcome (IPP 'queued-in-device', RFC 8011 sec 5.3.8),
# or reports a combination that does not establish a clean completion.
POLL_UNOBSERVABLE = "unobservable"

IPP_REQUEST_VERSION = b"\x02\x00"              # IPP/2.0
IPP_OPERATION_GET_JOB_ATTRIBUTES = 0x0009      # RFC 8011 sec 4.3.4
IPP_INT_MAX = 2 ** 31 - 1                      # integer(1:MAX); request-id range

# Delimiter tags are 0x00-0x0f, value tags 0x10-0xff (RFC 8010 sec 3.5).
IPP_TAG_OPERATION_ATTRIBUTES = 0x01
IPP_TAG_JOB_ATTRIBUTES = 0x02
IPP_TAG_END_OF_ATTRIBUTES = 0x03
IPP_DELIMITER_TAG_MAX = 0x0F

IPP_VALUE_INTEGER = 0x21
IPP_VALUE_ENUM = 0x23
IPP_VALUE_KEYWORD = 0x44
IPP_VALUE_URI = 0x45
IPP_VALUE_CHARSET = 0x47
IPP_VALUE_NATURAL_LANGUAGE = 0x48

# RFC 8011 appendix B.1.2: 0x0000-0x00FF is the "successful" class.
IPP_STATUS_SUCCESS_MAX = 0x00FF

# job-state (type1 enum), RFC 8011 sec 5.3.7 table 15.
IPP_JOB_STATE_NAMES = {
    3: "pending",
    4: "pending-held",
    5: "processing",
    6: "processing-stopped",
    7: "canceled",
    8: "aborted",
    9: "completed",
}
IPP_JOB_STATES_COMPLETED = frozenset({9})
IPP_JOB_STATES_FAILED = frozenset({7, 8})
IPP_JOB_STATES_NOT_COMPLETED = frozenset({3, 4, 5, 6})   # sec 5.3.7.2

# job-state-reasons (sec 5.3.8) that change what 'completed' means:
# * 'queued-in-device': a gateway handed the job to a device that cannot report status; it says
#   'completed' and "never will have any better information".
# * '...completed-with-errors': the device finished, and reports errors. (Table 15 spells these
#   without the 'job-' prefix; sec 5.3.8 with it.)
IPP_REASON_QUEUED_IN_DEVICE = "queued-in-device"
IPP_REASONS_COMPLETED_WITH_ERRORS = frozenset({
    "job-completed-with-errors", "completed-with-errors",
})
# Reasons that contradict a plain 'completed': the job was canceled or aborted, or is being stopped
# (sec 5.3.8). With state 9 they are a failure.
IPP_REASONS_STOPPED = frozenset({
    "job-canceled-by-user", "job-canceled-by-operator", "job-canceled-at-device",
    "aborted-by-system", "processing-to-stop-point",
})
# The ONLY reasons that let state 9 read as a clean completion (r31 round-2 finding 4): 'none' (no
# reason applies), 'job-completed-successfully', and 'job-restartable', which says only that the
# finished job is retained and could be restarted (sec 5.3.7.2). Any other reason with state 9 --
# 'job-completed-with-warnings', a processing reason such as 'job-printing' that contradicts it, a
# vendor keyword -- cannot establish that this job printed cleanly: UNOBSERVABLE, never COMPLETED.
# 'none' must also stand alone (pack 77 H3): beside another reason it contradicts itself.
IPP_REASON_NONE = "none"
IPP_REASONS_COMPLETED_OK = frozenset({
    IPP_REASON_NONE, "job-completed-successfully", "job-restartable",
})
# RFC 8011 sec 5.1.4: a keyword is 1 to 255 US-ASCII lowercase letters, digits, "-", "." and "_",
# and its first character is a lowercase letter. Matched with fullmatch, so a trailing newline is
# refused too.
_IPP_KEYWORD = re.compile(r"[a-z][a-z0-9._-]{0,254}")


class IppDecodeError(ValueError):
    """The bytes are not a well-formed IPP response (RFC 8010 sec 3)."""


def _short(text: str, limit: int = 200) -> str:
    return text if len(text) <= limit else text[:limit] + "..."


def _i16(value: int) -> bytes:
    """SIGNED-SHORT, big-endian (RFC 8010 sec 3.1)."""
    return value.to_bytes(2, "big", signed=True)


def _i32(value: int) -> bytes:
    """SIGNED-INTEGER, big-endian (RFC 8010 sec 3.1)."""
    return value.to_bytes(4, "big", signed=True)


def _ipp_value(value_tag: int, name: bytes, value: bytes) -> bytes:
    """attribute-with-one-value, or additional-value when ``name`` is empty (RFC 8010 secs 3.1.4 and
    3.1.5). Lengths are SIGNED-SHORT, big-endian."""
    return bytes((value_tag,)) + _i16(len(name)) + name + _i16(len(value)) + value


def _check_id(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= IPP_INT_MAX:
        raise ValueError(f"{what} out of range: {value!r}")
    return value


def encode_get_job_attributes(printer_uri: str, job_id: int, request_id: int) -> bytes:
    """Encode an IPP/2.0 Get-Job-Attributes request (RFC 8010 / RFC 8011).

    Operation attributes in the order RFC 8011 secs 4.1.4-4.1.5 require: attributes-charset,
    attributes-natural-language, printer-uri, job-id -- then requested-attributes = job-id,
    job-state, job-state-reasons. The job-id comes back so the verdict can check the answer is about
    THIS job (r31 round-1 finding 2); the reasons ride along because 'completed' alone can mean
    "handed to a device that cannot report" or "finished with errors" (see
    IPP_REASON_QUEUED_IN_DEVICE).
    """
    _check_id(job_id, "job-id")
    _check_id(request_id, "request-id")
    return b"".join((
        IPP_REQUEST_VERSION,
        _i16(IPP_OPERATION_GET_JOB_ATTRIBUTES),
        _i32(request_id),
        bytes((IPP_TAG_OPERATION_ATTRIBUTES,)),
        _ipp_value(IPP_VALUE_CHARSET, b"attributes-charset", b"utf-8"),
        _ipp_value(IPP_VALUE_NATURAL_LANGUAGE, b"attributes-natural-language", b"en"),
        _ipp_value(IPP_VALUE_URI, b"printer-uri", printer_uri.encode("ascii")),
        _ipp_value(IPP_VALUE_INTEGER, b"job-id", _i32(job_id)),
        _ipp_value(IPP_VALUE_KEYWORD, b"requested-attributes", b"job-id"),
        _ipp_value(IPP_VALUE_KEYWORD, b"", b"job-state"),
        _ipp_value(IPP_VALUE_KEYWORD, b"", b"job-state-reasons"),
        bytes((IPP_TAG_END_OF_ATTRIBUTES,)),
    ))


def _ipp_read_length(data: bytes, pos: int, what: str) -> Tuple[int, int]:
    """A SIGNED-SHORT length at ``pos``; returns ``(length, next_pos)``."""
    if pos + 2 > len(data):
        raise IppDecodeError(f"truncated in {what}")
    length = int.from_bytes(data[pos:pos + 2], "big", signed=True)
    if length < 0:
        raise IppDecodeError(f"negative {what}: {length}")
    return length, pos + 2


def decode_ipp_response(data: Any) -> Dict[str, Any]:
    """Parse an IPP response (RFC 8010 sec 3). Pure; raises IppDecodeError.

    Returns ``{"version": (major, minor), "statusCode": int, "requestId": int, "groups": [{"tag":
    int, "attributes": [{"name": str, "values": [(value_tag, bytes), ...]}]}]}``. Values are walked by
    length whatever their tag, so a collection is a flat run of values and never a job-state.
    Truncation, a missing end-of-attributes-tag, an attribute outside a group and an
    additional-value with no attribute before it are all malformed. Bytes after the
    end-of-attributes-tag (document data) are not read.
    """
    if not isinstance(data, (bytes, bytearray)):
        raise IppDecodeError(f"expected bytes, got {type(data).__name__}")
    data = bytes(data)
    if len(data) < 8:
        raise IppDecodeError(f"truncated header ({len(data)} bytes)")
    status_code = int.from_bytes(data[2:4], "big")
    request_id = int.from_bytes(data[4:8], "big", signed=True)
    groups: List[Dict[str, Any]] = []
    pos = 8
    while True:
        if pos >= len(data):
            raise IppDecodeError("no end-of-attributes-tag")
        tag = data[pos]
        pos += 1
        if tag == IPP_TAG_END_OF_ATTRIBUTES:
            break
        if tag <= IPP_DELIMITER_TAG_MAX:
            groups.append({"tag": tag, "attributes": []})
            continue
        if not groups:
            raise IppDecodeError("attribute before any attribute group")
        name_len, pos = _ipp_read_length(data, pos, "name-length")
        if pos + name_len > len(data):
            raise IppDecodeError("truncated in name")
        name = data[pos:pos + name_len].decode("ascii", errors="replace")
        pos += name_len
        value_len, pos = _ipp_read_length(data, pos, "value-length")
        if pos + value_len > len(data):
            raise IppDecodeError("truncated in value")
        value = data[pos:pos + value_len]
        pos += value_len
        attributes = groups[-1]["attributes"]
        if name_len == 0:
            if not attributes:
                raise IppDecodeError("additional-value with no attribute before it")
            attributes[-1]["values"].append((tag, value))
        else:
            attributes.append({"name": name, "values": [(tag, value)]})
    return {
        "version": (data[0], data[1]),
        "statusCode": status_code,
        "requestId": request_id,
        "groups": groups,
    }


def _groups(response: Dict[str, Any], tag: int) -> List[Dict[str, Any]]:
    return [g for g in response["groups"] if g["tag"] == tag]


def ipp_job_state(response: Dict[str, Any]) -> Tuple[Optional[int], List[str], str]:
    """``(job_state, job_state_reasons, problem)`` from a decoded response.

    Read ONLY from the one Job Attributes group (tag 0x02) a Get-Job-Attributes response carries
    (RFC 8011 sec 4.3.4.2): the same keyword echoed in the Unsupported group, or anything in the
    Operation group, is not the job's state. ``job_state`` is None -- with ``problem`` saying why --
    unless there is exactly one job-state holding exactly one 4-octet enum. An out-of-band value
    (RFC 8011 sec 5.1 'unknown') is therefore None too. The reasons returned here are only for the
    observation; :func:`ipp_job_state_reasons` is the strict reader a verdict uses.
    """
    job_groups = _groups(response, IPP_TAG_JOB_ATTRIBUTES)
    if len(job_groups) != 1:
        return None, [], f"{len(job_groups)} job attribute groups (expected 1)"
    attributes = job_groups[0]["attributes"]

    reasons: List[str] = []
    for attribute in attributes:
        if attribute["name"] == "job-state-reasons":
            reasons.extend(
                value.decode("ascii", errors="replace")
                for value_tag, value in attribute["values"]
                if value_tag == IPP_VALUE_KEYWORD
            )

    states = [a for a in attributes if a["name"] == "job-state"]
    if len(states) != 1:
        return None, reasons, f"{len(states)} job-state attributes (expected 1)"
    values = states[0]["values"]
    if len(values) != 1:
        return None, reasons, f"job-state has {len(values)} values (expected 1)"
    value_tag, value = values[0]
    if value_tag != IPP_VALUE_ENUM or len(value) != 4:
        return None, reasons, (
            f"job-state is not a 4-octet enum (tag 0x{value_tag:02x}, {len(value)} octets)"
        )
    return int.from_bytes(value, "big", signed=True), reasons, ""


def _single_attribute(response: Dict[str, Any], group_tag: int, group_name: str,
                      name: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """The one attribute called ``name`` in the one attribute group tagged ``group_tag``."""
    groups = _groups(response, group_tag)
    if len(groups) != 1:
        return None, f"{len(groups)} {group_name} attribute groups (expected 1)"
    found = [a for a in groups[0]["attributes"] if a["name"] == name]
    if len(found) != 1:
        return None, f"{len(found)} {name} attributes (expected 1)"
    return found[0], ""


def ipp_job_id(response: Dict[str, Any]) -> Tuple[Optional[int], str]:
    """The job-id an answer is about: exactly one integer(1:MAX), else None + why."""
    attribute, problem = _single_attribute(response, IPP_TAG_JOB_ATTRIBUTES, "job", "job-id")
    if attribute is None:
        return None, problem
    values = attribute["values"]
    if len(values) != 1:
        return None, f"job-id has {len(values)} values (expected 1)"
    value_tag, value = values[0]
    if value_tag != IPP_VALUE_INTEGER or len(value) != 4:
        return None, f"job-id is not a 4-octet integer (tag 0x{value_tag:02x}, {len(value)} octets)"
    job_id = int.from_bytes(value, "big", signed=True)
    if not 1 <= job_id <= IPP_INT_MAX:
        return None, f"job-id {job_id} is out of range"
    return job_id, ""


def ipp_job_state_reasons(response: Dict[str, Any]) -> Tuple[Optional[List[str]], str]:
    """job-state-reasons read strictly (RFC 8011 sec 5.3.8: REQUIRED, and 'none' when no reason
    applies): exactly one attribute whose every value is keyword-tagged and has keyword syntax (sec
    5.1.4, :data:`_IPP_KEYWORD`). ONE malformed value makes the whole attribute unusable (r31 round-2
    finding 4): ``" "`` or ``"job-completed-with-errors "`` is not a reason this reader could match
    against the error set, so it is never read past. None + why otherwise."""
    attribute, problem = _single_attribute(response, IPP_TAG_JOB_ATTRIBUTES, "job", "job-state-reasons")
    if attribute is None:
        return None, problem
    reasons: List[str] = []
    for value_tag, value in attribute["values"]:
        if value_tag != IPP_VALUE_KEYWORD:
            return None, f"a job-state-reasons value is not a keyword (tag 0x{value_tag:02x})"
        keyword = value.decode("ascii", errors="replace")
        if not _IPP_KEYWORD.fullmatch(keyword):
            return None, f"job-state-reasons value {keyword[:64]!r} is not an RFC 8011 keyword"
        reasons.append(keyword)
    if not reasons:
        return None, "job-state-reasons has no values"
    return reasons, ""


def _answer_problem(http_status: Any, body: Any, request_id: int, observation: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    """Decode an answer to OUR request: ``(response, "")``, or ``(None, why)``.

    Only an HTTP 200 carries an IPP answer (RFC 8010 sec 3.4.3); the answer must be well-formed
    IPP/1.x or IPP/2.x, echo our request-id and carry a successful status-code. Fills the
    observation's ``ippVersion`` and ``ippStatusCode`` as it goes.
    """
    if http_status != 200:
        if isinstance(http_status, bool) or not isinstance(http_status, int) or http_status <= 0:
            return None, "transport failure: printer unreachable"
        return None, f"HTTP {http_status} (no IPP answer)"
    try:
        response = decode_ipp_response(body)
    except IppDecodeError as exc:
        return None, f"malformed IPP response: {exc}"
    observation["ippVersion"] = "%d.%d" % response["version"]
    observation["ippStatusCode"] = "0x%04x" % response["statusCode"]
    if response["version"][0] not in (1, 2):
        return None, "not an IPP/1.x or IPP/2.x response"
    if response["requestId"] != request_id:
        return None, f"request-id {response['requestId']} is not ours ({request_id})"
    if response["statusCode"] > IPP_STATUS_SUCCESS_MAX:
        return None, f"IPP status-code {observation['ippStatusCode']} is not a success"
    return response, ""


def ipp_completion_verdict(http_status: Any, body: Any, request_id: int, job_id: int) -> Tuple[str, Dict[str, Any]]:
    """Verdict for one Get-Job-Attributes exchange about the printer's job ``job_id``.

    Pure; never raises. Returns ``(verdict, observation)``.

    No terminal verdict without proof the answer is about THIS job (r31 round-1 finding 2): exactly
    one integer job-id equal to ``job_id``, else WAITING. For job-state 9, job-state-reasons must be
    well-formed (:func:`ipp_job_state_reasons`); missing, duplicated or malformed reasons -> WAITING.
    Then 'queued-in-device' -> UNOBSERVABLE; errors, cancellation or abort -> FAILED; 'none' beside
    any other reason -> UNOBSERVABLE (pack 77 H3: it contradicts itself); any other reason outside
    :data:`IPP_REASONS_COMPLETED_OK` -> UNOBSERVABLE (r31 round-2 finding 4: the combination does
    not establish a clean completion); and COMPLETED only when every reason is in that allowlist. FAILED for 7 canceled / 8 aborted. Everything else -- 3-6, an unknown or
    unreadable state, a non-success IPP status-code (e.g. 0x0406 not-found: the job may have been
    purged), a request-id that is not ours, a malformed body, a non-200 HTTP status (RFC 8010 sec
    3.4.3) or a transport failure (status 0) -- is WAITING.
    """
    observation: Dict[str, Any] = {"httpStatus": http_status}
    response, problem = _answer_problem(http_status, body, request_id, observation)
    if response is None:
        observation["reason"] = problem
        return POLL_WAITING, observation

    state, reasons, problem = ipp_job_state(response)
    observation["jobStateCode"] = state
    observation["jobState"] = IPP_JOB_STATE_NAMES.get(state) if state is not None else None
    observation["jobStateReasons"] = reasons

    reported_job_id, id_problem = ipp_job_id(response)
    observation["reportedJobId"] = reported_job_id
    if reported_job_id is None:
        observation["reason"] = f"the answer names no usable job-id: {id_problem}"
        return POLL_WAITING, observation
    if reported_job_id != job_id:
        observation["reason"] = f"the answer is about job {reported_job_id}, not our job {job_id}"
        return POLL_WAITING, observation

    if state is None:
        observation["reason"] = f"no readable job-state: {problem}"
        return POLL_WAITING, observation

    name = IPP_JOB_STATE_NAMES.get(state, str(state))
    if state in IPP_JOB_STATES_COMPLETED:
        strict_reasons, reasons_problem = ipp_job_state_reasons(response)
        if strict_reasons is None:
            observation["reason"] = (
                f"job-state completed, but job-state-reasons is unusable ({reasons_problem}); "
                "RFC 8011 requires it, so the completion cannot be read"
            )
            return POLL_WAITING, observation
        if IPP_REASON_QUEUED_IN_DEVICE in strict_reasons:
            observation["reason"] = (
                "job-state completed with 'queued-in-device': the job was handed to a device that "
                "cannot report its outcome"
            )
            return POLL_UNOBSERVABLE, observation
        errors = sorted(IPP_REASONS_COMPLETED_WITH_ERRORS.intersection(strict_reasons))
        if errors:
            observation["reason"] = f"job-state completed with errors ({', '.join(errors)})"
            return POLL_FAILED, observation
        stopped = sorted(IPP_REASONS_STOPPED.intersection(strict_reasons))
        if stopped:
            observation["reason"] = f"job-state completed, but the printer also reports {', '.join(stopped)}"
            return POLL_FAILED, observation
        if IPP_REASON_NONE in strict_reasons and len(strict_reasons) != 1:
            # Pack 77 H3 (astra, 67875cd1): 'none' says no reason applies, so beside any other value,
            # 'job-completed-successfully' included, the answer contradicts itself.
            observation["reason"] = (
                f"job-state completed with 'none' beside other reasons ({_short(', '.join(strict_reasons))}): "
                "'none' means no reason applies, so the answer contradicts itself"
            )
            return POLL_UNOBSERVABLE, observation
        unexpected = sorted(set(strict_reasons) - IPP_REASONS_COMPLETED_OK)
        if unexpected:
            observation["reason"] = (
                f"job-state completed with {_short(', '.join(unexpected))}: not a clean completion "
                "(only none, job-completed-successfully and job-restartable are)"
            )
            return POLL_UNOBSERVABLE, observation
        observation["reason"] = f"job-state completed ({', '.join(strict_reasons)})"
        return POLL_COMPLETED, observation
    if state in IPP_JOB_STATES_FAILED:
        observation["reason"] = f"job-state {name}"
        return POLL_FAILED, observation
    if state in IPP_JOB_STATES_NOT_COMPLETED:
        observation["reason"] = f"job-state {name}"
        return POLL_WAITING, observation
    observation["reason"] = f"unrecognised job-state {state}"
    return POLL_WAITING, observation
