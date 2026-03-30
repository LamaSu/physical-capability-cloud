"""Simple Opentrons protocol for testing."""

metadata = {
    "protocolName": "Simple Dilution",
    "apiLevel": "2.13",
    "author": "Test User",
}


def run(protocol):
    # Load labware
    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", 1)
    tiprack = protocol.load_labware("opentrons_96_tiprack_300ul", 2)
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", 3)

    # Load modules
    temp_mod = protocol.load_module("temperature module gen2", 4)

    # Load pipettes
    left = protocol.load_instrument("p300_single_gen2", "left", tip_racks=[tiprack])
    right = protocol.load_instrument("p20_single_gen2", "right", tip_racks=[tiprack])

    # Simple transfer
    left.pick_up_tip()
    left.aspirate(200, reservoir.wells()[0])
    left.dispense(200, plate.wells()[0])
    left.drop_tip()
