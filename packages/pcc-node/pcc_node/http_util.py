"""Shared HTTP helpers using only stdlib (urllib.request).

Every outbound request carries a User-Agent to avoid Cloudflare blocks.
http() may relax TLS for local-network device probing. Requests to the PCC
gateway go through gateway_request()/pcc_request(), which never do.
"""

import ipaddress
import json
import logging
import ssl
from urllib.parse import urlsplit
from urllib.request import (HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener,
                            getproxies, urlopen)
from urllib.error import HTTPError, URLError

log = logging.getLogger("pcc-node.http")

USER_AGENT = "PCC-Node/0.1.1 (https://capability.network)"

# Relaxed SSL context for local-network device probing (OctoPrint, OT-2, etc.)
_relaxed_ctx = ssl.create_default_context()
_relaxed_ctx.check_hostname = False
_relaxed_ctx.verify_mode = ssl.CERT_NONE


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


def pcc_request(method, path, body=None, *, base_url, api_key="", timeout=30):
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
    """
    url = f"{base_url.rstrip('/')}{path}"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return gateway_request(method, url, body, headers, timeout=timeout)
