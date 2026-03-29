"""Shared HTTP helpers using only stdlib (urllib.request).

Every outbound request carries a User-Agent to avoid Cloudflare blocks.
SSL verification is relaxed for local-network device probing.
"""

import json
import ssl
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

USER_AGENT = "PCC-Node/0.1.0 (https://capability.network)"

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
