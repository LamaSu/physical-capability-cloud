"""N4a: keep the legacy OT-2 relay scripts on the local network.

ot2-executor.py and ot2-agent.py run whatever they are handed, including shell
commands and protocol uploads (an Opentrons protocol is Python code). Until
status board row N4b-robot replaces them, they may only talk to a PCC gateway
and a robot on this machine or a private network, and only after a person
starts them with --unsafe-local. See scripts/README-ot2-executor.md.

What this module enforces (reviews of PR #372, rounds 1 to 3):

- **One transport, checked at the lowest boundary.** Every HTTP request either
  script makes, protocol uploads included, goes through :func:`request`. It
  refuses (exit 2) unless a start was accepted, and unless the destination is
  one this process was authorised for: under the checked PCC base, under the
  checked robot base, or under an external origin registered after the start (the
  agent's Anthropic API). Paths with "." or ".." segments are refused, so "under"
  holds after the server normalises the path. It uses no proxy from the environment, follows no redirect (a 3xx comes
  back as the response) and verifies TLS (PCC_CA_FILE adds a CA for a local
  gateway with its own certificate).
- **Addresses, checked as they are dialled.** A base URL is accepted only when
  its host is an IP literal in canonical form inside LOCAL_NETWORKS, or the name
  "localhost", pinned to 127.0.0.1. Nothing is resolved through DNS. Integer,
  hex and octal spellings, bare names, *.local, 0.0.0.0, IPv4-mapped IPv6,
  IPv6 zone ids and percent-encoding are refused, whatever the Python version.
- **Nothing runs before a start.** start_guard() (relay mode: PCC and robot) and
  start_interactive() (the agent's local modes: robot only) both require
  --unsafe-local. Before either, request(), the scripts' pcc()/ot2() helpers,
  their tool dispatchers (shell included) and their loops all exit 2.
"""

import ipaddress
import json
import os
import re
import ssl
import sys
import uuid
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener

UNSAFE_LOCAL_FLAG = "--unsafe-local"

# Loopback, RFC 1918, link-local, and IPv6 unique-local and link-local.
LOCAL_NETWORKS = tuple(
    ipaddress.ip_network(n)
    for n in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)

_SAFE_FILENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class _Guard:
    """What this process was authorised for. Nothing is authorised until a start."""

    def __init__(self):
        self.mode = None  # None, "relay" (start_guard) or "interactive" (start_interactive)
        self.pcc_base = None
        self.ot2_base = None
        self.external = []  # origins registered after a start, e.g. https://api.anthropic.com


GUARD = _Guard()


def _refuse(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(2)


def local_base(url):
    """Return (canonical_base, None) when `url` is a local base URL, else (None, reason)."""
    raw = url or ""
    try:
        parts = urlsplit(raw)
        host = parts.hostname
        port = parts.port
    except ValueError as err:
        return None, f"cannot parse it ({err})"
    if parts.scheme not in ("http", "https"):
        return None, "it must start with http:// or https://"
    if "%" in parts.netloc:
        return None, "it must not carry an IPv6 zone id or percent-encoding in the host"
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        return None, "it must not carry a user name or password"
    if not host:
        return None, "it has no host"
    if parts.query or parts.fragment:
        return None, "it must not carry a query or fragment"
    if host == "localhost":
        ip = ipaddress.ip_address("127.0.0.1")
    else:
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return None, f"{host!r} is not an IP address; give the local gateway's IP (or localhost)"
        if ip.version == 4 and str(ip) != host:
            return None, f"{host!r} is not in canonical dotted-quad form"
    if ip.version == 6 and ip.ipv4_mapped is not None:
        return None, f"{host!r} is an IPv4-mapped IPv6 address"
    if not any(ip in net for net in LOCAL_NETWORKS):
        return None, f"{ip} is not a loopback, private or link-local address"
    netloc = f"[{ip}]" if ip.version == 6 else str(ip)
    if port is not None:
        netloc = f"{netloc}:{port}"
    return urlunsplit((parts.scheme, netloc, parts.path.rstrip("/"), "", "")), None


def _flag_refusal(argv, name):
    if UNSAFE_LOCAL_FLAG in argv:
        return None
    return (
        f"REFUSED: {name} is not safe to run. Any PCC API key holder could make it run "
        "shell commands and arbitrary protocols on this robot (status board row N4b). "
        "For development against a gateway on your own machine or private network, "
        f"re-run with {UNSAFE_LOCAL_FLAG}. See scripts/README-ot2-executor.md."
    )


def _robot_refusal(ot2_base, why):
    return (
        f"REFUSED: OT2_BASE must be the robot on this machine or a private network, "
        f"given by IP address or as localhost, but it is {ot2_base!r}: {why}."
    )


def start_guard(argv, pcc_base, name, ot2_base=None):
    """Relay mode (PCC and robot). Authorise this process and return None, or return
    the reason it must not start."""
    refusal = _flag_refusal(argv, name)
    if refusal:
        return refusal
    pcc, why = local_base(pcc_base)
    if pcc is None:
        return (
            f"REFUSED: {UNSAFE_LOCAL_FLAG} allows only a gateway on this machine or a private "
            f"network, given by IP address or as localhost, but PCC_BASE is {pcc_base!r}: {why}. "
            f"Never point {name} at a public PCC gateway."
        )
    ot2 = None
    if ot2_base is not None:
        ot2, why = local_base(ot2_base)
        if ot2 is None:
            return _robot_refusal(ot2_base, why)
    GUARD.mode, GUARD.pcc_base, GUARD.ot2_base, GUARD.external = "relay", pcc, ot2, []
    return None


def start_interactive(argv, ot2_base, name):
    """The agent's local modes (interactive chat, health): the robot, no PCC.
    Requires the same flag, because the LLM they drive holds a shell."""
    refusal = _flag_refusal(argv, name)
    if refusal:
        return refusal
    ot2, why = local_base(ot2_base)
    if ot2 is None:
        return _robot_refusal(ot2_base, why)
    GUARD.mode, GUARD.pcc_base, GUARD.ot2_base, GUARD.external = "interactive", None, ot2, []
    return None


def allow_external(origin):
    """After a start, allow one fixed https origin (scheme://host, default port)."""
    require_mode("allow_external()")
    parts = urlsplit(origin)
    if parts.scheme != "https" or not parts.hostname or parts.path not in ("", "/") or parts.port or "@" in parts.netloc:
        raise ValueError(f"external origins must be a bare https origin, not {origin!r}")
    GUARD.external.append(f"https://{parts.hostname}")


def require_mode(what):
    """Exit 2 unless start_guard() or start_interactive() accepted this process."""
    if GUARD.mode is None:
        _refuse(
            f"REFUSED: {what} runs only after a start was accepted ({UNSAFE_LOCAL_FLAG} and "
            "local addresses). See scripts/README-ot2-executor.md."
        )
    return GUARD.mode


def require_started(what):
    """Exit 2 unless start_guard() authorised a PCC gateway for this process."""
    if GUARD.mode != "relay" or GUARD.pcc_base is None:
        _refuse(
            f"REFUSED: {what} runs only after start_guard() accepted {UNSAFE_LOCAL_FLAG} and a "
            "local PCC_BASE for this process. See scripts/README-ot2-executor.md."
        )
    return GUARD.pcc_base


def require_robot(what):
    """Exit 2 unless a local robot base was accepted for this process."""
    if GUARD.mode is None or GUARD.ot2_base is None:
        _refuse(
            f"REFUSED: {what} runs only after a start accepted {UNSAFE_LOCAL_FLAG} and a local "
            "OT2_BASE for this process. See scripts/README-ot2-executor.md."
        )
    return GUARD.ot2_base


def _authorized(url):
    """True when `url` is under a base or origin this process was authorised for."""
    try:
        parts = urlsplit(url)
        _ = parts.port
    except ValueError:
        return False
    if "@" in parts.netloc or "%" in parts.netloc or parts.fragment:
        return False
    if any(seg in (".", "..") for seg in parts.path.split("/")) or "%2e" in parts.path.lower():
        return False
    target = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    for base in (GUARD.pcc_base, GUARD.ot2_base):
        if base and (target == base or target.startswith(base + "/")):
            return True
    for origin in GUARD.external:
        if target == origin or target.startswith(origin + "/"):
            return True
    return False


class _RefuseRedirects(HTTPRedirectHandler):
    """Never follow a redirect: the 3xx is returned to the caller as an HTTP error."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_opener():
    """The only transport: no proxies from the environment, no redirects, verified TLS."""
    context = ssl.create_default_context(cafile=os.environ.get("PCC_CA_FILE") or None)
    return build_opener(ProxyHandler({}), _RefuseRedirects(), HTTPSHandler(context=context))


_OPENER = None


def _opener():
    global _OPENER
    if _OPENER is None:
        _OPENER = make_opener()
    return _OPENER


def _decode(raw):
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def request(method, url, data=None, headers=None, timeout=30):
    """The only network path. Returns (status, parsed_body); status 0 on a transport error.
    Exits 2 before any connection when no start was accepted or the URL is not authorised."""
    require_mode("an HTTP request")
    if not _authorized(url):
        _refuse(f"REFUSED: {method} to {url!r} is outside the bases this process was started for.")
    req = Request(url, data=data, headers=dict(headers or {}), method=method)
    try:
        with _opener().open(req, timeout=timeout) as resp:
            return resp.status, _decode(resp.read())
    except HTTPError as e:
        return e.code, _decode(e.read())
    except Exception as e:  # URLError, TLS, a malformed response: a failed call, as before
        return 0, {"error": str(e)}


def http(method, url, body=None, headers=None, timeout=30, user_agent="PCC-OT2"):
    """A JSON request through :func:`request`."""
    hdrs = dict(headers or {})
    hdrs.setdefault("User-Agent", user_agent)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    return request(method, url, data, hdrs, timeout)


def upload_protocol(ot2_api_version, filename, content, user_agent="PCC-OT2", timeout=60):
    """POST one protocol file to the robot's /protocols as multipart/form-data, through
    :func:`request`. The file never touches disk; its name must be a plain file name."""
    base = require_robot("a protocol upload")
    if not isinstance(filename, str) or not _SAFE_FILENAME.match(filename) or ".." in filename:
        return 0, {"error": f"refused filename {filename!r}: use a plain name such as protocol.py"}
    payload = content.encode("utf-8") if isinstance(content, str) else bytes(content)
    boundary = "pcc-" + uuid.uuid4().hex
    body = b"".join(
        [
            f"--{boundary}\r\n".encode("ascii"),
            f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'.encode("ascii"),
            b"Content-Type: application/octet-stream\r\n\r\n",
            payload,
            f"\r\n--{boundary}--\r\n".encode("ascii"),
        ]
    )
    headers = {
        "opentrons-version": ot2_api_version,
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "User-Agent": user_agent,
    }
    return request("POST", f"{base}/protocols", body, headers, timeout)
