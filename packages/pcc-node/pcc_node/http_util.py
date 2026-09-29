"""Shared HTTP helpers using only stdlib (urllib.request).

Every outbound request carries a User-Agent to avoid Cloudflare blocks.
SSL verification is relaxed for local-network device probing.

Answers are read strictly (r31 round-1 finding 4).  A device's JSON body
decides whether a job completed, so the parser must never discard what the
device said:

* a duplicate object key is refused -- default ``json.loads`` keeps the LAST
  one, so ``{"status": "failed", "status": "completed"}`` would read as a
  completion before any classifier could see the failure;
* NaN / Infinity / -Infinity (not JSON, RFC 8259 sec 6) are refused;
* a body that is not valid UTF-8 (RFC 8259 sec 8.1) is never parsed.

A refused body comes back as TEXT (a ``str``).  No reader in this package can
take a string for a completion, so a refused body fails closed.  Reads are
bounded: an answer larger than ``max_bytes`` is not read at all and counts as
a transport failure (status 0).
"""

import json
import ssl
import uuid
from http.client import HTTPException
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

USER_AGENT = "PCC-Node/0.1.0 (https://capability.network)"

# Largest answer read: device answers and gateway receipts are far smaller.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024

# Relaxed SSL context for local-network device probing (OctoPrint, OT-2, etc.)
_relaxed_ctx = ssl.create_default_context()
_relaxed_ctx.check_hostname = False
_relaxed_ctx.verify_mode = ssl.CERT_NONE


def _refuse_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(f"duplicate JSON object key {key!r}")
        obj[key] = value
    return obj


def _refuse_constant(name):
    raise ValueError(f"{name} is not JSON")


def parse_json_strict(text):
    """Parse JSON, refusing duplicate keys and NaN/Infinity.  Raises ValueError.

    RecursionError (absurd nesting) is reported as ValueError too.
    """
    try:
        return json.loads(
            text,
            object_pairs_hook=_refuse_duplicate_keys,
            parse_constant=_refuse_constant,
        )
    except RecursionError as exc:
        raise ValueError("JSON nested too deeply to parse") from exc


def _too_large(max_bytes):
    return {"error": f"answer larger than {max_bytes} bytes; not read"}


def _decode_answer(raw):
    """A UTF-8 JSON answer parsed strictly; otherwise the text (never parsed)."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")
    try:
        return parse_json_strict(text)
    except ValueError:
        return text


def _send(req, timeout, ctx, max_bytes):
    """Send ``req``; return (status, parsed answer) under the rules above."""
    try:
        with urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read(max_bytes + 1)
            if len(raw) > max_bytes:
                return 0, _too_large(max_bytes)
            return resp.status, _decode_answer(raw)
    except HTTPError as e:
        try:
            raw = e.read(max_bytes + 1)
        except (OSError, HTTPException):
            raw = b""
        if len(raw) > max_bytes:
            return 0, _too_large(max_bytes)
        return e.code, _decode_answer(raw)
    except (URLError, OSError, HTTPException) as e:
        return 0, {"error": str(e)}


def http(method, url, body=None, headers=None, timeout=30, verify_ssl=True,
         max_bytes=MAX_RESPONSE_BYTES):
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
    max_bytes : int
        Largest answer read; a larger one is a transport failure.

    Returns
    -------
    tuple[int, dict | list | str | ...]
        (status_code, response_body): the strictly parsed JSON value, or the
        text when the answer is not strict JSON (see the module docstring).
        status_code is 0 on connection error or an oversized answer.
    """
    hdrs = dict(headers or {})
    hdrs.setdefault("User-Agent", USER_AGENT)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = Request(url, data=data, headers=hdrs, method=method)
    ctx = None if verify_ssl else _relaxed_ctx
    return _send(req, timeout, ctx, max_bytes)


def http_form(method, url, fields, headers=None, timeout=30, verify_ssl=True,
              max_bytes=MAX_RESPONSE_BYTES):
    """Send text ``fields`` as multipart/form-data; the answer is read as :func:`http` reads it."""
    boundary = f"----PCCForm{uuid.uuid4().hex}"
    parts = []
    for name, value in fields.items():
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n'
            f"\r\n"
            f"{value}\r\n"
        )
    parts.append(f"--{boundary}--\r\n")
    hdrs = dict(headers or {})
    hdrs.setdefault("User-Agent", USER_AGENT)
    hdrs["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = Request(url, data="".join(parts).encode("utf-8"), headers=hdrs, method=method)
    ctx = None if verify_ssl else _relaxed_ctx
    return _send(req, timeout, ctx, max_bytes)


def http_bytes(method, url, data=None, headers=None, timeout=30, verify_ssl=True,
               max_bytes=MAX_RESPONSE_BYTES):
    """Make an HTTP request with a binary body.  Returns (status_code, bytes).

    :func:`http` JSON-encodes the request and UTF-8/JSON-decodes the answer,
    so it cannot carry a binary protocol such as IPP (``application/ipp``).
    This sends ``data`` verbatim and returns the raw response bytes.

    status_code is 0 (and the body ``b""``) when the request never completed
    -- connection refused, DNS failure, timeout, a malformed HTTP exchange --
    or when the answer is larger than ``max_bytes`` (not read): the same
    transport sentinel :func:`http` uses.
    """
    hdrs = dict(headers or {})
    hdrs.setdefault("User-Agent", USER_AGENT)
    req = Request(url, data=data, headers=hdrs, method=method)
    ctx = None if verify_ssl else _relaxed_ctx
    try:
        with urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read(max_bytes + 1)
            return (0, b"") if len(raw) > max_bytes else (resp.status, raw)
    except HTTPError as e:
        try:
            raw = e.read(max_bytes + 1)
        except (OSError, HTTPException):
            return e.code, b""
        return (0, b"") if len(raw) > max_bytes else (e.code, raw)
    except (URLError, OSError, HTTPException):
        return 0, b""


def pcc_request(method, path, body=None, *, base_url, api_key="", timeout=30):
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
    """
    url = f"{base_url.rstrip('/')}{path}"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return http(method, url, body, headers, timeout=timeout)
