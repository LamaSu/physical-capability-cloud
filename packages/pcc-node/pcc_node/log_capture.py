"""Machine-log capture: kernel-signed SHA-256 hash chain (evidence #52 producer).

This is the PRODUCER that primitive #52 (``machine.execution_log``) verifies.
It builds a tamper-evident hash chain over captured log lines, signs each entry
hash with the node's Ed25519 key, and emits ``log_hash_chain_entry`` evidence
events that the oracle reconstructs and verifies to release settlement.

MONEY PATH -- byte-exact Python<->TS hash parity is MANDATORY. The entry-hash
formula and the canonicalization mirror, exactly:

  * ``packages/spec/src/util/canonical.ts``                 (canonicalize)
  * ``packages/spec/src/evidence/verifiers/log-chain.ts``   (computeLogEntryHash,
    GENESIS_HASH)

Do NOT change the canonicalization without regenerating the TS goldens and
re-proving parity (``tests/gen_goldens.mjs`` + ``tests/test_log_capture_parity.py``).
A producer whose hashes do not byte-match the TS verifier makes the whole
settlement lane worthless.

Signing is Ed25519 ONLY. The HMAC-SHA256 dev fallback in ``crypto.py`` is
REFUSED on the signing/proof path: an HMAC value the oracle would treat as an
Ed25519 signature is a forged-evidence hazard on a settlement path. pynacl is
mandatory here; if it is unavailable (or the loaded key is an HMAC-fallback
key), signing raises :class:`LogSigningRefused` -- fail CLOSED.
"""

import hashlib
import json
import logging

log = logging.getLogger("pcc-node.log_capture")

_HAS_NACL = False
try:
    import nacl.signing
    import nacl.encoding
    _HAS_NACL = True
except ImportError:  # pragma: no cover - exercised via monkeypatch in tests
    pass


# The previousHash sentinel for the first entry in a chain. Mirrors
# GENESIS_HASH in packages/spec/src/evidence/verifiers/log-chain.ts:30.
GENESIS = "sha256:" + "0" * 64


class LogSigningRefused(RuntimeError):
    """Raised when Ed25519 signing is unavailable or the key is not a genuine
    Ed25519 keypair (e.g. the HMAC dev fallback).

    Fail CLOSED on the money path rather than emit a "signature" the oracle
    would misread as Ed25519.
    """


# ---------------------------------------------------------------------------
# Canonicalization  (faithful Python mirror of spec/src/util/canonical.ts)
# ---------------------------------------------------------------------------

def _json_string(s):
    """JS ``JSON.stringify(<string>)`` equivalent.

    ``json.dumps(s, ensure_ascii=False)`` escapes exactly the set JS escapes:
    ``"`` ``\\`` and control chars U+0000-U+001F (with the ``\\b \\t \\n \\f
    \\r`` shortcuts, else ``\\u00xx`` lowercase). Non-ASCII is emitted raw
    (UTF-8); ``/`` is NOT escaped. ``separators`` are irrelevant for a bare
    string but passed for intent-parity with the binding wire contract.
    """
    return json.dumps(s, ensure_ascii=False, separators=(",", ":"))


def _number_string(n):
    """JS ``String(<number>)`` equivalent for the values this producer emits.

    Only strings are hashed in the #52 entry payload, so the number path is not
    parity-critical for the money seam; it is provided for a faithful mirror.
    JS has one numeric type: an integer-valued float renders without a
    fractional part (``String(5.0) === "5"``), unlike Python ``str(5.0) ==
    "5.0"`` -- normalized here. NaN/Infinity follow ``String()`` (raw JSON has
    no such literals, but canonicalize predates JSON.stringify here, matching TS).
    """
    if n != n:  # NaN
        return "NaN"
    if n == float("inf"):
        return "Infinity"
    if n == float("-inf"):
        return "-Infinity"
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return repr(n) if isinstance(n, float) else str(n)


def canonicalize(value):
    """Deterministic JSON string: keys sorted lexicographically at all depths,
    no whitespace. Byte-identical to ``canonicalize()`` in
    ``packages/spec/src/util/canonical.ts`` (proven by ``tests/goldens.json``).

    Rules (from canonical.ts):
      1. ``None`` -> ``"null"`` (JS ``null``/``undefined`` -> ``"null"``).
      2. ``str`` -> JS ``JSON.stringify``.
      3. ``bool``/number -> JS ``String()`` (``true``/``false`` / decimal).
      4. array -> ``[`` elems joined by ``,`` ``]``.
      5. object -> keys sorted, ``JSON.stringify(k)+":"+canonicalize(v)`` joined
         by ``,``, wrapped in ``{}``. (JS omits ``undefined`` values; Python has
         no ``undefined`` so ``None`` maps to JSON ``null`` and is INCLUDED.)
    """
    if value is None:
        return "null"
    # bool BEFORE int/float -- in Python ``bool`` is a subclass of ``int``.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, (int, float)):
        return _number_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        pairs = [
            _json_string(k) + ":" + canonicalize(value[k])
            for k in keys
        ]
        return "{" + ",".join(pairs) + "}"
    return str(value)


def sha256_hex(canonical):
    """``"sha256:" + lowercase-hex`` of the UTF-8 bytes of ``canonical``.

    Byte-identical to ``sha256()`` in canonical.ts (Web Crypto over UTF-8 bytes,
    lowercase hex, ``sha256:``-prefixed).
    """
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def compute_entry_hash(raw_content, source, captured_at):
    """``entryHash = sha256(canonicalize({capturedAt, rawContent, source}))``.

    Byte-identical to ``computeLogEntryHash()`` in
    ``packages/spec/src/evidence/verifiers/log-chain.ts:76``. Key insertion
    order here is irrelevant -- ``canonicalize`` sorts keys.
    """
    canonical = canonicalize({
        "capturedAt": captured_at,
        "rawContent": raw_content,
        "source": source,
    })
    return sha256_hex(canonical)


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


# ---------------------------------------------------------------------------
# The producer
# ---------------------------------------------------------------------------

class LogCapture:
    """Builds a kernel-signed SHA-256 hash chain and emits
    ``log_hash_chain_entry`` events (WIRE SHAPE 3). One instance == one chain.

    Construction fails fast (:class:`LogSigningRefused`) on a non-Ed25519 (HMAC
    fallback) key, so a node that cannot sign never starts producing a chain.
    """

    def __init__(self, public_hex, secret_hex):
        assert_ed25519_available(public_hex, secret_hex)
        self._public_hex = _strip0x(public_hex).lower()
        self._secret_hex = secret_hex
        self._previous_hash = GENESIS
        self._counter = 0

    @property
    def signer(self):
        """ed25519 signer == ``"0x" + 64-hex`` raw pubkey (lowercase), the SAME
        string as the registry ``publicKey`` (WIRE SHAPE 2)."""
        return "0x" + self._public_hex

    @property
    def previous_hash(self):
        """The entryHash the next captured entry will link back to (GENESIS
        before any entry has been captured)."""
        return self._previous_hash

    def capture(self, raw_content, source, captured_at, entry_id=None,
                emitted_at=None, redacted=False):
        """Capture one log line -> a signed chain entry -> an evidence event.

        ``redacted=True`` omits ``rawContent`` from the payload
        (``disclosure:redacted-commit``): the hash still commits to the content,
        but the content is not disclosed. ``entryHash`` is ALWAYS computed from
        the real ``raw_content``.

        Returns the ``log_hash_chain_entry`` event dict (WIRE SHAPE 3).
        """
        entry_hash = compute_entry_hash(raw_content, source, captured_at)
        value = sign_ed25519_utf8(entry_hash, self._public_hex, self._secret_hex)
        eid = entry_id if entry_id is not None else f"entry-{self._counter}"
        payload = {
            "entryId": eid,
            "entryHash": entry_hash,
            "previousHash": self._previous_hash,
            "source": source,
            "capturedAt": captured_at,
            "kernelSignature": {
                "signer": self.signer,
                "algorithm": "ed25519",
                "value": value,
            },
        }
        if not redacted:
            payload["rawContent"] = raw_content
        event = {
            "type": "log_hash_chain_entry",
            "timestamp": emitted_at if emitted_at is not None else captured_at,
            "payload": payload,
        }
        self._previous_hash = entry_hash
        self._counter += 1
        return event
