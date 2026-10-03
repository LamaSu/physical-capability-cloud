"""Shared HTTP helpers using only stdlib (urllib.request).

Every outbound request carries a User-Agent to avoid Cloudflare blocks.
SSL verification is relaxed for local-network device probing.
"""

import json
import ssl
import threading
import time
from contextlib import contextmanager
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

USER_AGENT = "PCC-Node/0.1.0 (https://capability.network)"

# Relaxed SSL context for local-network device probing (OctoPrint, OT-2, etc.)
_relaxed_ctx = ssl.create_default_context()
_relaxed_ctx.check_hostname = False
_relaxed_ctx.verify_mode = ssl.CERT_NONE


# ---------------------------------------------------------------------------
# The actuation boundary (#400 r9, F3)
# ---------------------------------------------------------------------------

_actuation = threading.local()


@contextmanager
def actuation_deadline(deadline):
    """Bind every device command this thread emits inside the block to a lease deadline.

    A relayed call may run only while its lease holds. The executor's own check before an
    adapter is advisory: the process can be suspended after it. So the deadline is checked
    again where a command leaves the node: http() and the shell path call
    may_emit_device_command() immediately before they send. Yields a dict: "sent", the
    commands that left; "refused", whether one was held back because the deadline had passed.
    """
    previous = getattr(_actuation, "guard", None)
    guard = {"deadline": deadline, "sent": 0, "refused": False}
    _actuation.guard = guard
    try:
        yield guard
    finally:
        _actuation.guard = previous


def may_emit_device_command():
    """True if a device command may leave the node now. Outside an actuation_deadline block
    (health probes, detection, gateway calls) it always may; inside one, only before the
    deadline. A refusal is recorded, and every command allowed out is counted."""
    guard = getattr(_actuation, "guard", None)
    if guard is None:
        return True
    deadline = guard["deadline"]
    if deadline is None or time.monotonic() > deadline:
        guard["refused"] = True
        return False
    guard["sent"] += 1
    return True


def http(method, url, body=None, headers=None, timeout=30, verify_ssl=True):
    """Make an HTTP request. Returns (status_code, parsed_body).

    Uses stdlib only -- no requests dependency.

    Parameters
    ----------
    method : str
        HTTP method (GET, POST, PUT, DELETE).
    url : str
        Full URL.
    body : dict | None
        JSON-serializable body (auto-encoded).
    headers : dict | None
        Extra headers.
    timeout : int
        Request timeout in seconds.
    verify_ssl : bool
        If False, skip SSL verification (useful for LAN devices).

    Returns
    -------
    tuple[int, dict | str]
        (status_code, response_body).  status_code is 0 on connection error.
    """
    hdrs = dict(headers or {})
    hdrs.setdefault("User-Agent", USER_AGENT)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = Request(url, data=data, headers=hdrs, method=method)
    ctx = None if verify_ssl else _relaxed_ctx
    # The last check before the request leaves the node (#400 r9, F3).
    if not may_emit_device_command():
        return 0, {"error": "not_executed:lease_expired"}
    try:
        with urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                return resp.status, raw
    except HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return e.code, raw
    except (URLError, OSError) as e:
        return 0, {"error": str(e)}


def pcc_request(method, path, body=None, *, base_url, api_key="", timeout=30, headers=None):
    """Make a request to the PCC gateway.

    Parameters
    ----------
    method : str
        HTTP method.
    path : str
        Path relative to base_url (e.g. "/api/kernels").
    body : dict | None
        JSON body.
    base_url : str
        PCC gateway base URL.
    api_key : str
        Bearer token.
    timeout : int
        Request timeout.
    headers : dict | None
        Extra headers to merge into the request (e.g. "X-PCC-Lease: 1"). The
        Authorization header is always derived exclusively from `api_key`: any
        "Authorization" entry here (any case) is dropped, never merged in --
        callers cannot use `headers` to override or supply auth.
    """
    url = f"{base_url.rstrip('/')}{path}"
    req_headers = {}
    if headers:
        for key, value in headers.items():
            if key.lower() == "authorization":
                continue
            req_headers[key] = value
    if api_key:
        req_headers["Authorization"] = f"Bearer {api_key}"
    return http(method, url, body, req_headers, timeout=timeout)
