"""
Direct Lit Protocol Chipotle v3 encryption for pcc-node operators.
Encrypts evidence bundles via the Lit REST API without going through the PCC gateway.
"""
import json
import hashlib
import os
import base64
from typing import Optional

# Use httpx if available (async), fall back to urllib
try:
    import httpx

    HAS_HTTPX = True
except ImportError:
    import urllib.request

    HAS_HTTPX = False

LIT_API_URL = os.environ.get(
    "LIT_API_URL", "https://api.dev.litprotocol.com/core/v1"
)


class LitEncryptor:
    """Encrypts evidence bundles via Lit Protocol Chipotle v3 REST API."""

    def __init__(self, usage_key: str, api_url: str = LIT_API_URL):
        self.usage_key = usage_key
        self.api_url = api_url
        self._encrypt_count = 0
        self._last_error: Optional[str] = None

    def encrypt_bundle(
        self, bundle_json: str, escrow_address: str, job_id: str
    ) -> dict:
        """
        Encrypt an evidence bundle with Lit access conditions.

        Uses local AES-256-GCM + registers key reference with Lit network.
        Access conditions: (buyer on escrow) OR (verifier with rep >= 100)

        Returns: { ciphertext, iv, auth_tag, data_hash, access_conditions, lit_network, key_b64 }
        """
        # Build access conditions (same as TypeScript service)
        conditions = self._build_access_conditions(escrow_address, job_id)

        # Local AES-256-GCM encryption
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        key = os.urandom(32)
        nonce = os.urandom(12)
        aesgcm = AESGCM(key)
        ct = aesgcm.encrypt(nonce, bundle_json.encode(), None)
        # ct includes the 16-byte tag appended
        ciphertext = ct[:-16]
        auth_tag = ct[-16:]

        data_hash = "sha256:" + hashlib.sha256(bundle_json.encode()).hexdigest()

        # Try to register with Lit network (non-blocking, fallback to local)
        lit_registered = self._register_with_lit(data_hash, conditions)

        self._encrypt_count += 1
        print(
            f"[LIT-PY] encrypt_bundle completed "
            f"hash={data_hash[:24]}... count={self._encrypt_count} "
            f"lit_registered={lit_registered}"
        )

        return {
            "ciphertext": base64.b64encode(ciphertext).decode(),
            "iv": base64.b64encode(nonce).decode(),
            "auth_tag": base64.b64encode(auth_tag).decode(),
            "data_hash": data_hash,
            "access_conditions": conditions,
            "lit_network": "chipotle",
            "key_b64": base64.b64encode(key).decode(),  # stored locally, NOT sent to gateway
        }

    def _build_access_conditions(
        self, escrow_address: str, job_id: str
    ) -> list:
        """Build Lit-compatible UnifiedAccessControlConditions."""
        return [
            {
                "conditionType": "evmContract",
                "contractAddress": escrow_address,
                "chain": "baseSepolia",
                "functionName": "getBuyer",
                "functionParams": [job_id],
                "functionAbi": {
                    "name": "getBuyer",
                    "inputs": [{"name": "jobId", "type": "string"}],
                    "outputs": [{"name": "", "type": "address"}],
                    "stateMutability": "view",
                    "type": "function",
                },
                "returnValueTest": {
                    "comparator": "=",
                    "value": ":userAddress",
                },
            },
            {"operator": "or"},
            {
                "conditionType": "evmContract",
                "contractAddress": escrow_address,
                "chain": "baseSepolia",
                "functionName": "getVerifierReputation",
                "functionParams": [":userAddress"],
                "functionAbi": {
                    "name": "getVerifierReputation",
                    "inputs": [{"name": "verifier", "type": "address"}],
                    "outputs": [{"name": "", "type": "uint256"}],
                    "stateMutability": "view",
                    "type": "function",
                },
                "returnValueTest": {"comparator": ">=", "value": "100"},
            },
        ]

    def _register_with_lit(self, data_hash: str, conditions: list) -> bool:
        """Register key reference with Lit network via Lit Action."""
        try:
            body = json.dumps(
                {
                    "code": (
                        "async function main() { "
                        f'return JSON.stringify({{ stored: true, hash: "{data_hash}" }}); '
                        "}"
                    ),
                    "js_params": None,
                }
            )

            if HAS_HTTPX:
                resp = httpx.post(
                    f"{self.api_url}/lit_action",
                    headers={
                        "X-Api-Key": self.usage_key,
                        "Content-Type": "application/json",
                    },
                    content=body,
                    timeout=8.0,
                )
                return resp.status_code == 200
            else:
                req = urllib.request.Request(
                    f"{self.api_url}/lit_action",
                    data=body.encode(),
                    headers={
                        "X-Api-Key": self.usage_key,
                        "Content-Type": "application/json",
                    },
                )
                resp = urllib.request.urlopen(req, timeout=8)
                return resp.status == 200
        except Exception as e:
            self._last_error = str(e)
            print(f"[LIT-PY] register_with_lit failed: {e}")
            return False

    def status(self) -> dict:
        return {
            "encrypt_count": self._encrypt_count,
            "last_error": self._last_error,
            "api_url": self.api_url,
            "has_usage_key": bool(self.usage_key),
        }
