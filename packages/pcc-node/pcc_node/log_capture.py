"""Machine-log signing primitives: the node's Ed25519 key on the settlement path.

This module holds the Ed25519 signing primitive used to PROVE possession of the
node's machine-log signing key at registration (#235) and to sign each captured
log entry hash. The node's Ed25519 key (``crypto.load_or_create_keys`` /
``pcc-keys.json``) is the key that signs the ``machine.execution_log`` hash chain
the oracle reconstructs and verifies to release settlement — so it is the key the
gateway must have on record.

Signing is Ed25519 ONLY. The HMAC-SHA256 dev fallback in ``crypto.py`` is REFUSED
on the signing/proof path: an HMAC value the oracle would treat as an Ed25519
signature is a forged-evidence hazard on a settlement path. pynacl is mandatory
here; if it is unavailable (or the loaded key is an HMAC-fallback key), signing
raises :class:`LogSigningRefused` — fail CLOSED.

No EIP-191 / domain prefix — the raw UTF-8 bytes of the message are signed, per
the wire contract shared with the gateway's registration verifier.

Scope note: the full tamper-evident hash-chain producer (the ``LogCapture`` class,
its canonicalization and TS byte-parity goldens — the ``machine.execution_log``
#52 producer) is a separate follow-up. This module ports only the signing
primitives #235 depends on, so the registration proof lands independently.
"""

import logging

log = logging.getLogger("pcc-node.log_capture")

_HAS_NACL = False
try:
    import nacl.signing
    import nacl.encoding
    _HAS_NACL = True
except ImportError:  # pragma: no cover - exercised via monkeypatch in tests
    pass


class LogSigningRefused(RuntimeError):
    """Raised when Ed25519 signing is unavailable or the key is not a genuine
    Ed25519 keypair (e.g. the HMAC dev fallback).

    Fail CLOSED on the money path rather than emit a "signature" the oracle
    would misread as Ed25519.
    """


# ---------------------------------------------------------------------------
# Ed25519 signing  (HMAC dev fallback REFUSED -- money path, fail closed)
# ---------------------------------------------------------------------------

def _strip0x(h):
    return h[2:] if isinstance(h, str) and h.lower().startswith("0x") else h


def assert_ed25519_available(public_hex, secret_hex):
    """Guarantee the signing path is genuine Ed25519, else refuse (fail closed).

    Two refusal cases -- both are the "HMAC dev fallback" hazard:

      1. pynacl is not installed -> cannot produce an Ed25519 signature at all.
      2. pynacl IS installed but the loaded key is an HMAC-fallback key
         (``crypto.py`` generates ``public = sha256(secret)`` in that mode), so
         the Ed25519 public derived from ``secret`` does NOT match
         ``public_hex``. Signing anyway would emit a ``signer`` that mismatches
         the registered key -> the oracle fails closed on it; refuse up front
         with a clear error rather than emit a bogus "ed25519" signature.
    """
    if not _HAS_NACL:
        raise LogSigningRefused(
            "pynacl is not installed; refusing to sign with the HMAC-SHA256 dev "
            "fallback. Ed25519 is mandatory on the settlement path -- install "
            "it: pip install 'pcc-node[crypto]'."
        )
    pub = _strip0x(public_hex).lower()
    try:
        derived = (
            nacl.signing.SigningKey(bytes.fromhex(secret_hex))
            .verify_key.encode(nacl.encoding.HexEncoder)
            .decode("ascii")
            .lower()
        )
    except Exception as e:  # malformed / wrong-length secret
        raise LogSigningRefused(f"secret key is not a valid Ed25519 seed: {e}")
    if derived != pub:
        raise LogSigningRefused(
            "loaded key is not a genuine Ed25519 keypair (public does not match "
            "secret) -- this is the HMAC dev fallback; refusing to sign the "
            "settlement evidence."
        )


def sign_ed25519_utf8(message, public_hex, secret_hex):
    """Detached Ed25519 signature over the UTF-8 bytes of ``message``, hex.

    Refuses (:class:`LogSigningRefused`) unless a genuine Ed25519 keypair is
    available. Used for BOTH the per-entry log signature (message = entryHash
    string) and the registration proof (message = challenge string). No EIP-191
    / domain prefix -- the raw UTF-8 bytes are signed, per the wire contract.
    """
    assert_ed25519_available(public_hex, secret_hex)
    sk = nacl.signing.SigningKey(bytes.fromhex(secret_hex))
    return sk.sign(message.encode("utf-8")).signature.hex()
