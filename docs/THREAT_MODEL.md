# Threat Model: Physical Capability Cloud

## Threat Actors

### 1. Dishonest Operator
**Goal**: Get paid without performing work, or perform substandard work.

| Attack | Mitigation |
|--------|-----------|
| Submit fake evidence | Multi-signal verification (power + camera + telemetry must correlate) |
| Replay old telemetry | Nonce in job commitment; timestamps checked against block time |
| Run wrong G-code | G-code hash committed before execution; hash verified in evidence |
| Swap inferior material | Camera CV at Tier 2+; physical inspection at Tier 3 |
| Claim job complete when partial | Power profile duration must match expected; CV checks geometry |

### 2. Dishonest User
**Goal**: Receive work but avoid payment, or extract IP.

| Attack | Mitigation |
|--------|-----------|
| Dispute valid work | Bond required to dispute; frivolous disputes penalized |
| Extract G-code from platform | G-code stored encrypted; kernel receives decryption key only after escrow funded |
| Abandon funded escrow | Timeout releases funds back to user after expiry; operator compensated for reserved time |

### 3. Dishonest Verifier
**Goal**: Attest invalid evidence for kickbacks.

| Attack | Mitigation |
|--------|-----------|
| Rubber-stamp attestations | Stake required; random audits by other verifiers; slashing for provably wrong attestations |
| Collude with operator | Verifier selection is randomized (weighted by stake + reputation); collusion requires controlling majority of verifier pool |

### 4. Courier Manipulation
**Goal**: Steal or damage goods in transit.

| Attack | Mitigation |
|--------|-----------|
| Claim delivery never happened | Photo proof + GPS + recipient signature (via courier API) |
| Swap item during transit | Sealed packaging with tamper-evident seals; weight verification at pickup and delivery |
| Damage item | Insurance via courier platform; custody handoff photos |

## Trust Assumptions

1. **TEE hardware is honest** (when used): Intel SGX / ARM TrustZone root of trust is sound.
2. **Blockchain settlement is final**: L2 settlement inherits L1 security after finality window.
3. **Courier APIs report honestly**: We rely on Uber Direct / Roadie GPS and photo proof. This is a weaker assumption mitigated by recipient confirmation.
4. **Economic rationality**: Actors won't burn more in bonds than they gain from fraud.

## Assurance Tier Security Properties

| Property | Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|----------|--------|--------|--------|--------|
| G-code integrity | Yes | Yes | Yes | Yes |
| Execution verification | No | Power profile | + Camera CV | + Independent inspector |
| Tamper resistance | Low | Medium | High | Very High |
| Dispute window | 1h | 4h | 24h | 72h |
| Bond (% of job) | 0% | 5% | 15% | 25% |
| Fraud cost to attacker | ~$0 | > 5% job value | > 15% job value | > 25% job value + reputation |
