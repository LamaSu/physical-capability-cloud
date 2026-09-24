"""N4a: keep the legacy OT-2 relay scripts on the local network.

ot2-executor.py and ot2-agent.py run whatever the PCC relay hands them,
including shell commands and protocol uploads (an Opentrons protocol is Python
code). Until status board row N4b-robot replaces them, they may only talk to a
PCC gateway and a robot on this machine or a private network, and only when a
person starts them with --unsafe-local. See scripts/README-ot2-executor.md.

What the guard enforces, after coord-watch's review of PR #372:

- The destination is checked as it will be dialled. A base URL is accepted only
  when its host is an IP literal in canonical form inside LOCAL_NETWORKS, or the
  name "localhost", which is pinned to 127.0.0.1. Nothing is resolved through
  DNS, and requests go to the canonical address that was checked. Integer, hex
  and octal spellings, bare names, *.local, 0.0.0.0 and IPv4-mapped IPv6 are
  refused.
- One transport for every request: it ignores the proxy environment variables,
  refuses every redirect (the 3xx comes back as the response) and verifies TLS.
  PCC_CA_FILE adds a CA for a local gateway with its own certificate.
- Nothing runs before a start is authorised. The PCC and robot request helpers,
  and the scripts' polling loops, refuse (exit 2) unless start_guard() accepted
  this process, so importing a script and calling its loop does nothing.
"""

import ipaddress
import os
import ssl
import sys
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, build_opener

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


class _Guard:
    """Canonical bases this process is allowed to reach; None until authorised."""

    def __init__(self):
        self.pcc_base = None
        self.ot2_base = None


GUARD = _Guard()


def local_base(url):
    """Return (canonical_base, None) when `url` is a local base URL, else (None, reason)."""
    try:
        parts = urlsplit(url or "")
        host = parts.hostname
        port = parts.port
    except ValueError as err:
        return None, f"cannot parse it ({err})"
    if parts.scheme not in ("http", "https"):
        return None, "it must start with http:// or https://"
    if parts.username is not None or parts.password is not None:
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


def start_guard(argv, pcc_base, name, ot2_base=None):
    """Authorise this process and return None, or return the reason it must not start."""
    if UNSAFE_LOCAL_FLAG not in argv:
        return (
            f"REFUSED: {name} is not safe to run. Any PCC API key holder could make it run "
            "shell commands and arbitrary protocols on this robot (status board row N4b). "
            "For development against a gateway on your own machine or private network, "
            f"re-run with {UNSAFE_LOCAL_FLAG}. See scripts/README-ot2-executor.md."
        )
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
            return (
                f"REFUSED: OT2_BASE must be the robot on this machine or a private network, "
                f"given by IP address or as localhost, but it is {ot2_base!r}: {why}."
            )
    GUARD.pcc_base = pcc
    GUARD.ot2_base = ot2
    return None


def allow_robot(ot2_base):
    """For local-only modes (no PCC): authorise the robot base alone. Returns a refusal or None."""
    ot2, why = local_base(ot2_base)
    if ot2 is None:
        return (
            f"REFUSED: OT2_BASE must be the robot on this machine or a private network, "
            f"given by IP address or as localhost, but it is {ot2_base!r}: {why}."
        )
    GUARD.ot2_base = ot2
    return None


def _refuse(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(2)


def require_started(what):
    """Exit 2 unless start_guard() authorised a PCC gateway for this process."""
    if GUARD.pcc_base is None:
        _refuse(
            f"REFUSED: {what} runs only after start_guard() accepted {UNSAFE_LOCAL_FLAG} and a "
            "local PCC_BASE for this process. See scripts/README-ot2-executor.md."
        )
    return GUARD.pcc_base


def require_robot(what):
    """Exit 2 unless a local robot base was authorised for this process."""
    if GUARD.ot2_base is None:
        _refuse(
            f"REFUSED: {what} runs only after a local OT2_BASE was accepted for this process. "
            "See scripts/README-ot2-executor.md."
        )
    return GUARD.ot2_base


class _RefuseRedirects(HTTPRedirectHandler):
    """Never follow a redirect: the 3xx is returned to the caller as an HTTP error."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_opener():
    """The only transport: no proxies from the environment, no redirects, verified TLS."""
    context = ssl.create_default_context(cafile=os.environ.get("PCC_CA_FILE") or None)
    return build_opener(ProxyHandler({}), _RefuseRedirects(), HTTPSHandler(context=context))
