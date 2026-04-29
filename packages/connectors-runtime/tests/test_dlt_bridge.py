"""dlt bridge import + signature tests.

Real dlt round-trip is integration territory (needs a postgres / file
sink); these unit tests cover the lazy-import seam and error paths.
"""

from __future__ import annotations

import pytest

from connectors_runtime import dlt_bridge


def test_module_imports_without_dlt_installed() -> None:
    """The bridge module should import cleanly even if dlt is missing.

    Lazy imports inside each function are the pattern; this test guards
    against accidental top-level `import dlt` regressions.
    """
    # If we got here, the import succeeded — that's the assertion.
    assert hasattr(dlt_bridge, "make_source")
    assert hasattr(dlt_bridge, "make_destination")
    assert hasattr(dlt_bridge, "run_pipeline_sync")
    assert hasattr(dlt_bridge, "get_dlt_version")


def test_make_source_rejects_unknown_kind() -> None:
    with pytest.raises(ValueError, match="unsupported source kind"):
        dlt_bridge.make_source("not_a_real_kind", {})


def test_make_destination_rejects_unknown_kind() -> None:
    with pytest.raises(ValueError, match="unsupported destination kind"):
        dlt_bridge.make_destination("not_a_real_kind", {})


def test_make_source_raises_not_implemented_for_vendor_kinds() -> None:
    """salesforce/sharepoint/sap are recognised but not wired in v0.1.

    Make sure the bridge surfaces this as NotImplementedError, NOT as a
    silent ValueError — the server uses this distinction to return 501
    (vendor-not-wired) vs 400 (truly invalid kind).
    """
    for kind in ("salesforce", "sharepoint", "sap"):
        with pytest.raises(NotImplementedError, match="v0.1"):
            dlt_bridge.make_source(kind, {})


def test_make_destination_insforge_not_implemented() -> None:
    with pytest.raises(NotImplementedError, match="v0.1"):
        dlt_bridge.make_destination("insforge", {})


def test_supported_kinds_match_expected_set() -> None:
    """Pin the source/destination kind sets so adding/removing a kind
    requires a deliberate test update."""
    assert dlt_bridge.SUPPORTED_SOURCE_KINDS == {
        "postgres",
        "sql_database",
        "salesforce",
        "sharepoint",
        "sap",
        "csv",
    }
    assert dlt_bridge.SUPPORTED_DESTINATION_KINDS == {
        "postgres",
        "filesystem",
        "insforge",
    }


def test_get_dlt_version_returns_string() -> None:
    """Either the installed dlt version or 'not-installed' — never None.

    The /health endpoint surfaces this string verbatim, so it must never
    be None or operations alerts will fire.
    """
    v = dlt_bridge.get_dlt_version()
    assert isinstance(v, str)
    assert len(v) > 0
