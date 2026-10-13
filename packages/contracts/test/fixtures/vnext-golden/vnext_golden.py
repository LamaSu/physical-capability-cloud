#!/usr/bin/env python3
"""
vnext_golden.py -- V-next settlement golden vectors, INDEPENDENT CLEAN-ROOM implementation.

Only source read: docs/VNEXT_SETTLEMENT_ABI.md
(plus the task brief, which supplied the CREATE/RLP rule and the CREATE + keccak("abc") anchors).
No .sol file, no TypeScript file, no package source and no private repository was read.

Pure Python 3 standard library. Everything below is written here from first principles:
  * Keccak-f[1600] + sponge (rate 1088 bits, ORIGINAL Keccak padding 0x01 ... 0x80).
    Round constants and rho offsets are GENERATED from the FIPS 202 algorithms, not pasted.
  * Solidity ABI encoder (abi.encode): static words, bytes/string, dynamic and fixed arrays,
    tuples with head/tail offsets.
  * RLP (for CREATE addresses) and CREATE2.
  * A small EIP-712 hashStruct, used only as an internal cross-check of spec 3 steps 6-8.
hashlib is used ONLY to cross-check the permutation through NIST SHA3-256 (padding 0x06). It is
never used as keccak.

Run:
    python3 packages/contracts/test/fixtures/vnext-golden/vnext_golden.py

Prints the anchor results, then the JSON. If (and only if) every anchor passes, it also writes
vnext-golden-vectors.json next to this file. Exit code 0 on success, 1 on any anchor failure
(nothing is written in that case).
"""

import hashlib
import json
import os
import sys

# =============================================================================
# 1. Keccak-f[1600] and the sponge
# =============================================================================

MASK64 = (1 << 64) - 1


def _rol64(v, n):
    n %= 64
    if n == 0:
        return v
    return ((v << n) | (v >> (64 - n))) & MASK64


def _rc(t):
    """FIPS 202 Algorithm 5: rc(t) = output bit of the LFSR x^8 + x^6 + x^5 + x^4 + 1."""
    t %= 255
    if t == 0:
        return 1
    r = [1, 0, 0, 0, 0, 0, 0, 0]
    for _ in range(t):
        r = [0] + r  # R = 0 || R (9 bits)
        r[0] ^= r[8]
        r[4] ^= r[8]
        r[5] ^= r[8]
        r[6] ^= r[8]
        r = r[:8]  # Trunc_8
    return r[0]


def _round_constants():
    """FIPS 202 Algorithm 6 (iota) with l = 6 (w = 64): RC[2^j - 1] = rc(j + 7*ir)."""
    out = []
    for ir in range(24):
        rc = 0
        for j in range(7):
            if _rc(j + 7 * ir):
                rc |= 1 << ((1 << j) - 1)
        out.append(rc)
    return out


def _rotation_offsets():
    """FIPS 202 Algorithm 2 (rho): offset r[x][y]; (x, y) walks from (1, 0)."""
    r = [[0] * 5 for _ in range(5)]
    x, y = 1, 0
    for t in range(24):
        r[x][y] = ((t + 1) * (t + 2) // 2) % 64
        x, y = y, (2 * x + 3 * y) % 5
    return r


_RC = _round_constants()
_ROT = _rotation_offsets()


def keccak_f1600(lanes):
    """Keccak-f[1600] on 25 64-bit lanes; lane (x, y) lives at index x + 5*y."""
    a = list(lanes)
    for rnd in range(24):
        # theta
        c = [a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol64(c[(x + 1) % 5], 1) for x in range(5)]
        a = [a[i] ^ d[i % 5] for i in range(25)]
        # rho + pi: B[y, 2x + 3y] = rot(A[x, y], r[x][y])
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rol64(a[x + 5 * y], _ROT[x][y])
        # chi: A[x, y] = B[x, y] ^ (~B[x + 1, y] & B[x + 2, y])
        a = [
            b[i]
            ^ ((~b[(i % 5 + 1) % 5 + 5 * (i // 5)]) & b[(i % 5 + 2) % 5 + 5 * (i // 5)] & MASK64)
            for i in range(25)
        ]
        # iota
        a[0] ^= _RC[rnd]
    return a


def _sponge(data, first_pad_byte, rate_bytes=136, out_bytes=32):
    """Keccak[c = 512] sponge (rate 1088 bits = 136 bytes). Padding: first_pad_byte, zeros, then
    0x80 on the last byte of the block (merged by XOR into one byte when only one byte fits)."""
    data = bytes(data)
    q = rate_bytes - (len(data) % rate_bytes)  # 1 .. rate_bytes
    pad = bytearray(q)
    pad[0] ^= first_pad_byte
    pad[-1] ^= 0x80
    msg = data + bytes(pad)
    assert len(msg) % rate_bytes == 0
    state = [0] * 25
    for off in range(0, len(msg), rate_bytes):
        for i in range(rate_bytes // 8):
            state[i] ^= int.from_bytes(msg[off + 8 * i: off + 8 * i + 8], "little")
        state = keccak_f1600(state)
    squeezed = b"".join(lane.to_bytes(8, "little") for lane in state)
    return squeezed[:out_bytes]


def keccak256(data):
    """Ethereum Keccak-256: ORIGINAL Keccak padding 0x01 ... 0x80 (spec 0: NOT NIST SHA3-256)."""
    return _sponge(data, 0x01)


def sha3_256_own(data):
    """NIST SHA3-256 through the SAME permutation and sponge, padding 0x06 ... 0x80.
    Used only to cross-check the permutation against hashlib.sha3_256."""
    return _sponge(data, 0x06)


def kstr(s):
    """keccak256 of an ASCII string: raw bytes, no length prefix, no terminator (spec 1)."""
    return keccak256(s.encode("ascii"))


# =============================================================================
# 2. Solidity ABI encoder: abi.encode (head/tail), never abi.encodePacked
# =============================================================================


def _split_top_level(s):
    """Split a comma-separated type list at parenthesis depth 0."""
    parts, depth, cur = [], 0, []
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                raise ValueError("unbalanced type string: " + s)
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if depth != 0:
        raise ValueError("unbalanced type string: " + s)
    if cur or parts:
        parts.append("".join(cur))
    return parts


def parse_type(s):
    """Type string -> type tree. Kinds: uint, bool, address, fixedbytes, bytes, string, tuple, array."""
    s = s.strip()
    if not s:
        raise ValueError("empty type")
    if s.endswith("]"):
        i = s.rfind("[")
        dim = s[i + 1:-1]
        return ("array", parse_type(s[:i]), int(dim) if dim else None)
    if s.startswith("("):
        if not s.endswith(")"):
            raise ValueError("bad tuple type: " + s)
        return ("tuple", [parse_type(c) for c in _split_top_level(s[1:-1])])
    if s == "address":
        return ("address",)
    if s == "bool":
        return ("bool",)
    if s == "bytes":
        return ("bytes",)
    if s == "string":
        return ("string",)
    if s.startswith("uint"):
        bits = int(s[4:]) if len(s) > 4 else 256
        if bits % 8 or not 8 <= bits <= 256:
            raise ValueError("bad uint width: " + s)
        return ("uint", bits)
    if s.startswith("bytes"):
        n = int(s[5:])
        if not 1 <= n <= 32:
            raise ValueError("bad bytesN: " + s)
        return ("fixedbytes", n)
    raise ValueError("unsupported type: " + s)


def is_dynamic(t):
    k = t[0]
    if k in ("bytes", "string"):
        return True
    if k == "array":
        return t[2] is None or is_dynamic(t[1])
    if k == "tuple":
        return any(is_dynamic(c) for c in t[1])
    return False


def _static_size(t):
    k = t[0]
    if k == "tuple":
        return sum(_static_size(c) for c in t[1])
    if k == "array":
        return t[2] * _static_size(t[1])
    return 32


def _word(n):
    return n.to_bytes(32, "big")


def _pad_right(b):
    return b + b"\x00" * ((-len(b)) % 32)


def encode_value(t, v):
    k = t[0]
    if k == "uint":
        if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v < (1 << t[1]):
            raise ValueError("uint%d out of range: %r" % (t[1], v))
        return _word(v)  # left-padded to 32 bytes
    if k == "bool":
        if v is not True and v is not False:
            raise ValueError("bad bool: %r" % (v,))
        return _word(1 if v else 0)
    if k == "address":
        if not isinstance(v, (bytes, bytearray)) or len(v) != 20:
            raise ValueError("address must be 20 bytes")
        return b"\x00" * 12 + bytes(v)  # 12 zero bytes, then the 20 address bytes
    if k == "fixedbytes":
        if not isinstance(v, (bytes, bytearray)) or len(v) != t[1]:
            raise ValueError("bytes%d value must be %d bytes" % (t[1], t[1]))
        return bytes(v) + b"\x00" * (32 - t[1])  # bytesN is right-padded; bytes32 used as is
    if k == "bytes":
        v = bytes(v)
        return _word(len(v)) + _pad_right(v)
    if k == "string":
        raw = v.encode("utf-8")
        return _word(len(raw)) + _pad_right(raw)
    if k == "tuple":
        return encode_tuple(t[1], list(v))
    if k == "array":
        elem, n = t[1], t[2]
        v = list(v)
        if n is None:  # T[]: length word, then the elements encoded as a k-tuple
            return _word(len(v)) + encode_tuple([elem] * len(v), v)
        if len(v) != n:
            raise ValueError("fixed array length mismatch")
        return encode_tuple([elem] * n, v)
    raise ValueError("unsupported kind " + k)


def encode_tuple(types, values):
    """Head/tail encoding. A dynamic component's head is an offset measured from the first byte
    of THIS tuple's encoding (for an array body: from the first byte after the length word)."""
    if len(types) != len(values):
        raise ValueError("arity mismatch: %d types, %d values" % (len(types), len(values)))
    head_size = sum(32 if is_dynamic(t) else _static_size(t) for t in types)
    heads, tails, offset = [], [], head_size
    for t, v in zip(types, values):
        enc = encode_value(t, v)
        if is_dynamic(t):
            heads.append(_word(offset))
            tails.append(enc)
            offset += len(enc)
        else:
            assert len(enc) == _static_size(t)
            heads.append(enc)
    return b"".join(heads) + b"".join(tails)


def abi_encode(type_strs, values):
    """Solidity abi.encode(v1, ..., vk) = encoding of the parameter tuple (T1, ..., Tk).
    So abi.encode(x) of one dynamic x starts with the offset word 0x20 (spec 0)."""
    return encode_tuple([parse_type(s) for s in type_strs], list(values))


def selector(signature):
    return keccak256(signature.encode("ascii"))[:4]


# =============================================================================
# 3. RLP (CREATE) and CREATE2
# =============================================================================


def _rlp_bytes(b):
    b = bytes(b)
    if len(b) == 1 and b[0] < 0x80:
        return b
    if len(b) <= 55:
        return bytes([0x80 + len(b)]) + b
    ln = len(b).to_bytes((len(b).bit_length() + 7) // 8, "big")
    return bytes([0xB7 + len(ln)]) + ln + b


def _rlp_uint(n):
    """Scalar: big-endian with no leading zero bytes; 0 is the empty string (0x80)."""
    return _rlp_bytes(n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b"")


def _rlp_list(encoded_items):
    payload = b"".join(encoded_items)
    if len(payload) <= 55:
        return bytes([0xC0 + len(payload)]) + payload
    ln = len(payload).to_bytes((len(payload).bit_length() + 7) // 8, "big")
    return bytes([0xF7 + len(ln)]) + ln + payload


def create_preimage(sender, nonce):
    """rlp([sender (20-byte string), nonce])."""
    if len(sender) != 20:
        raise ValueError("sender must be 20 bytes")
    return _rlp_list([_rlp_bytes(sender), _rlp_uint(nonce)])


def create_address(sender, nonce):
    return keccak256(create_preimage(sender, nonce))[12:]


def create2_address(deployer, salt, init_code_hash):
    pre = b"\xff" + deployer + salt + init_code_hash
    assert len(pre) == 85
    return keccak256(pre)[12:]


# =============================================================================
# 4. Minimal EIP-712 (internal cross-check only)
# =============================================================================


def parse_eip712_struct(s):
    """'Name(t1 n1,t2 n2,...)' -> (Name, [(t1, n1), ...]). Single struct, no nesting."""
    name, rest = s.split("(", 1)
    if not rest.endswith(")"):
        raise ValueError("bad EIP-712 type string")
    body = rest[:-1]
    fields = [tuple(part.split(" ")) for part in body.split(",")] if body else []
    for f in fields:
        if len(f) != 2:
            raise ValueError("bad EIP-712 field: %r" % (f,))
    return name, fields


def eip712_encode_type(primary, types):
    deps = set()

    def walk(name):
        for ftype, _ in types[name]:
            base = ftype.split("[")[0]
            if base in types and base != primary and base not in deps:
                deps.add(base)
                walk(base)

    walk(primary)
    order = [primary] + sorted(deps)
    return "".join(n + "(" + ",".join(ft + " " + fn for ft, fn in types[n]) + ")" for n in order)


def eip712_hash_struct(primary, types, data):
    enc = keccak256(eip712_encode_type(primary, types).encode("ascii"))
    for ftype, fname in types[primary]:
        v = data[fname]
        if ftype == "string":
            enc += keccak256(v.encode("utf-8"))
        elif ftype == "bytes":
            enc += keccak256(bytes(v))
        elif ftype in types:
            enc += eip712_hash_struct(ftype, types, v)
        else:
            enc += abi_encode([ftype], [v])
    return keccak256(enc)


# =============================================================================
# 5. Helpers
# =============================================================================


def h(b):
    return "0x" + bytes(b).hex()


def addr(s):
    s = s[2:] if s[:2].lower() == "0x" else s
    if len(s) != 40:
        raise ValueError("address must be 40 hex chars: " + s)
    return bytes.fromhex(s)


def eip55(a):
    lower = a.hex()
    hh = keccak256(lower.encode("ascii")).hex()
    return "0x" + "".join(
        c.upper() if c in "abcdef" and int(hh[i], 16) >= 8 else c for i, c in enumerate(lower)
    )


ZERO32 = b"\x00" * 32
ZERO_ADDRESS = b"\x00" * 20

# =============================================================================
# 6. Spec section 1: constants (strings transcribed verbatim from the spec)
# =============================================================================

SPEC_STRINGS = {
    "SETTLEMENT_UNIT_DOMAIN": "PCC:vnext:settlement-unit:v1",
    "POLICY_SALT_DOMAIN": "PCC:vnext:policy-salt:v2",
    "POLICY_NONCE_DOMAIN": "PCC:vnext:policy-nonce:v1",
    "EVIDENCE_COMMITMENT_DOMAIN": "PCC:vnext:evidence-commitment:v1",
    "EIP712_DOMAIN_TYPEHASH": "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    "EIP712_NAME_HASH": "VNextSettlementEscrow",
    "EIP712_VERSION_HASH": "1",
    "JOB_POLICY_TYPEHASH": "JobPolicy(uint256 chainId,address factory,address implementation,address escrow,uint256 policyVersion,address payer,address operator,bytes32 jobIdHash,bytes32 termsHash,uint256 policyNonce,bytes32 prePolicyRoot,bytes32 unitsRoot,uint256 expiry,bytes32 acceptedPolicyDigest)",
}

SETTLEMENT_UNIT_DOMAIN = kstr(SPEC_STRINGS["SETTLEMENT_UNIT_DOMAIN"])
POLICY_SALT_DOMAIN = kstr(SPEC_STRINGS["POLICY_SALT_DOMAIN"])
POLICY_NONCE_DOMAIN = kstr(SPEC_STRINGS["POLICY_NONCE_DOMAIN"])
EVIDENCE_COMMITMENT_DOMAIN = kstr(SPEC_STRINGS["EVIDENCE_COMMITMENT_DOMAIN"])
EIP712_DOMAIN_TYPEHASH = kstr(SPEC_STRINGS["EIP712_DOMAIN_TYPEHASH"])
EIP712_NAME_HASH = kstr(SPEC_STRINGS["EIP712_NAME_HASH"])
EIP712_VERSION_HASH = kstr(SPEC_STRINGS["EIP712_VERSION_HASH"])
JOB_POLICY_TYPEHASH = kstr(SPEC_STRINGS["JOB_POLICY_TYPEHASH"])

POLICY_VERSION = 2  # uint256
DOMAIN_VERSION_V1 = 1  # uint8
FEE_BASIS_GROSS = 0  # uint8
ROUNDING_FLOOR = 0  # uint8
FEE_DENOMINATOR = 10000
MAX_FEE_BPS = 1000
MIN_BONDABLE_GROSS = 5
MAX_SETTLEMENT_UNITS = 16
MAX_PAYOUT_LEGS_PER_UNIT = 16
MAX_TOTAL_LEGS_PER_JOB = 256
MIN_RECLAIM_DELAY = 864000
MAX_RECLAIM_DELAY = 31536000
MAX_SIGNATURE_BYTES = 1024
MAX_CONFIG_BYTES = 26372
EVIDENCE_PACKAGE_FORMAT_V1 = 1  # uint8

# spec 4: claim classes and fixed leg indices
CLAIM_PRINCIPAL, CLAIM_FEE, CLAIM_REFUND, CLAIM_BOND, CLAIM_DELAY_COMP, CLAIM_BURN = 0, 1, 2, 3, 4, 5
LEG_FEE = 2**256 - 1
LEG_REFUND = 2**256 - 2
LEG_BOND = 2**256 - 3
LEG_DELAY_COMP = 2**256 - 4
LEG_BURN = 2**256 - 5

# spec 2 / 3 ABI tuple types (verbatim)
PAYOUT_ENTRY_T = "(address,uint256)"
UNIT_CONFIG_T = "(uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])"
UNIT_CONFIG_ARRAY_T = "(uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])[]"
POLICY_IDENTITY_T = "(address,address,bytes32,bytes32,uint256,bytes32,bytes32)"
POLICY_ACCEPTANCE_T = "(uint256,bytes,bytes)"

# spec 7 selector table (contract, signature), verbatim and in table order
SIGNATURES = [
    ("factory", "createEscrow((address,address,bytes32,bytes32,uint256,bytes32,bytes32))"),
    ("factory", "predictEscrow((address,address,bytes32,bytes32,uint256,bytes32,bytes32))"),
    ("factory", "saltOf((address,address,bytes32,bytes32,uint256,bytes32,bytes32))"),
    ("factory", "policyKey(address,address,bytes32)"),
    ("factory", "revokePolicy(address,address,bytes32,uint256)"),
    ("escrow", "fund((uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])[],(uint256,bytes,bytes))"),
    ("escrow", "policy()"),
    ("escrow", "unitState(bytes32)"),
    ("escrow", "unitCount()"),
    ("escrow", "unitIdAt(uint256)"),
    ("escrow", "unitTerms(bytes32)"),
    ("escrow", "feeScheduleHashOf(bytes32)"),
    ("escrow", "payoutAt(bytes32,uint256)"),
    ("escrow", "finalize(bytes32)"),
    ("escrow", "reclaimAfterDeadline(bytes32)"),
    ("escrow", "dischargeClaim(bytes32)"),
]

# =============================================================================
# 7. Spec sections 3 and 4 as functions
# =============================================================================


def settlement_unit_id(chain_id, escrow, job_id_hash, milestone_index, step_id):
    """Spec 3 step 4."""
    return keccak256(abi_encode(
        ["bytes32", "uint256", "address", "bytes32", "uint256", "bytes32"],
        [SETTLEMENT_UNIT_DOMAIN, chain_id, escrow, job_id_hash, milestone_index, step_id]))


def evidence_commitment(chain_id, escrow, unit_id, schema_version, package_format, package_digest):
    """Spec 4: seven static words."""
    return keccak256(abi_encode(
        ["bytes32", "uint256", "address", "bytes32", "uint16", "uint8", "bytes32"],
        [EVIDENCE_COMMITMENT_DOMAIN, chain_id, escrow, unit_id, schema_version, package_format,
         package_digest]))


def claim_id(chain_id, escrow, unit_id, leg_index, claim_class):
    """Spec 4."""
    return keccak256(abi_encode(
        ["uint256", "address", "bytes32", "uint256", "uint8"],
        [chain_id, escrow, unit_id, leg_index, claim_class]))


def fee_schedule_hash(chain_id, escrow, unit_id, u):
    """Spec 4: thirteen static words (FeeSchedule field order from spec 2)."""
    return keccak256(abi_encode(
        ["uint8", "uint256", "address", "bytes32", "uint8", "uint256", "uint256", "uint256",
         "uint16", "uint256", "uint8", "address", "bytes32"],
        [DOMAIN_VERSION_V1, chain_id, escrow, unit_id, FEE_BASIS_GROSS, u["g"], u["f"], u["n"],
         u["feeBps"], FEE_DENOMINATOR, ROUNDING_FLOOR, u["feeRecipient"], ZERO32]))


def payout_config_hash(unit_id, payouts):
    """Spec 4: head = unitId, offset 0x40; tail = length, entries."""
    return keccak256(abi_encode(["bytes32", "(address,uint256)[]"], [unit_id, payouts]))


# =============================================================================
# 8. Anchors (must ALL pass before any output is trusted)
# =============================================================================

SHA3_VECTORS = [
    ("len 0", b""),
    ("len 3 'abc'", b"abc"),
    ("len 1 0x00", b"\x00"),
    ("len 135 (single pad byte 0x86)", b"\x61" * 135),
    ("len 136 (exactly one rate block)", b"\x61" * 136),
    ("len 137", b"\x61" * 137),
    ("len 272 (two full rate blocks)", bytes(range(256)) + bytes(range(16))),
    ("len 1000", bytes((i * 7 + 3) & 0xFF for i in range(1000))),
]


def _hexwords(*words):
    return "".join(words)


def run_anchors():
    anchors = []

    def anchor(name, expected, computed):
        anchors.append({"name": name, "expected": expected, "computed": computed,
                        "pass": expected.lower() == computed.lower()})

    # ---- required anchors: spec 8 table + the task's CREATE and keccak("abc") ----
    anchor('keccak256("") [spec 8]',
           "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
           h(keccak256(b"")))
    anchor('keccak256("abc") [task]',
           "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
           h(keccak256(b"abc")))
    anchor('POLICY_SALT_DOMAIN = keccak256("PCC:vnext:policy-salt:v2") [spec 8]',
           "0x9c545f70e44ba4292821022010c5750f92d0a3f2cbf06099ed1eaec2ba2ec8ef",
           h(POLICY_SALT_DOMAIN))
    anchor("EIP712_DOMAIN_TYPEHASH [spec 8]",
           "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
           h(EIP712_DOMAIN_TYPEHASH))
    anchor('EIP712_VERSION_HASH = keccak256("1") [spec 8]',
           "0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6",
           h(EIP712_VERSION_HASH))
    g1_escrow = addr("0x00000000000000000000000000000000000E5C0F")
    g1_unit = settlement_unit_id(8453, g1_escrow, kstr("golden-job"), 3, kstr("golden-step"))
    g1_commit = evidence_commitment(8453, g1_escrow, g1_unit, 1, 1, kstr("golden-evidence-package"))
    anchor("evidence commitment for the older gate-1 inputs [spec 8] "
           "(chainId 8453, escrow 0x...0E5C0F, jobIdHash=keccak256('golden-job'), milestoneIndex 3, "
           "stepId=keccak256('golden-step'), schema 1, format 1, packageDigest=keccak256('golden-evidence-package'))",
           "0xba4753b572b0d79518e05c88932d213125d0634a2c2fbbd7e74d7d52578eb7aa",
           h(g1_commit))
    anchor("CREATE(sender 0x00000000000000000000000000000000000000D0, nonce 0) [task]",
           "0xe61244BB1242d392fB53dF4979A62E955a9BC70d",
           h(create_address(addr("0x00000000000000000000000000000000000000D0"), 0)))

    # ---- permutation cross-check: same sponge with SHA3 padding vs hashlib.sha3_256 ----
    for label, data in SHA3_VECTORS:
        anchor("SHA3-256 permutation cross-check (own sponge, pad 0x06, vs hashlib.sha3_256): " + label,
               "0x" + hashlib.sha3_256(data).hexdigest(), h(sha3_256_own(data)))

    # ---- extra public-standard vectors (not from the spec; not from any PCC code) ----
    anchor("extra: keccak256('The quick brown fox jumps over the lazy dog') (public Keccak-256 test vector)",
           "0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
           h(kstr("The quick brown fox jumps over the lazy dog")))
    anchor("extra: selector transfer(address,uint256) (ERC-20)", "0xa9059cbb",
           h(selector("transfer(address,uint256)")))

    # EIP-712 reference example ('Ether Mail', from the EIP-712 text)
    mail_types = {
        "EIP712Domain": [("string", "name"), ("string", "version"), ("uint256", "chainId"),
                         ("address", "verifyingContract")],
        "Person": [("string", "name"), ("address", "wallet")],
        "Mail": [("Person", "from"), ("Person", "to"), ("string", "contents")],
    }
    mail_domain = {"name": "Ether Mail", "version": "1", "chainId": 1,
                   "verifyingContract": addr("0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC")}
    mail_msg = {"from": {"name": "Cow", "wallet": addr("0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826")},
                "to": {"name": "Bob", "wallet": addr("0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB")},
                "contents": "Hello, Bob!"}
    mail_ds = eip712_hash_struct("EIP712Domain", mail_types, mail_domain)
    mail_sh = eip712_hash_struct("Mail", mail_types, mail_msg)
    anchor("extra: EIP-712 'Ether Mail' example: domain separator",
           "0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f", h(mail_ds))
    anchor("extra: EIP-712 'Ether Mail' example: Mail typehash",
           "0xa0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2",
           h(keccak256(eip712_encode_type("Mail", mail_types).encode("ascii"))))
    anchor("extra: EIP-712 'Ether Mail' example: hashStruct(message)",
           "0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e", h(mail_sh))
    anchor("extra: EIP-712 'Ether Mail' example: digest keccak256(0x1901 || ds || hashStruct)",
           "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2",
           h(keccak256(b"\x19\x01" + mail_ds + mail_sh)))

    # Solidity ABI-spec examples (public Solidity documentation, 'Contract ABI Specification')
    def calldata(sig, types, values):
        return h(selector(sig) + abi_encode(types, values))

    anchor("extra: Solidity ABI-spec example baz(69, true)",
           "0xcdcd77c0" + _hexwords(
               "0000000000000000000000000000000000000000000000000000000000000045",
               "0000000000000000000000000000000000000000000000000000000000000001"),
           calldata("baz(uint32,bool)", ["uint32", "bool"], [69, True]))
    anchor("extra: Solidity ABI-spec example bar(['abc', 'def']) (bytes3[2])",
           "0xfce353f6" + _hexwords(
               "6162630000000000000000000000000000000000000000000000000000000000",
               "6465660000000000000000000000000000000000000000000000000000000000"),
           calldata("bar(bytes3[2])", ["bytes3[2]"], [[b"abc", b"def"]]))
    anchor("extra: Solidity ABI-spec example sam('dave', true, [1,2,3])",
           "0xa5643bf2" + _hexwords(
               "0000000000000000000000000000000000000000000000000000000000000060",
               "0000000000000000000000000000000000000000000000000000000000000001",
               "00000000000000000000000000000000000000000000000000000000000000a0",
               "0000000000000000000000000000000000000000000000000000000000000004",
               "6461766500000000000000000000000000000000000000000000000000000000",
               "0000000000000000000000000000000000000000000000000000000000000003",
               "0000000000000000000000000000000000000000000000000000000000000001",
               "0000000000000000000000000000000000000000000000000000000000000002",
               "0000000000000000000000000000000000000000000000000000000000000003"),
           calldata("sam(bytes,bool,uint256[])", ["bytes", "bool", "uint256[]"],
                    [b"dave", True, [1, 2, 3]]))
    anchor("extra: Solidity ABI-spec example f(0x123, [0x456, 0x789], '1234567890', 'Hello, world!')",
           "0x8be65246" + _hexwords(
               "0000000000000000000000000000000000000000000000000000000000000123",
               "0000000000000000000000000000000000000000000000000000000000000080",
               "3132333435363738393000000000000000000000000000000000000000000000",
               "00000000000000000000000000000000000000000000000000000000000000e0",
               "0000000000000000000000000000000000000000000000000000000000000002",
               "0000000000000000000000000000000000000000000000000000000000000456",
               "0000000000000000000000000000000000000000000000000000000000000789",
               "000000000000000000000000000000000000000000000000000000000000000d",
               "48656c6c6f2c20776f726c642100000000000000000000000000000000000000"),
           calldata("f(uint256,uint32[],bytes10,bytes)", ["uint256", "uint32[]", "bytes10", "bytes"],
                    [0x123, [0x456, 0x789], b"1234567890", b"Hello, world!"]))
    anchor("extra: Solidity ABI-spec example g([[1, 2], [3]], ['one', 'two', 'three']) (nested dynamic offsets)",
           "0x2289b18c" + _hexwords(
               "0000000000000000000000000000000000000000000000000000000000000040",
               "0000000000000000000000000000000000000000000000000000000000000140",
               "0000000000000000000000000000000000000000000000000000000000000002",
               "0000000000000000000000000000000000000000000000000000000000000040",
               "00000000000000000000000000000000000000000000000000000000000000a0",
               "0000000000000000000000000000000000000000000000000000000000000002",
               "0000000000000000000000000000000000000000000000000000000000000001",
               "0000000000000000000000000000000000000000000000000000000000000002",
               "0000000000000000000000000000000000000000000000000000000000000001",
               "0000000000000000000000000000000000000000000000000000000000000003",
               "0000000000000000000000000000000000000000000000000000000000000003",
               "0000000000000000000000000000000000000000000000000000000000000060",
               "00000000000000000000000000000000000000000000000000000000000000a0",
               "00000000000000000000000000000000000000000000000000000000000000e0",
               "0000000000000000000000000000000000000000000000000000000000000003",
               "6f6e650000000000000000000000000000000000000000000000000000000000",
               "0000000000000000000000000000000000000000000000000000000000000003",
               "74776f0000000000000000000000000000000000000000000000000000000000",
               "0000000000000000000000000000000000000000000000000000000000000005",
               "7468726565000000000000000000000000000000000000000000000000000000"),
           calldata("g(uint256[][],string[])", ["uint256[][]", "string[]"],
                    [[[1, 2], [3]], ["one", "two", "three"]]))
    return anchors


# =============================================================================
# 9. The golden computation (spec 8 inputs, spec 3 and 4 sequence)
# =============================================================================


def compute_golden():
    checks = []

    def check(name, ok, detail=""):
        checks.append({"name": name, "pass": bool(ok), "detail": detail})

    # ---- spec 8 inputs ----
    chain_id = 8453
    factory_deployer = addr("0x00000000000000000000000000000000000000D1")
    factory_pre = create_preimage(factory_deployer, 0)
    check("factory CREATE preimage is 0xd6 0x94 <deployer> 0x80",
          factory_pre == b"\xd6\x94" + factory_deployer + b"\x80", h(factory_pre))
    factory = keccak256(factory_pre)[12:]
    impl_pre = create_preimage(factory, 1)
    check("implementation CREATE preimage is 0xd6 0x94 <factory> 0x01",
          impl_pre == b"\xd6\x94" + factory + b"\x01", h(impl_pre))
    implementation = keccak256(impl_pre)[12:]

    payer = addr("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
    operator = addr("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")
    job_id_hash = kstr("pcc:vnext:golden:job")
    terms_hash = kstr("pcc:vnext:golden:terms")
    policy_nonce = 7
    accepted_policy_digest = kstr("pcc:vnext:golden:accepted-policy")
    expiry = 1900000000
    funding_time = 1800000000

    step_id_a = kstr("pcc:vnext:golden:step-a")
    step_id_b = kstr("pcc:vnext:golden:step-b")
    composition_root_a = kstr("pcc:vnext:golden:composition-root")
    package_digest = kstr("pcc:vnext:golden:evidence-package")
    evidence_schema_version_u0 = 3  # spec 8 evidence line
    evidence_format_u0 = 1  # spec 8 evidence line

    r1111 = addr("0x1111111111111111111111111111111111111111")
    r2222 = addr("0x2222222222222222222222222222222222222222")
    r3333 = addr("0x3333333333333333333333333333333333333333")
    r4444 = addr("0x4444444444444444444444444444444444444444")

    u0 = {
        "milestoneIndex": 0,
        "stepId": step_id_a,
        "requiredTier": 2,
        "requestedTier": 2,
        "g": 1000000003,
        "feeBps": 235,
        "feeRecipient": r4444,
        "reclaimAt": 1802592000,
        "compositionSchemaVersion": 3,
        "compositionRoot": composition_root_a,
        "payouts": [(r1111, 500000000), (r2222, 300000000), (r3333, 176500003)],
    }
    u1 = {
        "milestoneIndex": int("0102030405060708090a0b0c0d0e0f10", 16),
        "stepId": step_id_b,
        "requiredTier": 0,
        "requestedTier": 0,
        "g": 7,
        "feeBps": 0,
        "feeRecipient": ZERO_ADDRESS,
        "reclaimAt": 1831536000,
        "compositionSchemaVersion": 0,
        "compositionRoot": ZERO32,
        "payouts": [(r1111, 7)],
    }
    units = [u0, u1]
    for u in units:  # spec 2 / 5: derived, never copied
        u["f"] = u["g"] * u["feeBps"] // FEE_DENOMINATOR
        u["n"] = u["g"] - u["f"]

    # ---- spec consistency checks requested by the task ----
    rem0 = (u0["g"] * u0["feeBps"]) % FEE_DENOMINATOR
    check("f0 = floor(g0*feeBps0/10000) equals the stated 23500000 (remainder 705)",
          u0["f"] == 23500000 and rem0 == 705, "f0=%d remainder=%d" % (u0["f"], rem0))
    check("n0 = g0 - f0 equals the stated 976500003", u0["n"] == 976500003, "n0=%d" % u0["n"])
    s0 = sum(a for _, a in u0["payouts"])
    check("sum of unit 0 payouts == n0 (exact conservation)", s0 == u0["n"], "sum=%d n0=%d" % (s0, u0["n"]))
    check("f1 = 0 and n1 = 7 as stated", u1["f"] == 0 and u1["n"] == 7, "f1=%d n1=%d" % (u1["f"], u1["n"]))
    s1 = sum(a for _, a in u1["payouts"])
    check("sum of unit 1 payouts == n1", s1 == u1["n"], "sum=%d n1=%d" % (s1, u1["n"]))
    d0 = u0["reclaimAt"] - funding_time
    d1 = u1["reclaimAt"] - funding_time
    check("unit 0 reclaimAt - funding time == 30 days (stated 'funding + 30 days')",
          d0 == 30 * 86400, "delta=%d s" % d0)
    check("unit 1 reclaimAt - funding time == exactly 365 days == MAX_RECLAIM_DELAY",
          d1 == 365 * 86400 == MAX_RECLAIM_DELAY, "delta=%d s" % d1)
    check("MIN_RECLAIM_DELAY == (2 + 5 + 2 + 1) days; MAX_RECLAIM_DELAY == 365 days",
          MIN_RECLAIM_DELAY == 10 * 86400 and MAX_RECLAIM_DELAY == 365 * 86400)
    check("unit 1 milestoneIndex is above 2^53 (as stated)", u1["milestoneIndex"] > 2**53,
          "milestoneIndex=%d" % u1["milestoneIndex"])
    check("evidence schema version 3 (spec 8) == unit 0 compositionSchemaVersion; format == EVIDENCE_PACKAGE_FORMAT_V1",
          evidence_schema_version_u0 == u0["compositionSchemaVersion"]
          and evidence_format_u0 == EVIDENCE_PACKAGE_FORMAT_V1)

    # ---- spec 3 step 1: prePolicyRoot ----
    def config_tuple(u):
        return (u["milestoneIndex"], u["stepId"], u["requiredTier"], u["requestedTier"], u["g"],
                u["f"], u["n"], u["feeBps"], u["feeRecipient"], u["reclaimAt"],
                u["compositionSchemaVersion"], u["compositionRoot"], list(u["payouts"]))

    configs = [config_tuple(u) for u in units]
    check("UnitConfig[] type (spec 3 step 1) == UnitConfig tuple type (spec 2) + '[]'",
          UNIT_CONFIG_ARRAY_T == UNIT_CONFIG_T + "[]")
    enc = abi_encode([UNIT_CONFIG_ARRAY_T], [configs])
    pre_policy_root = keccak256(enc)
    unit0_len = (13 + 1 + 2 * len(u0["payouts"])) * 32
    u0_at = 64 + 0x40
    u1_at = 64 + 0x40 + unit0_len
    check("encoded configs: leading offset word 0x20, then length 2", enc[0:32] == _word(0x20) and enc[32:64] == _word(2))
    check("encoded configs: element offsets 0x40 and 0x40 + len(unit 0) (relative to after the length word)",
          enc[64:96] == _word(0x40) and enc[96:128] == _word(0x40 + unit0_len),
          "unit0 encoding = %d bytes" % unit0_len)
    check("encoded configs: payouts offset inside each UnitConfig == 13 words (0x1a0); payout counts 3 and 1",
          enc[u0_at + 12 * 32:u0_at + 13 * 32] == _word(0x1A0)
          and enc[u0_at + 13 * 32:u0_at + 14 * 32] == _word(3)
          and enc[u1_at + 12 * 32:u1_at + 13 * 32] == _word(0x1A0)
          and enc[u1_at + 13 * 32:u1_at + 14 * 32] == _word(1))
    check("encoded configs total length == 32 + 32 + 64 + 640 + 512 == 1280", len(enc) == 1280, "len=%d" % len(enc))

    # ---- spec 3 step 2: salt ----
    salt_pre = abi_encode(
        ["bytes32", "address", "address", "bytes32", "bytes32", "uint256", "bytes32", "bytes32"],
        [POLICY_SALT_DOMAIN, payer, operator, job_id_hash, terms_hash, policy_nonce, pre_policy_root,
         accepted_policy_digest])
    check("salt preimage is eight static words", len(salt_pre) == 8 * 32)
    salt = keccak256(salt_pre)

    # ---- spec 3 step 3: escrow (CREATE2 of an EIP-1167 minimal proxy) ----
    init_code = (bytes.fromhex("3d602d80600a3d3981f3363d3d373d3d3d363d73") + implementation
                 + bytes.fromhex("5af43d82803e903d91602b57fd5bf3"))
    check("EIP-1167 initCode is 55 bytes", len(init_code) == 55, "len=%d" % len(init_code))
    init_code_hash = keccak256(init_code)
    escrow = create2_address(factory, salt, init_code_hash)

    # ---- spec 3 step 4: unit ids ----
    unit_ids = [settlement_unit_id(chain_id, escrow, job_id_hash, u["milestoneIndex"], u["stepId"]) for u in units]
    check("settlement unit ids are pairwise distinct (DuplicateUnit)", len(set(unit_ids)) == len(unit_ids))
    check("(milestoneIndex, stepId) pairs are unique within the job",
          len({(u["milestoneIndex"], u["stepId"]) for u in units}) == len(units))

    # ---- spec 3 step 5: unitsRoot ----
    r = ZERO32
    for uid in unit_ids:
        r = keccak256(abi_encode(["bytes32", "bytes32"], [r, uid]))
    units_root = r

    # ---- spec 3 step 6: jobPolicyHash (fifteen static words) ----
    jp_pre = abi_encode(
        ["bytes32", "uint256", "address", "address", "address", "uint256", "address", "address",
         "bytes32", "bytes32", "uint256", "bytes32", "bytes32", "uint256", "bytes32"],
        [JOB_POLICY_TYPEHASH, chain_id, factory, implementation, escrow, POLICY_VERSION, payer,
         operator, job_id_hash, terms_hash, policy_nonce, pre_policy_root, units_root, expiry,
         accepted_policy_digest])
    check("jobPolicyHash preimage is fifteen static words", len(jp_pre) == 15 * 32)
    job_policy_hash = keccak256(jp_pre)

    # ---- spec 3 step 7: domain separator (verifyingContract = escrow clone) ----
    domain_separator = keccak256(abi_encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, chain_id, escrow]))

    # ---- spec 3 step 8: digest ----
    digest_pre = b"\x19\x01" + domain_separator + job_policy_hash
    check("EIP-712 digest preimage is 66 bytes", len(digest_pre) == 66)
    digest = keccak256(digest_pre)

    # ---- EIP-712 cross-check: generic hashStruct from the type strings == spec 3 steps 6/7 ----
    jp_name, jp_fields = parse_eip712_struct(SPEC_STRINGS["JOB_POLICY_TYPEHASH"])
    dom_name, dom_fields = parse_eip712_struct(SPEC_STRINGS["EIP712_DOMAIN_TYPEHASH"])
    types712 = {jp_name: jp_fields, dom_name: dom_fields}
    jp_values = {"chainId": chain_id, "factory": factory, "implementation": implementation,
                 "escrow": escrow, "policyVersion": POLICY_VERSION, "payer": payer,
                 "operator": operator, "jobIdHash": job_id_hash, "termsHash": terms_hash,
                 "policyNonce": policy_nonce, "prePolicyRoot": pre_policy_root,
                 "unitsRoot": units_root, "expiry": expiry,
                 "acceptedPolicyDigest": accepted_policy_digest}
    check("JobPolicy type string has 14 fields (typehash + 14 = the 15 words of spec 3 step 6)",
          jp_name == "JobPolicy" and len(jp_fields) == 14 and set(jp_values) == {n for _, n in jp_fields})
    check("generic EIP-712 hashStruct(JobPolicy) == spec 3 step 6 jobPolicyHash",
          eip712_hash_struct("JobPolicy", types712, jp_values) == job_policy_hash)
    check("generic EIP-712 hashStruct(EIP712Domain) == spec 3 step 7 domainSeparator",
          eip712_hash_struct("EIP712Domain", types712,
                             {"name": "VNextSettlementEscrow", "version": "1", "chainId": chain_id,
                              "verifyingContract": escrow}) == domain_separator)

    # ---- policyKey ----
    policy_key = keccak256(abi_encode(["bytes32", "address", "address", "bytes32"],
                                      [POLICY_NONCE_DOMAIN, payer, operator, job_id_hash]))

    # ---- spec 4 ----
    fee_hashes = [fee_schedule_hash(chain_id, escrow, uid, u) for uid, u in zip(unit_ids, units)]
    pc_pre0 = abi_encode(["bytes32", "(address,uint256)[]"], [unit_ids[0], u0["payouts"]])
    check("payoutConfigHash preimage head = unitId, offset 0x40; tail = length, entries",
          pc_pre0[0:32] == unit_ids[0] and pc_pre0[32:64] == _word(0x40) and pc_pre0[64:96] == _word(3)
          and len(pc_pre0) == (2 + 1 + 6) * 32)
    payout_hashes = [payout_config_hash(uid, u["payouts"]) for uid, u in zip(unit_ids, units)]
    claim_u0_p = [claim_id(chain_id, escrow, unit_ids[0], j, CLAIM_PRINCIPAL) for j in range(len(u0["payouts"]))]
    claim_u0_fee = claim_id(chain_id, escrow, unit_ids[0], LEG_FEE, CLAIM_FEE)
    claim_u0_refund = claim_id(chain_id, escrow, unit_ids[0], LEG_REFUND, CLAIM_REFUND)
    claim_u1_p0 = claim_id(chain_id, escrow, unit_ids[1], 0, CLAIM_PRINCIPAL)
    claim_u1_refund = claim_id(chain_id, escrow, unit_ids[1], LEG_REFUND, CLAIM_REFUND)
    evidence_u0 = evidence_commitment(chain_id, escrow, unit_ids[0], evidence_schema_version_u0,
                                      evidence_format_u0, package_digest)

    # ---- spec 5 funding rules on the golden job (fail-closed rules) ----
    def allowed(a):  # settlement token unknown (not a golden input): see specAmbiguities
        return a != ZERO_ADDRESS and a != escrow and a != factory

    check("1 <= unit count <= 16", 1 <= len(units) <= MAX_SETTLEMENT_UNITS)
    total_legs = sum(len(u["payouts"]) for u in units)
    check("total payout legs <= 256", total_legs <= MAX_TOTAL_LEGS_PER_JOB, "legs=%d" % total_legs)
    for i, u in enumerate(units):
        p = "unit %d: " % i
        check(p + "requiredTier <= 3 and requestedTier == requiredTier",
              u["requiredTier"] <= 3 and u["requestedTier"] == u["requiredTier"])
        check(p + "5 <= g <= 2^128 - 1", MIN_BONDABLE_GROSS <= u["g"] <= 2**128 - 1)
        check(p + "feeBps <= 1000", u["feeBps"] <= MAX_FEE_BPS)
        check(p + "n > 0", u["n"] > 0)
        if u["feeBps"] == 0:
            check(p + "feeBps == 0 -> f == 0 and feeRecipient == 0x0",
                  u["f"] == 0 and u["feeRecipient"] == ZERO_ADDRESS)
        else:
            check(p + "feeBps > 0 -> feeRecipient allowed (nonzero, != escrow, != factory)",
                  allowed(u["feeRecipient"]))
        check(p + "1..16 payout legs, each amount > 0, each recipient allowed",
              1 <= len(u["payouts"]) <= MAX_PAYOUT_LEGS_PER_UNIT
              and all(a > 0 and allowed(rc) for rc, a in u["payouts"]))
        check(p + "MIN_RECLAIM_DELAY <= reclaimAt - fundingTime <= MAX_RECLAIM_DELAY",
              MIN_RECLAIM_DELAY <= u["reclaimAt"] - funding_time <= MAX_RECLAIM_DELAY)
    check("payer nonzero; operator != payer; operator allowed",
          payer != ZERO_ADDRESS and operator != payer and allowed(operator))
    check("funding time <= expiry (block.timestamp <= expiry)", funding_time <= expiry)

    # ---- spec 7 signature/type consistency and fund() calldata size ----
    sig_map = dict((s, c) for c, s in SIGNATURES)
    fund_sig = "fund(" + UNIT_CONFIG_ARRAY_T + "," + POLICY_ACCEPTANCE_T + ")"
    check("spec 7 fund signature == fund(UnitConfig[] type from spec 3, PolicyAcceptance type from spec 2)",
          fund_sig in sig_map)
    check("spec 7 createEscrow/predictEscrow/saltOf take the spec 2 PolicyIdentity tuple",
          all(("%s(%s)" % (n, POLICY_IDENTITY_T)) in sig_map for n in ("createEscrow", "predictEscrow", "saltOf")))
    fund_calldata = selector(fund_sig) + abi_encode([UNIT_CONFIG_ARRAY_T, POLICY_ACCEPTANCE_T],
                                                    [configs, (expiry, b"\x00" * 65, b"\x00" * 65)])
    check("golden fund() calldata with two 65-byte signatures <= MAX_CONFIG_BYTES (26372)",
          len(fund_calldata) <= MAX_CONFIG_BYTES, "len=%d bytes" % len(fund_calldata))
    sels = [selector(s) for _, s in SIGNATURES]
    check("16 signatures in the spec 7 table, 16 distinct selectors", len(SIGNATURES) == 16 and len(set(sels)) == 16)

    # ---- informational: EIP-55 spellings in the spec/task are valid checksums ----
    check("EIP-55: payer spelling 0xf39Fd6e5...2266 is a valid checksum",
          eip55(payer) == "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", eip55(payer))
    check("EIP-55: operator spelling 0x70997970...79C8 is a valid checksum",
          eip55(operator) == "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", eip55(operator))
    ca = create_address(addr("0x00000000000000000000000000000000000000D0"), 0)
    check("EIP-55: CREATE-anchor spelling 0xe61244BB...C70d is a valid checksum",
          eip55(ca) == "0xe61244BB1242d392fB53dF4979A62E955a9BC70d", eip55(ca))

    # ---- second, independent code path: explicit 32-byte word concatenation, hand-computed
    #      offsets, no call into the generic ABI encoder. Every hash output must agree. ----
    def W(n):
        return n.to_bytes(32, "big")

    def A(a):
        return b"\x00" * 12 + a

    def unit_words(u):
        return (W(u["milestoneIndex"]) + u["stepId"] + W(u["requiredTier"]) + W(u["requestedTier"])
                + W(u["g"]) + W(u["f"]) + W(u["n"]) + W(u["feeBps"]) + A(u["feeRecipient"])
                + W(u["reclaimAt"]) + W(u["compositionSchemaVersion"]) + u["compositionRoot"]
                + W(0x1A0) + W(len(u["payouts"])) + b"".join(A(rc) + W(a) for rc, a in u["payouts"]))

    m_enc = W(0x20) + W(2) + W(0x40) + W(0x40 + 20 * 32) + unit_words(u0) + unit_words(u1)
    m_ppr = keccak256(m_enc)
    m_salt = keccak256(POLICY_SALT_DOMAIN + A(payer) + A(operator) + job_id_hash + terms_hash
                       + W(policy_nonce) + m_ppr + accepted_policy_digest)
    m_factory = keccak256(b"\xd6\x94" + factory_deployer + b"\x80")[12:]
    m_impl = keccak256(b"\xd6\x94" + m_factory + b"\x01")[12:]
    m_ich = keccak256(bytes.fromhex("3d602d80600a3d3981f3363d3d373d3d3d363d73") + m_impl
                      + bytes.fromhex("5af43d82803e903d91602b57fd5bf3"))
    m_escrow = keccak256(b"\xff" + m_factory + m_salt + m_ich)[12:]
    m_uid = [keccak256(SETTLEMENT_UNIT_DOMAIN + W(chain_id) + A(m_escrow) + job_id_hash
                       + W(u["milestoneIndex"]) + u["stepId"]) for u in units]
    m_root = keccak256(keccak256(ZERO32 + m_uid[0]) + m_uid[1])
    m_jph = keccak256(JOB_POLICY_TYPEHASH + W(chain_id) + A(m_factory) + A(m_impl) + A(m_escrow) + W(2)
                      + A(payer) + A(operator) + job_id_hash + terms_hash + W(policy_nonce) + m_ppr
                      + m_root + W(expiry) + accepted_policy_digest)
    m_ds = keccak256(EIP712_DOMAIN_TYPEHASH + EIP712_NAME_HASH + EIP712_VERSION_HASH + W(chain_id)
                     + A(m_escrow))
    m_digest = keccak256(b"\x19\x01" + m_ds + m_jph)
    m_pk = keccak256(POLICY_NONCE_DOMAIN + A(payer) + A(operator) + job_id_hash)
    m_fee = [keccak256(W(1) + W(chain_id) + A(m_escrow) + uid + W(0) + W(u["g"]) + W(u["f"]) + W(u["n"])
                       + W(u["feeBps"]) + W(10000) + W(0) + A(u["feeRecipient"]) + ZERO32)
             for uid, u in zip(m_uid, units)]
    m_pay = [keccak256(uid + W(0x40) + W(len(u["payouts"])) + b"".join(A(rc) + W(a) for rc, a in u["payouts"]))
             for uid, u in zip(m_uid, units)]

    def m_claim(uid, leg, cls):
        return keccak256(W(chain_id) + A(m_escrow) + uid + W(leg) + W(cls))

    m_ev = keccak256(EVIDENCE_COMMITMENT_DOMAIN + W(chain_id) + A(m_escrow) + m_uid[0] + W(3) + W(1)
                     + package_digest)
    pairs = [
        ("encodedConfigs", m_enc, enc), ("factory", m_factory, factory),
        ("implementation", m_impl, implementation), ("initCodeHash", m_ich, init_code_hash),
        ("prePolicyRoot", m_ppr, pre_policy_root), ("salt", m_salt, salt), ("escrow", m_escrow, escrow),
        ("unitId0", m_uid[0], unit_ids[0]), ("unitId1", m_uid[1], unit_ids[1]),
        ("unitsRoot", m_root, units_root), ("jobPolicyHash", m_jph, job_policy_hash),
        ("domainSeparator", m_ds, domain_separator), ("digest", m_digest, digest),
        ("policyKey", m_pk, policy_key), ("feeScheduleHash0", m_fee[0], fee_hashes[0]),
        ("feeScheduleHash1", m_fee[1], fee_hashes[1]), ("payoutConfigHash0", m_pay[0], payout_hashes[0]),
        ("payoutConfigHash1", m_pay[1], payout_hashes[1]),
        ("claimId_u0_principal0", m_claim(m_uid[0], 0, 0), claim_u0_p[0]),
        ("claimId_u0_principal1", m_claim(m_uid[0], 1, 0), claim_u0_p[1]),
        ("claimId_u0_principal2", m_claim(m_uid[0], 2, 0), claim_u0_p[2]),
        ("claimId_u0_fee", m_claim(m_uid[0], 2**256 - 1, 1), claim_u0_fee),
        ("claimId_u0_refund", m_claim(m_uid[0], 2**256 - 2, 2), claim_u0_refund),
        ("claimId_u1_principal0", m_claim(m_uid[1], 0, 0), claim_u1_p0),
        ("claimId_u1_refund", m_claim(m_uid[1], 2**256 - 2, 2), claim_u1_refund),
        ("evidenceCommitmentU0", m_ev, evidence_u0),
    ]
    mism = [n for n, a, b in pairs if a != b]
    check("second code path (explicit word concatenation, no generic encoder) reproduces encodedConfigs, "
          "factory, implementation and the %d other derived outputs" % (len(pairs) - 3),
          not mism, ("MISMATCH: " + ", ".join(mism)) if mism else "%d/%d agree" % (len(pairs), len(pairs)))

    constants = {
        "SETTLEMENT_UNIT_DOMAIN": h(SETTLEMENT_UNIT_DOMAIN),
        "POLICY_SALT_DOMAIN": h(POLICY_SALT_DOMAIN),
        "POLICY_NONCE_DOMAIN": h(POLICY_NONCE_DOMAIN),
        "EVIDENCE_COMMITMENT_DOMAIN": h(EVIDENCE_COMMITMENT_DOMAIN),
        "EIP712_DOMAIN_TYPEHASH": h(EIP712_DOMAIN_TYPEHASH),
        "EIP712_NAME_HASH": h(EIP712_NAME_HASH),
        "EIP712_VERSION_HASH": h(EIP712_VERSION_HASH),
        "JOB_POLICY_TYPEHASH": h(JOB_POLICY_TYPEHASH),
    }
    derived_inputs = {
        "jobIdHash": h(job_id_hash),
        "termsHash": h(terms_hash),
        "acceptedPolicyDigest": h(accepted_policy_digest),
        "stepIdA": h(step_id_a),
        "stepIdB": h(step_id_b),
        "compositionRoot": h(composition_root_a),
        "packageDigest": h(package_digest),
    }
    outputs = {
        "factory": h(factory),
        "implementation": h(implementation),
        "initCodeHash": h(init_code_hash),
        "prePolicyRoot": h(pre_policy_root),
        "salt": h(salt),
        "escrow": h(escrow),
        "unitId0": h(unit_ids[0]),
        "unitId1": h(unit_ids[1]),
        "unitsRoot": h(units_root),
        "jobPolicyHash": h(job_policy_hash),
        "domainSeparator": h(domain_separator),
        "digest": h(digest),
        "policyKey": h(policy_key),
        "feeScheduleHash0": h(fee_hashes[0]),
        "feeScheduleHash1": h(fee_hashes[1]),
        "payoutConfigHash0": h(payout_hashes[0]),
        "payoutConfigHash1": h(payout_hashes[1]),
        "claimId_u0_principal0": h(claim_u0_p[0]),
        "claimId_u0_principal1": h(claim_u0_p[1]),
        "claimId_u0_principal2": h(claim_u0_p[2]),
        "claimId_u0_fee": h(claim_u0_fee),
        "claimId_u0_refund": h(claim_u0_refund),
        "claimId_u1_principal0": h(claim_u1_p0),
        "claimId_u1_refund": h(claim_u1_refund),
        "evidenceCommitmentU0": h(evidence_u0),
        "f0": str(u0["f"]),
        "n0": str(u0["n"]),
        "f1": str(u1["f"]),
        "n1": str(u1["n"]),
        "encodedConfigsLength": str(len(enc)),
    }
    selectors = {sig: h(selector(sig)) for _, sig in SIGNATURES}
    extra = {"fundCalldataLengthWith65ByteSigs": len(fund_calldata),
             "unit1MilestoneIndexDecimal": str(u1["milestoneIndex"])}
    return constants, derived_inputs, outputs, selectors, h(enc), checks, extra


# =============================================================================
# 10. Interpretation record, output
# =============================================================================

FILES = [
    "packages/contracts/test/fixtures/vnext-golden/vnext_golden.py",
    "packages/contracts/test/fixtures/vnext-golden/vnext-golden-vectors.json",
]

SPEC_AMBIGUITIES = [
    "Spec 8 'Outputs' contains no literal values: it only points at golden.ts and VNextAbiFreeze.t.sol, which "
    "this clean-room run was forbidden to read. So no output could be checked against the spec itself. Only "
    "the spec 8 self-check anchors plus the task's CREATE and keccak('abc') anchors validate the primitives, "
    "and none of those exercises DYNAMIC abi encoding (prePolicyRoot, payoutConfigHash). Interpretation: every "
    "output is computed from spec 1-7 alone; the dynamic encoder was additionally validated against the public "
    "Solidity ABI-spec examples (anchors prefixed 'extra:').",
    "CREATE is not defined in the spec (spec 8 only says 'its CREATE at nonce 0' / 'at nonce 1'). Used the "
    "standard rule from the task brief: address = last 20 bytes of keccak256(rlp([sender, nonce])), sender "
    "RLP-encoded as a 20-byte string (0x94 prefix, leading zero bytes kept), nonce 0 -> 0x80, nonce 1 -> 0x01; "
    "preimages 0xd694<deployer 0x...D1>80 (factory) and 0xd694<factory>01 (implementation). Nonce 1 for the "
    "factory's first CREATE matches EIP-161 (contract nonces start at 1), as spec 8 states.",
    "Gate-1 evidence anchor: spec 8 gives jobIdHash, milestoneIndex and stepId rather than a settlementUnitId. "
    "Interpretation: settlementUnitId = spec 3 step 4 over (SETTLEMENT_UNIT_DOMAIN, 8453, "
    "0x00000000000000000000000000000000000E5C0F, keccak256('golden-job'), 3, keccak256('golden-step')); "
    "'schema version 1' = uint16 compositionSchemaVersion, 'format 1' = uint8 packageFormat. The anchor "
    "reproduces 0xba4753b5..., which confirms this reading, both domain strings and both formulas.",
    "Offset bases inside abi.encode(UnitConfig[]): spec 0 / spec 3 step 1 state the leading 0x20 word but not "
    "the nested offset bases. Used the Solidity ABI spec: element offsets are measured from the first byte "
    "after the array length word (0x40 and 0x2c0 for the two units); the payouts offset inside each UnitConfig "
    "is measured from the start of that UnitConfig's own encoding (13 head words = 0x1a0); PayoutEntry "
    "(address,uint256) is static, so each payouts array is a length word plus inline 2-word entries with no "
    "per-entry offsets. Total 1280 bytes.",
    "Narrow integer fields (uint8 requiredTier, requestedTier, domainVersion, feeBasis, roundingRule, "
    "claimClass, packageFormat; uint16 feeBps, compositionSchemaVersion) are full 32-byte left-padded words "
    "everywhere (spec 0: standard abi.encode, never packed).",
    "f and n are derived, not copied: f = floor(g * feeBps / 10000), n = g - f (spec 2 / spec 5). They "
    "reproduce the spec 8 stated values exactly.",
    "feeScheduleHash literals are taken from spec 4 and cross-read against the spec 1 constants and the spec 2 "
    "FeeSchedule field list: domainVersion = DOMAIN_VERSION_V1 = 1 (uint8), feeBasis = FEE_BASIS_GROSS = 0 "
    "(uint8), denominator = FEE_DENOMINATOR = 10000 (uint256), roundingRule = ROUNDING_FLOOR = 0 (uint8), "
    "feeSplitConfigHash = bytes32(0). Unit 1 uses feeRecipient 0x0 and f = 0, as given.",
    "claimId legIndex: PRINCIPAL uses the payout array index j (0, 1, 2 for unit 0; 0 for unit 1); FEE = "
    "2^256-1 and REFUND = 2^256-2 as uint256 words; claimClass is a uint8 word. No claimId_u1_fee is produced: "
    "unit 1 has feeBps 0 and it was not requested.",
    "Evidence commitment for unit 0 uses schema version 3 (spec 8 evidence line; equal to unit 0's "
    "compositionSchemaVersion), packageFormat = EVIDENCE_PACKAGE_FORMAT_V1 = 1, and the escrow and unitId0 "
    "computed here.",
    "The settlement-token address is not among the golden inputs, so the spec 5 rule 'recipient != settlement "
    "token' could not be evaluated for the golden recipients (it enters no hash). The other allowed-recipient "
    "rules (nonzero, != escrow clone, != factory) were checked for every payout recipient, the unit 0 fee "
    "recipient and the operator; all hold.",
    "Output format: bytes32 values as 0x + 64 lowercase hex; addresses as 0x + 40 lowercase hex (the spec's "
    "mixed-case inputs are parsed case-insensitively; the payer, operator and CREATE-anchor spellings were "
    "confirmed to be valid EIP-55 checksums); f0, n0, f1, n1 and encodedConfigsLength as decimal strings.",
    "Spec 0 says the only packed preimages are the EIP-712 digest and the CREATE2 address; the EIP-1167 "
    "initCode (spec 3 step 3) is also a byte concatenation. Used exactly as spelled: 20-byte prefix || "
    "implementation || 15-byte suffix = 55 bytes.",
]


def build_consistency_summary(checks, extra):
    failed = [c for c in checks if not c["pass"]]
    if failed:
        return ("SPEC INCONSISTENCY / CHECK FAILURE: " + "; ".join(
            "%s (%s)" % (c["name"], c["detail"]) for c in failed))
    return ("Spec self-consistency (task-requested checks): f0 = floor(1000000003 * 235 / 10000) = 23500000 "
            "with remainder 705; n0 = 976500003; sum of unit 0 payouts = 500000000 + 300000000 + 176500003 = "
            "976500003 = n0; unit 1 reclaimAt - funding time = 31536000 s = exactly 365 days = "
            "MAX_RECLAIM_DELAY (the legal upper edge). All consistent: NO inconsistency found. Also consistent: "
            "unit 0 reclaim delay = 30 days; MIN_RECLAIM_DELAY = 2 + 5 + 2 + 1 days; the spec 2/3 tuple types "
            "match the spec 7 fund/createEscrow/predictEscrow/saltOf signatures; the JobPolicy type string has "
            "14 fields, matching the 15-word spec 3 step 6 layout (a generic EIP-712 hashStruct built from the "
            "type string reproduces jobPolicyHash and domainSeparator); every spec 5 rule that can be evaluated "
            "holds for the golden job; the golden fund() calldata with two 65-byte signatures is %d bytes "
            "<= MAX_CONFIG_BYTES 26372. (%d/%d consistency checks pass.)"
            % (extra["fundCalldataLengthWith65ByteSigs"], len(checks), len(checks)))


def build_notes(anchors, checks):
    n_req = 7
    n_sha3 = len(SHA3_VECTORS)
    n_extra = len(anchors) - n_req - n_sha3
    return (
        "INDEPENDENCE: written from exactly one source document, "
        "docs/VNEXT_SETTLEMENT_ABI.md, plus the task brief (which "
        "supplied the CREATE/RLP rule and the CREATE and keccak('abc') anchors). No .sol file and no TypeScript "
        "file was opened, grepped, listed or searched; no package source and "
        "no private repository was touched. The only other filesystem actions were: "
        "wc -l on the spec; an ls of the (then empty) output directory; a scratchpad Python check that read "
        "ONLY the spec file and this script, confirming that every string and golden number transcribed into "
        "this script appears verbatim in the spec (0 failures); and writing the two output files. No "
        "network, no pip, no node/npm, no foundry/cast; Python 3 standard library only. Keccak-f[1600] (round "
        "constants and rho offsets generated by the FIPS 202 LFSR/rho algorithms, not pasted tables), the "
        "sponge (rate 1088, pad 0x01..0x80), the ABI encoder, RLP/CREATE, CREATE2 and a small EIP-712 "
        "hashStruct were written from scratch. hashlib is used only for the SHA3-256 permutation cross-check; "
        "OpenSSL keccak-256 is not available on this box and nothing else was used as a keccak. "
        "ANCHORS: %d/%d pass: the 7 required ones (5 from the spec 8 table including the gate-1 evidence "
        "commitment, plus the task's CREATE and keccak('abc')), %d SHA3-256 permutation cross-checks against "
        "hashlib.sha3_256 (lengths 0..1000, including the 135/136/137 rate-boundary cases), and %d 'extra:' "
        "public-standard vectors (Keccak-256 of the quick-brown-fox string, the ERC-20 transfer selector, the "
        "EIP-712 'Ether Mail' example, and the Solidity ABI-spec baz/bar/sam/f/g calldata examples, which "
        "exercise dynamic and nested-dynamic offsets). The extra vectors were written from knowledge of those "
        "public documents, not from any PCC source. "
        "INTERPRETATION CHOICES: see specAmbiguities (CREATE rule; gate-1 unit-id derivation; nested ABI offset "
        "bases; narrow ints as full words; f/n derived; fee-schedule literals; claim leg indices; evidence "
        "inputs; unknown settlement token; output formatting; initCode concatenation). "
        "SECOND CODE PATH: every hash output (and the encoded configs, factory and implementation) is "
        "recomputed by explicit 32-byte word concatenation with hand-computed offsets (0x20, 0x40, 0x2c0, "
        "0x1a0), never calling the generic encoder; both paths agree byte for byte. "
        "CONSISTENCY: %d/%d checks pass; the JSON file additionally carries them under 'consistencyChecks' and "
        "'extra' (fund() calldata length, decimal milestoneIndex of unit 1). Every other top-level key in the "
        "file equals the returned object."
        % (sum(a["pass"] for a in anchors), len(anchors), n_sha3, n_extra,
           sum(c["pass"] for c in checks), len(checks)))


def main():
    anchors = run_anchors()
    all_pass = all(a["pass"] for a in anchors)
    print("=== V-next golden vectors: independent clean-room implementation ===")
    print("source: docs/VNEXT_SETTLEMENT_ABI.md (only)")
    print("=== anchors ===")
    for a in anchors:
        print("[%s] %s" % ("PASS" if a["pass"] else "FAIL", a["name"]))
        print("       expected: %s" % a["expected"])
        print("       computed: %s" % a["computed"])
    print("anchors: %d/%d pass" % (sum(a["pass"] for a in anchors), len(anchors)))
    if not all_pass:
        print("BLOCKED: at least one anchor failed; no outputs are trusted and nothing is written.")
        print("=== JSON ===")
        print(json.dumps({"status": "BLOCKED", "anchors": anchors}, indent=2))
        return 1

    constants, derived, outputs, selectors, enc_hex, checks, extra = compute_golden()
    print("=== consistency checks ===")
    for c in checks:
        print("[%s] %s%s" % ("PASS" if c["pass"] else "FAIL", c["name"],
                             (" -- " + c["detail"]) if c["detail"] else ""))
    print("consistency checks: %d/%d pass" % (sum(c["pass"] for c in checks), len(checks)))

    ambiguities = list(SPEC_AMBIGUITIES) + [build_consistency_summary(checks, extra)]
    result = {
        "status": "DONE",
        "anchors": anchors,
        "constants": constants,
        "derivedInputs": derived,
        "outputs": outputs,
        "selectors": selectors,
        "encodedConfigsHex": enc_hex,
        "specAmbiguities": ambiguities,
        "files": FILES,
        "notes": build_notes(anchors, checks),
        "consistencyChecks": checks,
        "extra": extra,
    }
    text = json.dumps(result, indent=2) + "\n"
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vnext-golden-vectors.json")
    with open(out_path, "w", encoding="ascii") as fh:
        fh.write(text)
    print("wrote %s" % out_path)
    print("=== JSON ===")
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
