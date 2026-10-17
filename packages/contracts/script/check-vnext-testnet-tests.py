#!/usr/bin/env python3
"""Run all four V-next testnet suites and require every declared test to succeed."""

import json
from pathlib import Path
import re
import subprocess
import sys


SUITES = {
    "test/VNextSchedule.t.sol:VNextScheduleTest": Path("test/VNextSchedule.t.sol"),
    "test/VNextDeployGates.t.sol:VNextDeployGatesTest": Path("test/VNextDeployGates.t.sol"),
    "test/VNextDeployRecord.t.sol:VNextDeployRecordTest": Path("test/VNextDeployRecord.t.sol"),
    "test/VNextDeployVerify.t.sol:VNextDeployVerifyTest": Path("test/VNextDeployVerify.t.sol"),
}
# Deliberate coverage floor: update these only when reviewing an intentional test addition/removal.
EXPECTED_TEST_COUNTS = {
    "test/VNextSchedule.t.sol:VNextScheduleTest": 18,
    "test/VNextDeployGates.t.sol:VNextDeployGatesTest": 46,
    "test/VNextDeployRecord.t.sol:VNextDeployRecordTest": 35,
    "test/VNextDeployVerify.t.sol:VNextDeployVerifyTest": 7,
}


def main() -> None:
    command = [
        "forge", "test", "--match-path", "test/VNext{Schedule,DeployGates,DeployRecord,DeployVerify}.t.sol", "--json",
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    sys.stderr.write(result.stderr)
    if result.returncode:
        sys.stdout.write(result.stdout)
        raise SystemExit(result.returncode)
    try:
        suites = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Expected forge JSON results: {error}") from error
    if set(suites) != set(SUITES):
        raise SystemExit(f"Expected all four V-next suites, got {sorted(suites)}")
    passed = 0
    for suite, source in SUITES.items():
        expected = set(re.findall(r"\bfunction\s+(test_\w+)\s*\(", source.read_text()))
        tests = suites[suite]["test_results"]
        actual = {name.split("(", 1)[0] for name in tests}
        if len(expected) != EXPECTED_TEST_COUNTS[suite]:
            raise SystemExit(f"{suite}: expected {EXPECTED_TEST_COUNTS[suite]} declared tests, got {len(expected)}")
        if not expected or actual != expected:
            raise SystemExit(f"{suite}: missing {sorted(expected - actual)}, unexpected {sorted(actual - expected)}")
        unsuccessful = {name: test["status"] for name, test in tests.items() if test["status"] != "Success"}
        if unsuccessful:
            raise SystemExit(f"{suite}: every test must PASS (no skips): {unsuccessful}")
        print(f"{suite}: {len(tests)} passed, 0 failed, 0 skipped")
        passed += len(tests)
    print(f"Testnet V-next CI check: {passed} passed, 0 failed, 0 skipped; all declared tests present")


if __name__ == "__main__":
    main()
