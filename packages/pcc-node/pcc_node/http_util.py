"""Shared HTTP helpers using only stdlib (urllib.request).

Every outbound request carries a User-Agent to avoid Cloudflare blocks.
http() may relax TLS for local-network device probing. Requests to the PCC
gateway go through gateway_request()/pcc_request(), which never do.
"""

import http.client
import ipaddress
import json
import logging
import ssl
import threading
import time
import urllib.request
from contextlib import contextmanager
from urllib.parse import urlsplit
# urlopen is NOT imported: this module defines its own, the guarded one (#400 F3).
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener, getproxies
from urllib.error import HTTPError, URLError

log = logging.getLogger("pcc-node.http")

USER_AGENT = "PCC-Node/0.1.0 (https://capability.network)"

# Relaxed SSL context for local-network device probing (OctoPrint, OT-2, etc.)
_relaxed_ctx = ssl.create_default_context()
_relaxed_ctx.check_hostname = False
_relaxed_ctx.verify_mode = ssl.CERT_NONE


# ---------------------------------------------------------------------------
# The actuation boundary (#400 r9-r11, F3)
#
# The device relay's execution lease ends at a deadline (docs/EXECUTION_SCOPE_PROTOCOL.md).
# A relay client sends each device command through http() inside actuation_deadline(deadline),
# so a command is never written to the device's socket after the deadline. pcc-node itself
# ships no relay executor since #442 (N66): its relay executor ran tool calls in a shell, and
# there is no shell path any more, so nothing here can launch a process.
# ---------------------------------------------------------------------------

_actuation = threading.local()

LEASE_EXPIRED = "not_executed:lease_expired"


class LeaseLapsed(OSError):
    """A device command held back because the call's lease deadline had passed."""


@contextmanager
def actuation_deadline(deadline):
    """Bind every device command this thread starts inside the block to a lease deadline.

    An HTTP command is checked twice. http() checks before any connection is made. Then the
    guarded connection checks again after it is established (TLS included) and immediately before
    the request's first byte is written to the socket, the last point the node controls. A command
    that fails either check is never written. The one residual is a suspension between that last
    check and the socket write. After the write, the network and the device add their own delays.

    Yields a dict:
      "written": requests whose first byte was handed to the socket (each may have reached the device);
      "refused": None, or the not_executed reason of the first command held back.
    """
    previous = getattr(_actuation, "guard", None)
    guard = {"deadline": deadline, "written": 0, "refused": None}
    _actuation.guard = guard
    try:
        yield guard
    finally:
        _actuation.guard = previous


def _deadline_holds(guard):
    deadline = guard["deadline"]
    if deadline is None or time.monotonic() > deadline:
        if guard["refused"] is None:
            guard["refused"] = LEASE_EXPIRED
        return False
    return True


def may_start_device_command():
    """True if a device command may be started now. Outside an actuation_deadline block (health
    probes, detection, gateway calls) it always may. Inside one, only before the deadline, and a
    refusal is recorded. Starting isn't writing: the guarded connection checks again before the
    request's first byte."""
    guard = getattr(_actuation, "guard", None)
    return True if guard is None else _deadline_holds(guard)


class _DeadlineAtFirstWrite(object):
    """A mixin for http.client connections. Under an actuation_deadline block, the deadline is
    checked once per request, after the connection is established and immediately before the
    request's first byte is written to the socket. A proxy tunnel's CONNECT bytes go to the proxy
    while connect() runs, not to the device, so they aren't the request."""

    _pcc_checked = False
    _pcc_connecting = False

    def connect(self):
        self._pcc_connecting = True
        try:
            super().connect()
        finally:
            self._pcc_connecting = False

    def send(self, data):
        if self._pcc_connecting:
            return super().send(data)
        if not self._pcc_checked:
            if self.sock is None and self.auto_open:
                self.connect()  # setup can take any time, so it comes before the check
            self._pcc_checked = True
            guard = getattr(_actuation, "guard", None)
            if guard is not None:
                if not _deadline_holds(guard):
                    raise LeaseLapsed("the lease deadline passed before the request's first byte was written")
                guard["written"] += 1
        return super().send(data)


class _GuardedHTTPConnection(_DeadlineAtFirstWrite, http.client.HTTPConnection):
    pass


class _GuardedHTTPSConnection(_DeadlineAtFirstWrite, http.client.HTTPSConnection):
    pass


class _GuardedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_GuardedHTTPConnection, req)


class _GuardedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        kwargs = {"context": self._context}
        if hasattr(self, "_check_hostname"):  # Python before 3.12 passes it separately
            kwargs["check_hostname"] = self._check_hostname
        return self.do_open(_GuardedHTTPSConnection, req, **kwargs)


def urlopen(req, timeout=30, context=None):
    """urllib's urlopen, with the deadline checked inside the connection (#400 r11)."""
    opener = urllib.request.build_opener(_GuardedHTTPHandler(), _GuardedHTTPSHandler(context=context))
    return opener.open(req, timeout=timeout)


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
    # No connection is made after the deadline; the connection checks again before its first
    # byte (#400 r9-r11, F3).
    if not may_start_device_command():
        return 0, {"error": LEASE_EXPIRED}
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
    except URLError as e:
        if isinstance(e.reason, LeaseLapsed):
            return 0, {"error": LEASE_EXPIRED}
        return 0, {"error": str(e)}
    except LeaseLapsed:
        return 0, {"error": LEASE_EXPIRED}
    except OSError as e:
        return 0, {"error": str(e)}


def gateway_url_allowed(url):
    """True if a PCC gateway URL may carry the operator's key and its answers.

    Only https qualifies, or plain http to a literal loopback address
    (127.0.0.0/8 or [::1]: a rehearsal gateway on this machine), where the key
    never leaves the host (verdicts 68c and 68d, finding 1). The name
    "localhost" is refused, since a resolver can map it anywhere.
    """
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False
    if parsed.scheme == "https":
        return True
    if parsed.scheme != "http":
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class _NoRedirect(HTTPRedirectHandler):
    """A 3xx from the gateway is an answer, never a new target for the key."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _https_proxies_only():
    """Environment proxies for https only. An http proxy would see the key in clear
    text, so plain http (loopback only) always goes direct (verdict 68d, finding 1)."""
    return {scheme: url for scheme, url in getproxies().items() if scheme == "https"}


# Verified TLS, no redirects, and no proxy for plain http, for everything sent to the PCC gateway.
_GATEWAY_OPENER = build_opener(ProxyHandler(_https_proxies_only()), _NoRedirect,
                               HTTPSHandler(context=ssl.create_default_context()))


def gateway_request(method, url, body=None, headers=None, timeout=30):
    """One request to the PCC gateway. Returns (status_code, parsed_body).

    Refused (status 0, no connection) unless ``gateway_url_allowed(url)``.
    The certificate is always verified and redirects are never followed, so
    the bearer key and the answers can only come from the configured gateway.
    """
    if not gateway_url_allowed(url):
        log.warning("Refusing a PCC gateway URL that is not https (plain http only to 127.0.0.1 or [::1])")
        return 0, {"error": "insecure_gateway_url",
                   "message": "a PCC gateway must be https (plain http only to 127.0.0.1 or [::1])"}
    hdrs = dict(headers or {})
    hdrs.setdefault("User-Agent", USER_AGENT)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = Request(url, data=data, headers=hdrs, method=method)
    try:
        with _GATEWAY_OPENER.open(req, timeout=timeout) as resp:
            status, raw = resp.status, resp.read().decode("utf-8", "replace")
    except HTTPError as e:
        status, raw = e.code, e.read().decode("utf-8", "replace")
    except (URLError, OSError) as e:
        return 0, {"error": str(e)}
    try:
        return status, json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return status, raw


def pcc_request(method, path, body=None, *, base_url, api_key="", timeout=30, headers=None):
    """Make a request to the PCC gateway, through ``gateway_request``.

    Parameters
    ----------
    method : str
        HTTP method.
    path : str
        Path relative to base_url (e.g. "/api/kernels").
    body : dict | None
        JSON body.
    base_url : str
        PCC gateway base URL: https, or plain http on this machine only.
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
    return gateway_request(method, url, body, req_headers, timeout=timeout)
