# LO-EV-1 signing preimage: migration table

Contract: `pcc.evidence.signing-preimage.v1`, defined in `packages/spec/src/evidence/signing-preimage.ts`. The Python reference is `packages/pcc-node/pcc_node/signing_preimage.py`. Goldens, and accept/reject vectors given as JSON text, are in `packages/pcc-node/tests/goldens.json`.

The rule for this change is **no widening**: nothing a call site rejected before may be accepted now. Every behaviour change below is therefore a labelled narrowing (a malformed transport that used to decode by truncation) or a labelled tightening (an input the contract now refuses). Valid inputs sign and verify over the same bytes as before.

## Input domain (the same in TypeScript and Python)

| Input | Accepted | Refused |
|---|---|---|
| digest | `sha256:` + 64 lowercase hex (71 bytes signed) | raw 32 bytes, `0x` hex, bare hex, uppercase, wrong length, trailing whitespace |
| numbers (`issuedAt`, `expiresAt`, `maxSignatures`, `revokedAt`) | non-negative safe integers, taken by value: JSON `1.0` and `1e3` are the integers 1 and 1000 (as `JSON.parse` gives them) | fractions, negatives, above 2^53-1, NaN, infinities, booleans, numeric strings |
| `allowedActions`, `contractIds` | dense arrays of strings, sorted by UTF-16 code unit | sparse arrays and indices that live only on the prototype (TypeScript), non-string entries |
| `derivationPath` | absent, or a non-empty string | `""` (a tightening), `null`, non-strings |
| signature / public key hex | exactly 128 / 64 hex characters, either case; `0x` or `0X` only where noted below | odd or extra nibbles, 130+ characters, whitespace, NUL, non-hex characters |

Strings serialize exactly as `JSON.stringify` does. A lone UTF-16 surrogate is written as a lowercase `\uXXXX` escape, so Python must work from UTF-16 code units. `json.dumps(..., ensure_ascii=False)` is not a conforming implementation.

## Per call site

| # | Call site | Signed bytes | Before → after | Label |
|---|---|---|---|---|
| 1 | kernel-sdk job handler (signs bundles) | UTF-8 of the tagged bundle hash (71 bytes) | same bytes, now built by the contract | unchanged |
| 2 | kernel-sdk `verifyBundleSignature` | as 1 | Exactly 128 hex characters, either case, no prefix. A trailing extra nibble, or one trailing whitespace or NUL, used to decode by truncation and verify; each is now rejected. `0x`/`0X` values were rejected before and still are. Oversized, inner-whitespace and NUL forms were rejected before and still are. | narrowing |
| 3 | kernel digital kernels (accounting, procurement RFQ) | as 1 | same bytes | unchanged |
| 4 | kernel `EvidenceEmitter.signFn` (interface) | as 1 | documented: `signFn` must sign `signingPreimage(data)` | documentation |
| 5 | spec `verifyLogChain` / `VerifyKernelSignature` (interface) | UTF-8 of each tagged entry hash | documented | documentation |
| 6 | verifier `SessionKeyService` issuance | delegation: UTF-8 `JSON.stringify` of the fixed-order body | Same bytes for every valid input. Refused: a TTL that is not a whole number of seconds; an empty derivation path, which SLIP-0010 derivation also refuses. | tightening |
| 7 | verifier `SessionKeyService` verification (delegations and revocations) | as 6; revocation: `{sessionId, revokedAt, reason}` | Same bytes for every valid input. Refused before any signature check, as `session_key_malformed`: an explicitly empty `derivationPath` (the old verifier kept any defined path, so a delegation signed over `"derivationPath":""` used to verify); sparse or prototype-backed scope arrays; numbers outside the domain. | tightening |
| 8 | gateway `verifyDeviceSignedEvidence` (direct device signatures) | as 1 | The bundle hash must be a canonical tagged digest; any string was accepted before. Signature and key hex are exact-length, `0x`/`0X` allowed as before; a trailing nibble or junk used to be truncated and verify, and is now rejected. | narrowing |
| 9 | gateway `verifyDeviceSignedEvidence` (delegated session keys) | as 6 | A defined `derivationPath` is reproduced as signed. The old gateway kept it only when truthy, so it rejected an empty path by byte mismatch; the contract now refuses it outright (same outcome, now explicit). Absent and non-empty paths verify before and after. `0x` is accepted, `0X` is not, as before. | unchanged outcome; the empty-path refusal is labelled |
| 10 | pcc-node `log_capture` (signs log entries) | UTF-8 of the tagged entry hash | unchanged (it already used the contract form) | unchanged |
| 11 | kernel signing-key registration proof | UTF-8 of `pcc-kernel-signing-key:<kernelId>` | unchanged. Every evidence verifier rejects it, because it is not a tagged digest (domain separation). | unchanged |
| 12 | pcc-node `signing_preimage.py` | all three preimages | New reference mirror, byte-identical to TypeScript on every golden and vector. It is not wired to a production verifier. Its number domain follows `JSON.parse`: `json.loads` floats `1.0`/`1e3` are taken as integers. | new |
| 13 | FinalMilestonePackageV2 kernel signature (D2) | the raw 32 bytes of the `0x` package digest | out of scope: a different message space (32 bytes versus 71) | not this contract |

## How parity is proven

- `packages/spec/src/__tests__/signing-preimage.test.ts` runs the TypeScript contract against every golden and every accept/reject vector. It decodes the vectors' JSON text with `JSON.parse`.
- `packages/spec/src/__tests__/pcc-node-signing-preimage-parity.test.ts` runs the Python module under CI's `python3`. It uses the standard library only and decodes the same text with `json.loads`.
- `packages/pcc-node/tests/test_signing_preimage_parity.py` adds signature parity and the crypto negatives: raw-32 and sorted-key signatures never verify. It needs PyNaCl. With `PCC_REQUIRE_PYNACL=1`, a missing PyNaCl is a failure instead of a skip; the signature-parity CI job must set it and install the `crypto` extra.
- `packages/kernel-sdk/src/__tests__/bundle-signature-transport.test.ts` compares the SDK verifier with the pre-contract decoder on 16 transports. It asserts that nothing is accepted now that was rejected before.
