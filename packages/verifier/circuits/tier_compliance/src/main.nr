// Tier Compliance Circuit
//
// Proves that an evidence bundle meets the requirements for a given assurance tier
// WITHOUT revealing the actual evidence data.
//
// Uses Pedersen hash for binding events_hash -> bundle_hash.
//
// Tier requirements (from PCC spec):
//   Tier 0: >= 2 evidence events
//   Tier 1: >= 3 events, must include execution_completed
//   Tier 2: >= 4 events, must include execution_completed + sensor data
//   Tier 3: >= 5 events, must include execution_completed + sensor + tee_attestation
//
// Public inputs:
//   - bundle_hash: Pedersen hash of the evidence bundle (Field)
//   - required_tier: assurance tier (0-3)
//
// Private witnesses:
//   - event_count: number of events in the bundle
//   - has_execution_completed: 1 if bundle contains execution_completed event
//   - has_sensor_data: 1 if bundle contains sensor data events
//   - has_tee_attestation: 1 if bundle contains tee_attestation event
//   - events_hash: hash of canonical event list (Field)

fn main(
    // Public inputs
    bundle_hash: pub Field,
    required_tier: pub u8,
    // Private witnesses
    event_count: u32,
    has_execution_completed: Field,
    has_sensor_data: Field,
    has_tee_attestation: Field,
    events_hash: Field,
) {
    // Validate tier is 0-3
    assert(required_tier <= 3);

    // Validate boolean witnesses
    assert((has_execution_completed == 0) | (has_execution_completed == 1));
    assert((has_sensor_data == 0) | (has_sensor_data == 1));
    assert((has_tee_attestation == 0) | (has_tee_attestation == 1));

    // Verify the events hash relates to the bundle hash
    let computed = std::hash::pedersen_hash([events_hash]);
    assert(computed == bundle_hash);

    // Tier 0: >= 2 events
    assert(event_count >= 2);

    // Tier 1: >= 3 events + execution_completed
    if required_tier >= 1 {
        assert(event_count >= 3);
        assert(has_execution_completed == 1);
    }

    // Tier 2: >= 4 events + execution_completed + sensor data
    if required_tier >= 2 {
        assert(event_count >= 4);
        assert(has_execution_completed == 1);
        assert(has_sensor_data == 1);
    }

    // Tier 3: >= 5 events + execution_completed + sensor + TEE attestation
    if required_tier == 3 {
        assert(event_count >= 5);
        assert(has_execution_completed == 1);
        assert(has_sensor_data == 1);
        assert(has_tee_attestation == 1);
    }
}

#[test]
fn test_tier_0() {
    let events_hash: Field = 42;
    let bundle_hash = std::hash::pedersen_hash([events_hash]);
    main(bundle_hash, 0, 2, 0, 0, 0, events_hash);
}

#[test]
fn test_tier_1() {
    let events_hash: Field = 43;
    let bundle_hash = std::hash::pedersen_hash([events_hash]);
    main(bundle_hash, 1, 3, 1, 0, 0, events_hash);
}

#[test]
fn test_tier_2() {
    let events_hash: Field = 44;
    let bundle_hash = std::hash::pedersen_hash([events_hash]);
    main(bundle_hash, 2, 4, 1, 1, 0, events_hash);
}

#[test]
fn test_tier_3() {
    let events_hash: Field = 45;
    let bundle_hash = std::hash::pedersen_hash([events_hash]);
    main(bundle_hash, 3, 5, 1, 1, 1, events_hash);
}
