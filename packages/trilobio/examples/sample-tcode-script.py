"""Sample tcode-api script — basic transfer demonstration.

This is the kind of payload a Trilobio operator might accept under
`allowArbitraryScripts: true`. It demonstrates the canonical tcode-api
shape: import, register entities, then issue commands.

For curated-mode operators, the equivalent would be a protocol ID
referencing this script in the operator's library, not the script itself.

Run on a trilobot fleet controller (or against a mock with PCC's adapter):

    python sample-tcode-script.py

Reference: https://tcode.trilo.bio/api/commands.html
"""

from tcode_api import (
    ADD_ROBOT,
    ADD_LABWARE,
    ADD_PIPETTE_TIP_GROUP,
    PICK_UP_TIP,
    ASPIRATE,
    DISPENSE,
    DROP_TIP,
)


def transfer_buffer_to_plate(volume_ul: float = 50.0) -> None:
    """Transfer `volume_ul` of buffer from a reservoir into well A1 of a 96-well plate."""

    # 1. Register the physical entities the script needs to address.
    ADD_ROBOT(
        id="robot-1",
        descriptor={"kind": "trilobot-cartesian-arm-v2"},
    )

    ADD_LABWARE(
        id="reservoir",
        descriptor={"kind": "agilent-12-channel-reservoir-25ml"},
    )

    ADD_LABWARE(
        id="plate",
        descriptor={"kind": "corning-96-well-flat-bottom"},
    )

    ADD_PIPETTE_TIP_GROUP(
        id="tips-200ul",
        descriptor={"kind": "trilobio-200ul-rack"},
    )

    # 2. Execute the transfer.
    PICK_UP_TIP(robot_id="robot-1", tip_group_id="tips-200ul")

    ASPIRATE(
        robot_id="robot-1",
        volume={"value": volume_ul, "unit": "ul"},
        speed={"value": 100, "unit": "ul_per_sec"},
    )

    DISPENSE(
        robot_id="robot-1",
        volume={"value": volume_ul, "unit": "ul"},
        speed={"value": 100, "unit": "ul_per_sec"},
    )

    DROP_TIP(robot_id="robot-1")


if __name__ == "__main__":
    transfer_buffer_to_plate(volume_ul=50.0)
