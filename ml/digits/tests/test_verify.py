from copy import deepcopy

import pytest

from verify import ROOT, load_json, validate_manifest_links, verify_committed


def committed_inputs():
    reports = {
        "training": load_json(ROOT / "reports/training.json"),
        "calibration": load_json(ROOT / "reports/calibration.json"),
        "final": load_json(ROOT / "reports/final-test.json"),
    }
    return (
        load_json(ROOT / "manifests/v2.json"),
        load_json(ROOT / "manifests/export-fixtures.json"),
        reports,
    )


def test_committed_ml_artifacts_verify_without_external_data() -> None:
    result = verify_committed()
    assert result["model_sha256"] == (
        "bea69199be71c01a35f4485ad853ef6fd11608c616c452598cb3f330922db9af"
    )


def test_manifest_verification_rejects_out_of_range_fixture() -> None:
    manifest, fixtures, reports = committed_inputs()
    invalid = deepcopy(fixtures)
    invalid["final_manifest_indices"][-1] = manifest["compositions"]["final_test"][
        "count"
    ]
    with pytest.raises(ValueError, match="fixture indices"):
        validate_manifest_links(manifest, invalid, reports)
