from copy import deepcopy
import json
from pathlib import Path

import numpy as np
import pytest

from decode import confidence_contract
from export import (
    compare_outputs,
    confidence_metadata,
    initialization_metadata,
    metadata,
    validate_checkpoint_lineage,
    validate_evaluation_lineage,
    validate_run_manifest,
)
from provenance import sha256_file

ROOT = Path(__file__).resolve().parents[1]


def test_output_parity_utility_accepts_tolerance_and_reports_difference() -> None:
    expected = np.array([[[-1.0, -2.0]]], dtype=np.float32)
    actual = expected + np.float32(1e-6)
    result = compare_outputs(expected, actual)
    assert 0 < result["max_absolute_difference"] < 2e-6


def test_metadata_uses_the_calibration_selected_confidence_contract() -> None:
    selected = confidence_contract("margin", 2.0)
    result = confidence_metadata({"confidence": {"selected": selected}})
    assert result["heuristic"] == "margin"
    assert result["formula"] == selected["formula"]
    assert result["confidence_threshold"] == selected["confidence_threshold"]
    assert result["canonicalValidationRequiredForAcceptance"] is True
    assert result["deckValidationRequiredForAcceptance"] is True


def test_export_rejects_checkpoint_or_report_identity_mismatch(tmp_path) -> None:
    checkpoint = tmp_path / "selected.pth"
    checkpoint.write_bytes(b"selected checkpoint")
    digest = sha256_file(checkpoint)
    training = {"selected_checkpoint_sha256": digest}
    calibration = {"checkpoint_sha256": digest}
    final = {"checkpoint_sha256": digest}
    assert validate_checkpoint_lineage(checkpoint, training, calibration, final) == digest

    wrong_checkpoint = tmp_path / "wrong.pth"
    wrong_checkpoint.write_bytes(b"wrong checkpoint")
    with pytest.raises(ValueError, match="does not match"):
        validate_checkpoint_lineage(wrong_checkpoint, training, calibration, final)

    final["checkpoint_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="final_test"):
        validate_checkpoint_lineage(checkpoint, training, calibration, final)


def test_existing_run_initialization_metadata_does_not_claim_training_time_verification() -> None:
    result = initialization_metadata(
        {
            "initial_checkpoint": "artifacts/upstream/crnn_tiny-emnist.pth",
            "initial_checkpoint_verification": {
                "expected_sha256": "a" * 64,
                "actual_sha256": "a" * 64,
                "verified_before_training": False,
                "verified_post_run_at_utc": "2026-07-16T13:08:45+00:00",
            },
        }
    )
    assert result["verifiedBeforeTraining"] is False
    assert "only after the run" in result["verificationStatus"]


def committed_reports() -> tuple[dict, dict, dict, dict, dict, dict, dict[str, Path]]:
    paths = {
        "training": ROOT / "reports/training.json",
        "cpu_benchmark": ROOT / "reports/cpu-benchmark.json",
        "calibration": ROOT / "reports/calibration.json",
        "final": ROOT / "reports/final-test.json",
        "onnx_parity": ROOT / "reports/onnx-parity.json",
    }
    return (
        json.loads(paths["training"].read_text()),
        json.loads(paths["cpu_benchmark"].read_text()),
        json.loads(paths["calibration"].read_text()),
        json.loads(paths["final"].read_text()),
        json.loads(paths["onnx_parity"].read_text()),
        json.loads((ROOT / "reports/run-manifest.json").read_text()),
        paths,
    )


def test_export_validates_distinct_evaluation_roles_and_calibration_lineage() -> None:
    training, _, calibration, final, _, _, paths = committed_reports()
    result = validate_evaluation_lineage(
        training, calibration, final, paths["calibration"]
    )
    assert result["current_report_consistency_validated"] is True
    assert result["historical_pre_final_freeze_independently_proven"] is False
    assert result["training_history_flag_format"] == "historical_best_so_far"
    assert result["selected_model_epoch_record"] is training["epochs"][7]

    wrong_role = deepcopy(calibration)
    wrong_role["evaluation_role"] = "model_selection"
    with pytest.raises(ValueError, match="expected calibration"):
        validate_evaluation_lineage(training, wrong_role, final, paths["calibration"])

    wrong_threshold = deepcopy(final)
    wrong_threshold["confidence"]["raw_threshold"] += 0.1
    with pytest.raises(ValueError, match="raw_threshold"):
        validate_evaluation_lineage(
            training, calibration, wrong_threshold, paths["calibration"]
        )

    wrong_reference = deepcopy(final)
    wrong_reference["calibration_report"]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="calibration SHA-256"):
        validate_evaluation_lineage(
            training, calibration, wrong_reference, paths["calibration"]
        )

    wrong_epoch = deepcopy(training)
    wrong_epoch["model_selection_evaluation"]["selected_epoch"] = 7
    with pytest.raises(ValueError, match="selected_epoch"):
        validate_evaluation_lineage(
            wrong_epoch, calibration, final, paths["calibration"]
        )

    tampered_epoch_seven = deepcopy(training)
    tampered_epoch_seven["epochs"][6]["model_selection"]["overall"]["accuracy"] = 1.0
    with pytest.raises(ValueError, match="best-so-far|argmax"):
        validate_evaluation_lineage(
            tampered_epoch_seven, calibration, final, paths["calibration"]
        )

    wrong_best_accuracy = deepcopy(training)
    wrong_best_accuracy["best_model_selection_accuracy"] = 0.99
    with pytest.raises(ValueError, match="best_model_selection_accuracy"):
        validate_evaluation_lineage(
            wrong_best_accuracy, calibration, final, paths["calibration"]
        )

    wrong_count = deepcopy(training)
    wrong_count["model_selection_evaluation"]["composition_count"] = 5999
    with pytest.raises(ValueError, match="composition_count"):
        validate_evaluation_lineage(
            wrong_count, calibration, final, paths["calibration"]
        )


@pytest.mark.parametrize("tamper", ["reordered", "duplicate", "gap"])
def test_export_rejects_structurally_invalid_epoch_history(tamper) -> None:
    training, _, calibration, final, _, _, paths = committed_reports()
    if tamper == "reordered":
        training["epochs"][6], training["epochs"][7] = (
            training["epochs"][7],
            training["epochs"][6],
        )
    elif tamper == "duplicate":
        training["epochs"][7]["epoch"] = 7
    else:
        training["epochs"].pop(6)

    with pytest.raises(ValueError, match="ordered, unique, and contiguous"):
        validate_evaluation_lineage(training, calibration, final, paths["calibration"])


def test_export_rejects_truncated_epoch_history() -> None:
    training, _, calibration, final, _, _, paths = committed_reports()
    training["epochs"].pop()

    with pytest.raises(ValueError, match="length.*epochs_completed"):
        validate_evaluation_lineage(training, calibration, final, paths["calibration"])


def test_export_rejects_extended_epoch_history() -> None:
    training, _, calibration, final, _, _, paths = committed_reports()
    extra_epoch = deepcopy(training["epochs"][-1])
    extra_epoch["epoch"] += 1
    training["epochs"].append(extra_epoch)

    with pytest.raises(ValueError, match="length.*epochs_completed"):
        validate_evaluation_lineage(training, calibration, final, paths["calibration"])


def test_export_rejects_tampered_historical_best_so_far_flag() -> None:
    training, _, calibration, final, _, _, paths = committed_reports()
    training["epochs"][8]["selected_as_best"] = True

    with pytest.raises(ValueError, match="selected_as_best.*best-so-far"):
        validate_evaluation_lineage(training, calibration, final, paths["calibration"])


def test_metadata_uses_the_validated_selected_epoch_record() -> None:
    training, benchmark, calibration, final, parity, run, paths = committed_reports()
    metadata_path = ROOT.parents[1] / "web-client/public/models/digits-crnn.json"
    lineage = validate_evaluation_lineage(
        training, calibration, final, paths["calibration"]
    )
    result = metadata(
        metadata_path.with_suffix(".onnx"),
        training,
        benchmark,
        calibration,
        final,
        parity,
        run,
        lineage,
    )

    assert result["metrics"]["modelSelection"] is lineage[
        "selected_model_epoch_record"
    ]["model_selection"]
    assert result == json.loads(metadata_path.read_text())


def test_run_manifest_rejects_checkpoint_chronology_source_and_report_mismatches() -> None:
    training, benchmark, calibration, final, parity, run, paths = committed_reports()
    validate_run_manifest(run, training, benchmark, calibration, final, parity, paths)

    wrong_checkpoint = deepcopy(run)
    wrong_checkpoint["selected_checkpoint_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="selected checkpoint"):
        validate_run_manifest(
            wrong_checkpoint, training, benchmark, calibration, final, parity, paths
        )

    wrong_chronology = deepcopy(run)
    wrong_chronology["stages"][4]["completed_at_utc"] = "2026-07-16T12:00:00+00:00"
    with pytest.raises(ValueError, match="stages"):
        validate_run_manifest(
            wrong_chronology, training, benchmark, calibration, final, parity, paths
        )

    wrong_source = deepcopy(run)
    wrong_source["pipeline_source_sha256_at_training_completion"]["model.py"] = "0" * 64
    with pytest.raises(ValueError, match="source hashes"):
        validate_run_manifest(
            wrong_source, training, benchmark, calibration, final, parity, paths
        )

    wrong_report = deepcopy(run)
    wrong_report["report_sha256"]["final"] = "0" * 64
    with pytest.raises(ValueError, match="report SHA-256"):
        validate_run_manifest(
            wrong_report, training, benchmark, calibration, final, parity, paths
        )

    wrong_benchmark = deepcopy(run)
    wrong_benchmark["report_sha256"]["cpu_benchmark"] = "0" * 64
    with pytest.raises(ValueError, match="report SHA-256"):
        validate_run_manifest(
            wrong_benchmark, training, benchmark, calibration, final, parity, paths
        )

    wrong_parity = deepcopy(run)
    wrong_parity["report_sha256"]["onnx_parity"] = "0" * 64
    with pytest.raises(ValueError, match="report SHA-256"):
        validate_run_manifest(
            wrong_parity, training, benchmark, calibration, final, parity, paths
        )
