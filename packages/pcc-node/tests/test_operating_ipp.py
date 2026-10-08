"""The IPP reader (pcc_node.operating.ipp): no completion that the printer did not report for THIS job.

Ported from #377 (fix/pcc-node-completion-pollers @67875cd1): the codec and verdict classes of
tests/test_completion_pollers.py (request encoding, response decoding, job-id correlation, reasons at
state 9), the IPP classes of tests/test_r31_round2.py (finding 2) and tests/test_r31_round3.py
(round-2 finding 4, "H4"). The tests that drove #377's lp adapter, its in-memory registry and the
daemon's poll_awaiting hook have no counterpart on master; the runtime that follows a job here is
tested in test_operating_ipp_runtime.py.

Every canned answer is built by hand from RFC 8010 (ipp_response below), and the builder is pinned
byte for byte to an answer captured from a real cupsd.
"""

import pytest

from pcc_node.operating.ipp import (
    IPP_REASONS_STOPPED,
    POLL_COMPLETED,
    POLL_FAILED,
    POLL_UNOBSERVABLE,
    POLL_WAITING,
    IppDecodeError,
    decode_ipp_response,
    encode_get_job_attributes,
    encode_get_printer_attributes,
    encode_print_job,
    ipp_completion_verdict,
    ipp_job_state,
    print_job_answer,
    printer_is_idle,
)


# ---------------------------------------------------------------------------
# IPP wire helpers (independent of the module under test)
# ---------------------------------------------------------------------------

def ipp_attr(value_tag, name, value):
    """RFC 8010 sec 3.1.4 / 3.1.5, written out by hand: tag, name-length, name, value-length, value --
    an additional-value when name is b""."""
    return (
        bytes([value_tag])
        + len(name).to_bytes(2, "big") + name
        + len(value).to_bytes(2, "big") + value
    )


def ipp_response(job_state=None, reasons=None, status=0x0000, request_id=1,
                 version=b"\x02\x00", job_group=True, extra=b"",
                 job_state_tag=0x23, job_state_value=None,
                 job_id=42, job_id_tag=0x21, job_id_value=None, duplicate_job_id=False,
                 reasons_value_tag=0x44, duplicate_reasons=False):
    """A Get-Job-Attributes response: operation group, then a job group.

    ``job_id`` defaults to 42, the job asked about: a conformant printer echoes the id it was asked
    about (r31 round-1 finding 2). ``job_id=None`` omits the attribute; ``duplicate_job_id=True``
    repeats it.

    ``reasons`` defaults to ``("none",)``: RFC 8011 sec 5.3.8 REQUIRES job-state-reasons, using the
    keyword 'none' when nothing applies, so a conformant printer always sends it. ``reasons=()``
    omits the attribute entirely (a non-conformant printer); ``duplicate_reasons=True`` repeats the
    whole attribute. A reason may be bytes, to inject a value that is not ASCII.
    """
    out = version + status.to_bytes(2, "big") + request_id.to_bytes(4, "big", signed=True)
    out += b"\x01"
    out += ipp_attr(0x47, b"attributes-charset", b"utf-8")
    out += ipp_attr(0x48, b"attributes-natural-language", b"en")
    if job_group:
        out += b"\x02"
        if job_state is not None or job_state_value is not None:
            value = (job_state_value if job_state_value is not None
                     else job_state.to_bytes(4, "big", signed=True))
            out += ipp_attr(job_state_tag, b"job-state", value)
        if job_id is not None or job_id_value is not None:
            value = job_id_value if job_id_value is not None else job_id.to_bytes(4, "big", signed=True)
            out += ipp_attr(job_id_tag, b"job-id", value)
            if duplicate_job_id:
                out += ipp_attr(job_id_tag, b"job-id", value)
        actual_reasons = ("none",) if reasons is None else reasons
        for i, reason in enumerate(actual_reasons):
            name = b"job-state-reasons" if i == 0 else b""
            out += ipp_attr(reasons_value_tag, name, reason if isinstance(reason, bytes) else reason.encode())
        if duplicate_reasons and actual_reasons:
            out += ipp_attr(reasons_value_tag, b"job-state-reasons", actual_reasons[0].encode())
    return out + extra + b"\x03"


# Captured by #377 from the Spark's own cupsd (cups-daemon 2.4.7) with its client: a READ-ONLY
# Get-Job-Attributes (request-id 7) on an existing job of this user that had been canceled. No print
# job was created. CUPS returned exactly the two requested attributes: job-state 7 and
# job-state-reasons. (Captured before r31 round-1 finding 2's fix started requesting job-id, so it
# has none.)
CUPS_CANCELED_JOB_RESPONSE = bytes.fromhex(
    "020000000000000701470012617474726962757465732d63686172736574000575"
    "74662d3848001b617474726962757465732d6e61747572616c2d6c616e67756167"
    "650002656e022300096a6f622d73746174650004000000074400116a6f622d7374"
    "6174652d726561736f6e73001870726f63657373696e672d746f2d73746f702d70"
    "6f696e7403"
)


# ---------------------------------------------------------------------------
# Get-Job-Attributes request: exact bytes (RFC 8010 sec 3, RFC 8011 sec 4.3.4)
# ---------------------------------------------------------------------------

class TestIppRequestEncoding:
    PRINTER_URI = "ipp://10.0.0.1:631/printers/default"

    # Written out field by field from RFC 8010 sec 3.1 (figures 1-5) and the RFC 8011 sec
    # 4.1.4/4.1.5 attribute order -- NOT produced by the encoder. requested-attributes asks for
    # job-id, job-state and job-state-reasons (r31 round-1 finding 2): the job-id lets the verdict
    # confirm an answer is about THIS job; the reasons qualify a 'completed' state.
    EXPECTED = (
        b"\x02\x00"                                   # version-number 2.0
        b"\x00\x09"                                   # operation-id Get-Job-Attributes
        b"\x00\x00\x00\x07"                           # request-id 7
        b"\x01"                                       # operation-attributes-tag
        b"\x47" b"\x00\x12" b"attributes-charset" b"\x00\x05" b"utf-8"
        b"\x48" b"\x00\x1b" b"attributes-natural-language" b"\x00\x02" b"en"
        b"\x45" b"\x00\x0b" b"printer-uri" b"\x00\x23" b"ipp://10.0.0.1:631/printers/default"
        b"\x21" b"\x00\x06" b"job-id" b"\x00\x04" b"\x00\x00\x00\x2a"
        b"\x44" b"\x00\x14" b"requested-attributes" b"\x00\x06" b"job-id"
        b"\x44" b"\x00\x00" b"\x00\x09" b"job-state"            # additional-value
        b"\x44" b"\x00\x00" b"\x00\x11" b"job-state-reasons"    # additional-value
        b"\x03"                                       # end-of-attributes-tag
    )

    def test_request_bytes_are_exact(self):
        encoded = encode_get_job_attributes(self.PRINTER_URI, 42, 7)
        assert encoded == self.EXPECTED, f"\nexpected {self.EXPECTED.hex()}\n     got {encoded.hex()}"

    def test_request_decodes_as_the_ordered_operation_group(self):
        """The request is itself well-formed IPP: one operation group, the RFC-mandated order,
        requested-attributes multi-valued (job-id, job-state, job-state-reasons, in that order)."""
        decoded = decode_ipp_response(encode_get_job_attributes(self.PRINTER_URI, 42, 7))
        assert decoded["version"] == (2, 0)
        assert decoded["statusCode"] == 0x0009     # the operation-id sits here in a request
        assert decoded["requestId"] == 7
        [group] = decoded["groups"]
        assert group["tag"] == 0x01
        assert [a["name"] for a in group["attributes"]] == [
            "attributes-charset", "attributes-natural-language",
            "printer-uri", "job-id", "requested-attributes",
        ]
        requested = group["attributes"][-1]["values"]
        assert requested == [(0x44, b"job-id"), (0x44, b"job-state"), (0x44, b"job-state-reasons")]

    @pytest.mark.parametrize("job_id,request_id", [
        (0, 1), (2 ** 31, 1), (1, 0), (1, 2 ** 31), (-5, 1), (True, 1), (1, True), ("42", 1),
    ])
    def test_out_of_range_ids_are_refused(self, job_id, request_id):
        with pytest.raises(ValueError):
            encode_get_job_attributes(self.PRINTER_URI, job_id, request_id)


# ---------------------------------------------------------------------------
# Response decoding and the job-state verdict
# ---------------------------------------------------------------------------

class TestIppResponseDecoding:
    def test_the_test_builder_reproduces_a_real_cups_response_byte_for_byte(self):
        """Every canned response below comes from ipp_response(); this pins it to what a real CUPS
        server actually sent. The real server was not asked for job-id, so the capture has none."""
        assert ipp_response(
            job_state=7, reasons=("processing-to-stop-point",), request_id=7, job_id=None,
        ) == CUPS_CANCELED_JOB_RESPONSE

    def test_a_captured_cups_response_decodes(self):
        decoded = decode_ipp_response(CUPS_CANCELED_JOB_RESPONSE)
        assert decoded["version"] == (2, 0)
        assert decoded["statusCode"] == 0x0000
        assert decoded["requestId"] == 7
        assert [g["tag"] for g in decoded["groups"]] == [0x01, 0x02]
        state, reasons, problem = ipp_job_state(decoded)
        assert (state, reasons, problem) == (7, ["processing-to-stop-point"], "")
        # No terminal verdict without a job-id naming THIS job (r31 round-1 finding 2). This real
        # capture has none, so -- even though its job-state alone says "canceled" -- the verdict
        # refuses to call it, rather than risk doing the same for an answer about someone else's job.
        verdict, observation = ipp_completion_verdict(200, CUPS_CANCELED_JOB_RESPONSE, 7, 42)
        assert verdict == POLL_WAITING
        assert "no usable job-id" in observation["reason"]
        assert observation["jobStateCode"] == 7

    @pytest.mark.parametrize("state,expected", [
        pytest.param(3, POLL_WAITING, id="3-pending"),
        pytest.param(4, POLL_WAITING, id="4-pending-held"),
        pytest.param(5, POLL_WAITING, id="5-processing"),
        pytest.param(6, POLL_WAITING, id="6-processing-stopped"),
        pytest.param(7, POLL_FAILED, id="7-canceled"),
        pytest.param(8, POLL_FAILED, id="8-aborted"),
        pytest.param(9, POLL_COMPLETED, id="9-completed"),
        pytest.param(0, POLL_WAITING, id="0-not-a-state"),
        pytest.param(1, POLL_WAITING, id="1-not-a-state"),
        pytest.param(10, POLL_WAITING, id="10-unknown"),
        pytest.param(-1, POLL_WAITING, id="negative"),
    ])
    def test_each_job_state(self, state, expected):
        verdict, observation = ipp_completion_verdict(200, ipp_response(job_state=state, request_id=11), 11, 42)
        assert verdict == expected, observation
        assert observation["jobStateCode"] == state

    @pytest.mark.parametrize("reasons,expected", [
        pytest.param(("job-completed-successfully",), POLL_COMPLETED, id="successfully"),
        pytest.param(("job-completed-with-warnings",), POLL_UNOBSERVABLE, id="with-warnings"),
        pytest.param(("none",), POLL_COMPLETED, id="none"),
        pytest.param(("job-completed-with-errors",), POLL_FAILED, id="with-errors"),
        pytest.param(("completed-with-errors",), POLL_FAILED, id="with-errors-table-15-spelling"),
        pytest.param(("queued-in-device",), POLL_UNOBSERVABLE, id="queued-in-device"),
        pytest.param(("job-completed-successfully", "queued-in-device"), POLL_UNOBSERVABLE,
                     id="queued-in-device-as-additional-value"),
    ])
    def test_completed_is_qualified_by_its_reasons(self, reasons, expected):
        verdict, observation = ipp_completion_verdict(
            200, ipp_response(job_state=9, reasons=reasons, request_id=3), 3, 42
        )
        assert verdict == expected, observation
        assert observation["jobStateReasons"] == list(reasons)

    @pytest.mark.parametrize("status", [0x0001, 0x0002, 0x00FF])
    def test_every_successful_status_code_is_read(self, status):
        body = ipp_response(job_state=9, status=status, request_id=3)
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_COMPLETED

    @pytest.mark.parametrize("status", [
        pytest.param(0x0100, id="0x0100-just-past-success"),
        pytest.param(0x0400, id="bad-request"),
        pytest.param(0x0406, id="not-found-maybe-purged"),
        pytest.param(0x0500, id="internal-error"),
        pytest.param(0x0503, id="version-not-supported"),
        pytest.param(0xFFFF, id="0xffff"),
    ])
    def test_a_non_success_status_code_is_waiting_even_with_job_state_9(self, status):
        body = ipp_response(job_state=9, status=status, request_id=3)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not a success" in observation["reason"]

    @pytest.mark.parametrize("http_status", [0, -1, 400, 401, 404, 500, 503, None, True])
    def test_a_non_200_http_answer_is_waiting(self, http_status):
        """RFC 8010 sec 3.4.3: only an HTTP 200 carries an IPP status-code."""
        body = ipp_response(job_state=9, request_id=3)
        assert ipp_completion_verdict(http_status, body, 3, 42)[0] == POLL_WAITING

    def test_a_request_id_that_is_not_ours_is_waiting(self):
        body = ipp_response(job_state=9, request_id=4)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not ours" in observation["reason"]

    @pytest.mark.parametrize("version", [b"\x00\x00", b"\x03\x00", b"\x3c\x68"])
    def test_a_response_that_is_not_ipp_1_or_2_is_waiting(self, version):
        body = ipp_response(job_state=9, request_id=3, version=version)
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_WAITING

    def test_ipp_1_1_responses_are_read(self):
        body = ipp_response(job_state=9, request_id=3, version=b"\x01\x01")
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_COMPLETED

    # --- where job-state may be read from --------------------------------

    def test_job_state_only_in_the_unsupported_group_is_not_the_jobs_state(self):
        """RFC 8011 sec 4.3.4.2: requested keywords the printer does not support may be echoed in the
        Unsupported group (0x05), which is not the job's own state -- even with a valid, correlated
        job-id."""
        body = ipp_response(
            request_id=3, job_id=42, reasons=(),
            extra=b"\x05" + ipp_attr(0x23, b"job-state", (9).to_bytes(4, "big")),
        )
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_job_state_in_the_operation_group_is_not_the_jobs_state(self):
        body = (
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x01"
            + ipp_attr(0x47, b"attributes-charset", b"utf-8")
            + ipp_attr(0x23, b"job-state", (9).to_bytes(4, "big"))
            + b"\x02"
            + ipp_attr(0x21, b"job-id", (42).to_bytes(4, "big"))
            + b"\x03"
        )
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_an_empty_job_group_is_waiting(self):
        body = ipp_response(request_id=3, job_id=42, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_two_job_groups_are_waiting(self):
        body = ipp_response(
            job_state=9, request_id=3,
            extra=b"\x02" + ipp_attr(0x23, b"job-state", (5).to_bytes(4, "big")),
        )
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_WAITING

    def test_a_repeated_job_state_is_waiting(self):
        """RFC 8010 sec 3.6: two attributes with one name make the group malformed."""
        body = ipp_response(
            job_state=9, request_id=3,
            extra=ipp_attr(0x23, b"job-state", (5).to_bytes(4, "big")),
        )
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_a_multi_valued_job_state_is_waiting(self):
        body = ipp_response(
            job_state=9, request_id=3, job_id=None, reasons=(),
            extra=ipp_attr(0x23, b"", (5).to_bytes(4, "big")),
        )
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_WAITING

    @pytest.mark.parametrize("tag,value", [
        pytest.param(0x21, (9).to_bytes(4, "big"), id="integer-tag-not-enum"),
        pytest.param(0x12, b"", id="out-of-band-unknown"),
        pytest.param(0x13, b"", id="out-of-band-no-value"),
        pytest.param(0x10, b"", id="out-of-band-unsupported"),
        pytest.param(0x23, b"\x00\x09", id="two-octet-enum"),
        pytest.param(0x44, b"completed", id="keyword-completed"),
    ])
    def test_an_unreadable_job_state_is_waiting(self, tag, value):
        body = ipp_response(request_id=3, job_state_tag=tag, job_state_value=value)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] is None

    def test_a_collection_before_job_state_is_walked_by_length(self):
        """A begCollection/member/endCollection run parses as values of one attribute and never
        shadows or fakes job-state."""
        collection = (
            ipp_attr(0x34, b"media-col", b"")
            + ipp_attr(0x4a, b"", b"media-size")
            + ipp_attr(0x34, b"", b"")
            + ipp_attr(0x4a, b"", b"job-state")          # a MEMBER name, not an attribute
            + ipp_attr(0x21, b"", (9).to_bytes(4, "big"))
            + ipp_attr(0x37, b"", b"")
            + ipp_attr(0x37, b"", b"")
        )
        body = (
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x01"
            + ipp_attr(0x47, b"attributes-charset", b"utf-8")
            + b"\x02" + collection
            + ipp_attr(0x23, b"job-state", (5).to_bytes(4, "big"))
            + b"\x03"
        )
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert observation["jobStateCode"] == 5

    def test_data_after_the_end_tag_is_ignored(self):
        body = ipp_response(job_state=9, request_id=3) + b"trailing document data"
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_COMPLETED

    # --- malformed / truncated --------------------------------------------
    # GOOD suppresses the job-id / reasons attributes so these slice offsets keep meaning exactly what
    # their ids say -- truncation of the wire format itself, not of the newer fields.

    GOOD = ipp_response(job_state=9, request_id=3, job_id=None, reasons=())

    @pytest.mark.parametrize("body,problem", [
        pytest.param(b"", "truncated header", id="empty"),
        pytest.param(GOOD[:5], "truncated header", id="five-bytes"),
        pytest.param(GOOD[:8], "no end-of-attributes-tag", id="header-only"),
        pytest.param(GOOD[:-1], "no end-of-attributes-tag", id="end-tag-missing"),
        pytest.param(GOOD[:-3], "truncated in value", id="cut-inside-job-state"),
        pytest.param(GOOD[:12], "truncated in name", id="cut-inside-a-name"),
        pytest.param(GOOD[:10], "truncated in name-length", id="cut-inside-name-length"),
        pytest.param(
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x02\x23\x00\x09job-state\x00\xff\x00\x00\x00\x09\x03",
            "truncated in value", id="value-length-overruns",
        ),
        pytest.param(
            b"\x02\x00\x00\x00\x00\x00\x00\x03" + ipp_attr(0x23, b"job-state", b"\x00\x00\x00\x09") + b"\x03",
            "before any attribute group", id="attribute-outside-a-group",
        ),
        pytest.param(
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x02" + ipp_attr(0x23, b"", b"\x00\x00\x00\x09") + b"\x03",
            "additional-value with no attribute", id="orphan-additional-value",
        ),
        pytest.param(
            b"\x02\x00\x00\x00\x00\x00\x00\x03\x02\x23\x80\x00", "negative name-length",
            id="negative-name-length",
        ),
    ])
    def test_malformed_responses_raise_and_are_waiting(self, body, problem):
        with pytest.raises(IppDecodeError, match=problem):
            decode_ipp_response(body)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "malformed" in observation["reason"]

    @pytest.mark.parametrize("body", ["a string", None, 12, {"job-state": 9}])
    def test_a_body_that_is_not_bytes_is_waiting(self, body):
        with pytest.raises(IppDecodeError):
            decode_ipp_response(body)
        assert ipp_completion_verdict(200, body, 3, 42)[0] == POLL_WAITING


# ---------------------------------------------------------------------------
# No terminal verdict without proof the answer is about THIS job (r31 round-1 finding 2)
# ---------------------------------------------------------------------------

class TestIppJobIdCorrelation:
    def test_another_jobs_id_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id=999)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not our job" in observation["reason"]
        assert "999" in observation["reason"] and "42" in observation["reason"]
        assert observation["reportedJobId"] == 999

    def test_missing_job_id_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id=None)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "no usable job-id" in observation["reason"]
        assert observation["reportedJobId"] is None

    def test_duplicate_job_id_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id=42, duplicate_job_id=True)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "no usable job-id" in observation["reason"]

    def test_job_id_with_a_non_integer_tag_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id=42, job_id_tag=0x44)  # keyword, not integer
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not a 4-octet integer" in observation["reason"]

    def test_job_id_with_the_wrong_octet_count_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, job_id_value=b"\x00\x2a")  # 2 octets, not 4
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "not a 4-octet integer" in observation["reason"]

    @pytest.mark.parametrize("job_id_value", [b"\x00\x00\x00\x00", b"\xff\xff\xff\xff", b"\x80\x00\x00\x00"])
    def test_a_job_id_outside_1_to_max_is_waiting(self, job_id_value):
        body = ipp_response(job_state=9, request_id=3, job_id_value=job_id_value)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "out of range" in observation["reason"]

    @pytest.mark.parametrize("state", [7, 8])
    def test_failed_states_still_require_a_matching_job_id(self, state):
        body = ipp_response(job_state=state, request_id=7, job_id=999, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    @pytest.mark.parametrize("state", [7, 8])
    def test_failed_states_need_no_well_formed_reasons_once_the_job_id_matches(self, state):
        body = ipp_response(job_state=state, request_id=7, job_id=42, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_FAILED, observation


# ---------------------------------------------------------------------------
# job-state-reasons is REQUIRED to read a 'completed' state (RFC 8011 sec 5.3.8)
# ---------------------------------------------------------------------------

class TestIppReasonsAtStateNine:
    def test_missing_reasons_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, reasons=())
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "job-state-reasons is unusable" in observation["reason"]

    def test_duplicated_reasons_attribute_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, reasons=("none",), duplicate_reasons=True)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "job-state-reasons is unusable" in observation["reason"]

    def test_non_keyword_reason_value_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, reasons=("none",), reasons_value_tag=0x21)
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "job-state-reasons is unusable" in observation["reason"]

    def test_empty_reason_value_is_waiting(self):
        body = ipp_response(job_state=9, request_id=3, reasons=("",))
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_WAITING
        assert "job-state-reasons is unusable" in observation["reason"]

    @pytest.mark.parametrize("reason", sorted(IPP_REASONS_STOPPED))
    def test_a_stopped_reason_is_failed(self, reason):
        body = ipp_response(job_state=9, request_id=3, reasons=(reason,))
        verdict, observation = ipp_completion_verdict(200, body, 3, 42)
        assert verdict == POLL_FAILED
        assert reason in observation["reason"]

    @pytest.mark.parametrize("reasons,expected", [
        pytest.param(("none",), POLL_COMPLETED, id="none"),
        pytest.param(("job-completed-successfully",), POLL_COMPLETED, id="successfully"),
        pytest.param(("job-completed-with-warnings",), POLL_UNOBSERVABLE, id="with-warnings"),
        pytest.param(("job-completed-with-errors",), POLL_FAILED, id="with-errors"),
        pytest.param(("completed-with-errors",), POLL_FAILED, id="with-errors-table-15"),
        pytest.param(("queued-in-device",), POLL_UNOBSERVABLE, id="queued-in-device"),
        pytest.param(("job-canceled-by-user",), POLL_FAILED, id="canceled-by-user"),
        pytest.param(("job-canceled-by-operator",), POLL_FAILED, id="canceled-by-operator"),
        pytest.param(("job-canceled-at-device",), POLL_FAILED, id="canceled-at-device"),
        pytest.param(("aborted-by-system",), POLL_FAILED, id="aborted-by-system"),
        pytest.param(("processing-to-stop-point",), POLL_FAILED, id="processing-to-stop-point"),
    ])
    def test_the_reason_vocabulary_at_state_9(self, reasons, expected):
        body = ipp_response(job_state=9, request_id=7, reasons=reasons)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == expected, observation


# ---------------------------------------------------------------------------
# r31 round-2 finding 4 ("H4"): reasons are strict RFC 8011 keywords, and only an allowlist completes
# ---------------------------------------------------------------------------

class TestH4MalformedKeywordSyntaxIsAlwaysWaiting:
    """job-state-reasons must be strict RFC 8011 sec 5.1.4 keyword syntax (1-255 US-ASCII lowercase
    letters/digits/-/./_, first char a lowercase letter). ONE malformed value makes the WHOLE
    attribute unusable -- WAITING, never reinterpreted as COMPLETED, FAILED or UNOBSERVABLE."""

    @pytest.mark.parametrize("reasons", [
        pytest.param((" ",), id="bare-space"),
        pytest.param(("job-completed-with-errors ",), id="trailing-space-on-an-error-reason"),
        pytest.param(("job-completed-successfully\n",), id="trailing-newline"),
        pytest.param(("Job-completed-successfully",), id="leading-capital"),
        pytest.param(("1abc",), id="leading-digit"),
        pytest.param(("a" * 256,), id="256-chars-one-over-the-255-max"),
        pytest.param(("job\x00x",), id="embedded-nul"),
        pytest.param(("",), id="empty-value"),
        pytest.param(("job-completed-successfully", " "), id="second-value-malformed"),
        pytest.param((b"\xff",), id="non-ascii-byte"),
        pytest.param(("-x",), id="leading-hyphen"),
    ])
    def test_malformed_reason_is_waiting(self, reasons):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_WAITING, observation

    def test_255_chars_is_syntactically_valid_but_not_allowlisted(self):
        """One char under the max parses fine (unlike 256), so it reaches the allowlist check on its
        own semantic merits -- and fails it: UNOBSERVABLE, not COMPLETED, and not WAITING either."""
        body = ipp_response(job_state=9, reasons=("a" * 255,), request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_UNOBSERVABLE, observation


class TestH4SyntacticallyValidButUnlistedReasonsAreUnobservable:
    @pytest.mark.parametrize("reasons", [
        pytest.param(("job-completed-with-warnings",), id="with-warnings"),
        pytest.param(("job-printing",), id="printing-contradicts-completed"),
        pytest.param(("com.acme.reason",), id="vendor-keyword"),
        pytest.param(("none", "job-queued"), id="none-plus-an-unlisted-reason"),
        pytest.param(("job-completed-successfully", "printer-stopped"),
                     id="successfully-plus-an-unlisted-reason"),
    ])
    def test_unlisted_reason_is_unobservable(self, reasons):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_UNOBSERVABLE, observation


class TestH4AllowlistedReasonsComplete:
    @pytest.mark.parametrize("reasons", [
        pytest.param(("none",), id="none"),
        pytest.param(("job-completed-successfully",), id="successfully"),
        pytest.param(("job-completed-successfully", "job-restartable"), id="successfully-plus-restartable"),
        pytest.param(("job-restartable",), id="restartable-alone"),
    ])
    def test_allowlisted_reason_completes(self, reasons):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_COMPLETED, observation


class TestH4ErrorsAndStoppedAndQueuedInDeviceOutrankTheAllowlist:
    @pytest.mark.parametrize("reasons,expected", [
        pytest.param(("job-completed-with-errors",), POLL_FAILED, id="with-errors"),
        pytest.param(("job-completed-successfully", "job-canceled-by-user"), POLL_FAILED,
                     id="successfully-plus-canceled-outranks-the-allowlist"),
        pytest.param(("queued-in-device",), POLL_UNOBSERVABLE, id="queued-in-device"),
    ])
    def test_verdict(self, reasons, expected):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == expected, observation


# ---------------------------------------------------------------------------
# Pack 77 H3 (astra on #377 @67875cd1): 'none' must stand alone
# ---------------------------------------------------------------------------

class TestNoneMustStandAlone:
    """'none' says no reason applies (RFC 8011 sec 5.3.8). Beside any other value it contradicts
    itself, so it is not a clean completion even when every value is in the allowlist. Each case
    below is decided by this rule alone: without it, both allowlisted pairs read as COMPLETED."""

    @pytest.mark.parametrize("reasons", [
        pytest.param(("none", "job-completed-successfully"), id="none-then-successfully"),
        pytest.param(("job-completed-successfully", "none"), id="successfully-then-none"),
        pytest.param(("none", "job-restartable"), id="none-plus-restartable"),
        pytest.param(("none", "none"), id="none-twice"),
    ])
    def test_none_beside_another_reason_is_unobservable(self, reasons):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_UNOBSERVABLE, observation
        assert "contradicts itself" in observation["reason"]

    def test_none_alone_still_completes(self):
        body = ipp_response(job_state=9, reasons=("none",), request_id=7, job_id=42)
        assert ipp_completion_verdict(200, body, 7, 42)[0] == POLL_COMPLETED

    def test_errors_beside_none_still_fail(self):
        """An explicit error outranks the contradiction: the job is reported failed, not dropped."""
        body = ipp_response(job_state=9, reasons=("none", "job-completed-with-errors"), request_id=7, job_id=42)
        assert ipp_completion_verdict(200, body, 7, 42)[0] == POLL_FAILED


# ---------------------------------------------------------------------------
# Print-Job and Get-Printer-Attributes (the IPP print runtime's submit and idle check)
# ---------------------------------------------------------------------------

def answer(groups, status=0x0000, request_id=5, version=b"\x02\x00"):
    """An IPP answer: an operation group, then ``groups`` (raw bytes, each starting with its tag)."""
    return (
        version + status.to_bytes(2, "big") + request_id.to_bytes(4, "big", signed=True)
        + b"\x01" + ipp_attr(0x47, b"attributes-charset", b"utf-8")
        + ipp_attr(0x48, b"attributes-natural-language", b"en")
        + b"".join(groups) + b"\x03"
    )


def job_group(job_id=77, tag=0x21, value=None, duplicate=False):
    value = value if value is not None else job_id.to_bytes(4, "big", signed=True)
    out = b"\x02" + ipp_attr(tag, b"job-id", value)
    if duplicate:
        out += ipp_attr(tag, b"job-id", value)
    return out + ipp_attr(0x23, b"job-state", (3).to_bytes(4, "big")) + ipp_attr(0x44, b"job-state-reasons", b"none")


def printer_group(state=3, tag=0x23, value=None, duplicate=False):
    value = value if value is not None else state.to_bytes(4, "big", signed=True)
    out = b"\x04" + ipp_attr(tag, b"printer-state", value)
    return out + (ipp_attr(tag, b"printer-state", value) if duplicate else b"")


class TestPrintJobEncoding:
    PRINTER_URI = "ipp://10.0.0.1:631/printers/office"

    # Written out field by field from RFC 8010 sec 3.1 and RFC 8011 sec 4.2.1.1 -- NOT by the encoder.
    EXPECTED = (
        b"\x02\x00"                                   # version-number 2.0
        b"\x00\x02"                                   # operation-id Print-Job
        b"\x00\x00\x00\x05"                           # request-id 5
        b"\x01"                                       # operation-attributes-tag
        b"\x47" b"\x00\x12" b"attributes-charset" b"\x00\x05" b"utf-8"
        b"\x48" b"\x00\x1b" b"attributes-natural-language" b"\x00\x02" b"en"
        b"\x45" b"\x00\x0b" b"printer-uri" b"\x00\x22" b"ipp://10.0.0.1:631/printers/office"
        b"\x42" b"\x00\x14" b"requesting-user-name" b"\x00\x08" b"pcc-node"
        b"\x42" b"\x00\x08" b"job-name" b"\x00\x08" b"pcc-node"
        b"\x49" b"\x00\x0f" b"document-format" b"\x00\x0a" b"text/plain"
        b"\x03"                                       # end-of-attributes-tag
        b"hello, printer\n"                           # the document, after the attributes
    )

    def test_request_bytes_are_exact(self):
        encoded = encode_print_job(self.PRINTER_URI, 5, b"hello, printer\n",
                                   document_format="text/plain", job_name="pcc-node")
        assert encoded == self.EXPECTED, f"\nexpected {self.EXPECTED.hex()}\n     got {encoded.hex()}"

    def test_the_document_follows_the_attributes_verbatim(self):
        document = bytes(range(256)) * 4   # any bytes, end-of-attributes-tag values included
        encoded = encode_print_job(self.PRINTER_URI, 5, document, document_format="text/plain", job_name="j")
        assert encoded.endswith(b"\x03" + document)
        decoded = decode_ipp_response(encoded)   # the document is never read as attributes
        [group] = decoded["groups"]
        assert [a["name"] for a in group["attributes"]] == [
            "attributes-charset", "attributes-natural-language", "printer-uri",
            "requesting-user-name", "job-name", "document-format",
        ]

    @pytest.mark.parametrize("kwargs", [
        pytest.param({"request_id": 0}, id="request-id-zero"),
        pytest.param({"request_id": True}, id="request-id-bool"),
        pytest.param({"document": "text, not bytes"}, id="document-not-bytes"),
        pytest.param({"job_name": ""}, id="empty-job-name"),
        pytest.param({"job_name": "x" * 256}, id="job-name-too-long"),
        pytest.param({"job_name": "line\nbreak"}, id="job-name-control-character"),
        pytest.param({"job_name": "café"}, id="job-name-not-ascii"),
        pytest.param({"document_format": ""}, id="empty-format"),
        pytest.param({"document_format": "text/plain\r\nX: y"}, id="format-control-characters"),
    ])
    def test_bad_inputs_are_refused(self, kwargs):
        args = {"request_id": 5, "document": b"x", "document_format": "text/plain", "job_name": "pcc-node"}
        args.update(kwargs)
        with pytest.raises(ValueError):
            encode_print_job(self.PRINTER_URI, args.pop("request_id"), args.pop("document"), **args)


class TestPrintJobAnswer:
    def test_the_job_id_the_printer_created_is_read(self):
        job_id, observation = print_job_answer(200, answer([job_group(77)]), 5)
        assert job_id == 77
        assert observation["reportedJobId"] == 77 and observation["ippStatusCode"] == "0x0000"

    @pytest.mark.parametrize("status", [0x0001, 0x0002, 0x00FF])
    def test_every_successful_status_code_is_read(self, status):
        assert print_job_answer(200, answer([job_group(77)], status=status), 5)[0] == 77

    @pytest.mark.parametrize("http_status,body,reason", [
        pytest.param(0, None, "transport failure", id="no-answer"),
        pytest.param(500, answer([job_group()]), "HTTP 500", id="http-500"),
        pytest.param(200, answer([job_group()], request_id=6), "not ours", id="another-request-id"),
        pytest.param(200, answer([job_group()], status=0x040A), "not a success", id="document-format-not-supported"),
        pytest.param(200, answer([job_group()], status=0x0507), "not a success", id="not-accepting-jobs"),
        pytest.param(200, answer([job_group()], version=b"\x03\x00"), "not an IPP/1.x", id="ipp-3"),
        pytest.param(200, answer([]), "no usable job-id", id="no-job-group"),
        pytest.param(200, answer([job_group(), job_group()]), "no usable job-id", id="two-job-groups"),
        pytest.param(200, answer([job_group(duplicate=True)]), "no usable job-id", id="two-job-ids"),
        pytest.param(200, answer([job_group(tag=0x44)]), "not a 4-octet integer", id="job-id-a-keyword"),
        pytest.param(200, answer([job_group(value=b"\x00\x4d")]), "not a 4-octet integer", id="two-octets"),
        pytest.param(200, answer([job_group(value=b"\x00\x00\x00\x00")]), "out of range", id="job-id-zero"),
        pytest.param(200, answer([b"\x04" + ipp_attr(0x21, b"job-id", (77).to_bytes(4, "big"))]),
                     "no usable job-id", id="job-id-only-in-a-printer-group"),
        pytest.param(200, answer([job_group()])[:-3], "malformed", id="truncated"),
        pytest.param(200, "text", "malformed", id="not-bytes"),
    ])
    def test_an_answer_that_names_no_job_of_ours_names_none(self, http_status, body, reason):
        job_id, observation = print_job_answer(http_status, body, 5)
        assert job_id is None
        assert reason in observation["reason"], observation


class TestPrinterState:
    PRINTER_URI = "ipp://10.0.0.1:631/printers/office"

    EXPECTED = (
        b"\x02\x00" b"\x00\x0b" b"\x00\x00\x00\x09" b"\x01"   # IPP/2.0, Get-Printer-Attributes, request-id 9
        b"\x47" b"\x00\x12" b"attributes-charset" b"\x00\x05" b"utf-8"
        b"\x48" b"\x00\x1b" b"attributes-natural-language" b"\x00\x02" b"en"
        b"\x45" b"\x00\x0b" b"printer-uri" b"\x00\x22" b"ipp://10.0.0.1:631/printers/office"
        b"\x42" b"\x00\x14" b"requesting-user-name" b"\x00\x08" b"pcc-node"
        b"\x44" b"\x00\x14" b"requested-attributes" b"\x00\x0d" b"printer-state"
        b"\x03"
    )

    def test_request_bytes_are_exact(self):
        assert encode_get_printer_attributes(self.PRINTER_URI, 9) == self.EXPECTED

    def test_idle_is_printer_state_3(self):
        assert printer_is_idle(200, answer([printer_group(3)], request_id=9), 9) is True

    @pytest.mark.parametrize("http_status,body", [
        pytest.param(200, answer([printer_group(4)], request_id=9), id="processing"),
        pytest.param(200, answer([printer_group(5)], request_id=9), id="stopped"),
        pytest.param(200, answer([printer_group(3)], request_id=8), id="another-request-id"),
        pytest.param(200, answer([printer_group(3)], request_id=9, status=0x0400), id="error-status"),
        pytest.param(500, answer([printer_group(3)], request_id=9), id="http-500"),
        pytest.param(0, None, id="no-answer"),
        pytest.param(200, answer([printer_group(3, duplicate=True)], request_id=9), id="two-printer-states"),
        pytest.param(200, answer([printer_group(3), printer_group(3)], request_id=9), id="two-printer-groups"),
        pytest.param(200, answer([printer_group(3, tag=0x21)], request_id=9), id="integer-not-enum"),
        pytest.param(200, answer([printer_group(value=b"\x00\x03")], request_id=9), id="two-octets"),
        pytest.param(200, answer([b"\x02" + ipp_attr(0x23, b"printer-state", (3).to_bytes(4, "big"))], request_id=9),
                     id="in-a-job-group"),
        pytest.param(200, answer([printer_group(3)], request_id=9)[:-2], id="truncated"),
    ])
    def test_anything_else_is_not_idle(self, http_status, body):
        assert printer_is_idle(http_status, body, 9) is False


class TestQueuedInDeviceOutranksEveryOtherReason:
    """RFC 8011 sec 5.3.8: 'queued-in-device' means the printer handed the job to a device that cannot
    report status, so it "never will have any better information" about the outcome. An error or stop
    reason beside it is not that device's report: the outcome stays unobservable (#377's order checks
    it first). Without that rule these read as FAILED; the allowlist alone cannot tell them apart."""

    @pytest.mark.parametrize("reasons", [
        pytest.param(("queued-in-device", "job-completed-with-errors"), id="beside-errors"),
        pytest.param(("job-canceled-by-user", "queued-in-device"), id="beside-a-cancel"),
    ])
    def test_queued_in_device_beside_an_error_or_a_stop_is_unobservable(self, reasons):
        body = ipp_response(job_state=9, reasons=reasons, request_id=7, job_id=42)
        verdict, observation = ipp_completion_verdict(200, body, 7, 42)
        assert verdict == POLL_UNOBSERVABLE, observation
        assert "queued-in-device" in observation["reason"]
