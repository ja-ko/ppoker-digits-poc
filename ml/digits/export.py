"""Static batch-one ONNX export, parity verification, and metadata generation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
import torch

from dataset import dataset_for_manifest, load_manifest
from decode import confidence_contract, greedy_decode
from model import load_checkpoint
from provenance import (
    pipeline_source_sha256,
    sha256_file,
    utc_now,
    validate_training_history,
)

OPSET = 17


def compare_outputs(torch_output: np.ndarray, onnx_output: np.ndarray) -> dict[str, float]:
    np.testing.assert_allclose(torch_output, onnx_output, rtol=1e-3, atol=1e-5)
    difference = np.abs(torch_output - onnx_output)
    return {
        "max_absolute_difference": float(difference.max()),
        "mean_absolute_difference": float(difference.mean()),
    }


def validate_checkpoint_lineage(
    checkpoint: Path,
    training: dict[str, Any],
    calibration: dict[str, Any],
    final: dict[str, Any],
) -> str:
    actual = sha256_file(checkpoint)
    expected = {
        "training/model_selection": training.get("selected_checkpoint_sha256"),
        "calibration": calibration.get("checkpoint_sha256"),
        "final_test": final.get("checkpoint_sha256"),
    }
    missing = [name for name, digest in expected.items() if not digest]
    if missing:
        raise ValueError(f"checkpoint SHA-256 missing from reports: {', '.join(missing)}")
    mismatched_reports = [
        name for name, digest in expected.items() if digest != actual
    ]
    if mismatched_reports:
        raise ValueError(
            f"supplied checkpoint SHA-256 {actual} does not match "
            f"{', '.join(mismatched_reports)}"
        )
    return actual


def validate_evaluation_lineage(
    training: dict[str, Any],
    calibration: dict[str, Any],
    final: dict[str, Any],
    calibration_path: Path,
) -> dict[str, Any]:
    model_selection = training.get("model_selection_evaluation", {})
    expected_roles = (
        (model_selection, "model_selection", "model_selection"),
        (calibration, "calibration", "calibration"),
        (final, "final", "final_test"),
    )
    for report, role, manifest in expected_roles:
        if report.get("evaluation_role") != role or report.get("manifest") != manifest:
            raise ValueError(f"expected {role} report for {manifest} manifest")

    manifest = load_manifest()
    best_epoch = training.get("best_epoch")
    expected_count = manifest["compositions"]["model_selection"]["count"]
    history = validate_training_history(
        training.get("epochs", []), training.get("epochs_completed")
    )
    selected_epoch_number = history["selected_epoch"]
    selected_accuracy = history["selected_accuracy"]
    if best_epoch != selected_epoch_number:
        raise ValueError("best_epoch is not the argmax model-selection epoch")
    if training.get("best_model_selection_accuracy") != selected_accuracy:
        raise ValueError("best_model_selection_accuracy does not match selected epoch")
    if model_selection.get("selected_epoch") != best_epoch:
        raise ValueError("model-selection selected_epoch does not match best_epoch")
    if model_selection.get("composition_count") != expected_count:
        raise ValueError("model-selection composition_count does not match manifest")
    selected_epoch = history["selected_record"]
    if selected_epoch.get("model_selection", {}).get("overall", {}).get("total") != expected_count:
        raise ValueError("selected epoch model-selection count does not match manifest")

    selected = calibration.get("confidence", {}).get("selected")
    if not selected or calibration["confidence"].get("data_role") != "threshold selection only":
        raise ValueError("calibration report does not select confidence")
    final_confidence = final.get("confidence", {})
    if final_confidence.get("data_role") != "untouched final evaluation":
        raise ValueError("final report has the wrong confidence role")
    for key in ("heuristic", "formula", "raw_threshold", "confidence_threshold"):
        if final_confidence.get(key) != selected.get(key):
            raise ValueError(f"final report does not preserve calibration {key}")

    calibration_sha256 = sha256_file(calibration_path)
    reference = final.get("calibration_report", {})
    if reference.get("sha256") != calibration_sha256:
        raise ValueError("final report calibration SHA-256 reference is invalid")
    for key in ("heuristic", "formula", "raw_threshold", "confidence_threshold"):
        if reference.get(key) != selected.get(key):
            raise ValueError(f"final calibration reference does not preserve {key}")
    return {
        "current_report_consistency_validated": True,
        "historical_pre_final_freeze_independently_proven": False,
        "roles": [role for _, role, _ in expected_roles],
        "calibration_report_sha256": calibration_sha256,
        "selected_model_epoch_record": selected_epoch,
        "training_history_flag_format": history["flag_format"],
    }


def validate_run_manifest(
    run_manifest: dict[str, Any],
    training: dict[str, Any],
    benchmark: dict[str, Any],
    calibration: dict[str, Any],
    final: dict[str, Any],
    parity: dict[str, Any],
    report_paths: dict[str, Path],
) -> None:
    checkpoint_sha256 = training["selected_checkpoint_sha256"]
    if run_manifest.get("selected_checkpoint_sha256") != checkpoint_sha256:
        raise ValueError("run manifest selected checkpoint does not match training")
    for name, report in (("calibration", calibration), ("final", final)):
        if report.get("checkpoint_sha256") != checkpoint_sha256:
            raise ValueError(f"run manifest checkpoint does not match {name}")

    expected_stages = (
        (1, "cpu_benchmark", benchmark["completed_at_utc"]),
        (2, "training_started", training["started_at_utc"]),
        (3, "training_and_model_selection", training["completed_at_utc"]),
        (4, "confidence_calibration", calibration["evaluated_at_utc"]),
        (5, "untouched_final_evaluation", final["evaluated_at_utc"]),
        (6, "onnx_export_and_parity", parity["exported_at_utc"]),
    )
    stages = run_manifest.get("stages", [])
    actual_stages = [
        (stage.get("order"), stage.get("name"), stage.get("completed_at_utc"))
        for stage in stages
    ]
    if actual_stages != list(expected_stages):
        raise ValueError("run manifest stages do not match report chronology")
    timestamps = [timestamp for _, _, timestamp in actual_stages]
    if timestamps != sorted(timestamps) or not run_manifest.get(
        "stage_timestamp_order_validated",
        run_manifest.get("chronology_verified", False),
    ):
        raise ValueError("run manifest stage timestamps are not ordered")

    training_completion_source = training.get(
        "pipeline_source_sha256_after_training",
        training.get("pipeline_source_sha256_at_training_completion"),
    )
    run_completion_source = run_manifest.get(
        "pipeline_source_sha256_after_training",
        run_manifest.get("pipeline_source_sha256_at_training_completion"),
    )
    if not training_completion_source or run_completion_source != training_completion_source:
        raise ValueError("run manifest source hashes do not match training report")
    training_during = training.get(
        "pipeline_source_unchanged_during_training",
        training.get("pipeline_source_audit", {}).get("unchanged_during_training"),
    )
    if run_manifest.get("pipeline_source_unchanged_during_training") != training_during:
        raise ValueError("run manifest training-source audit does not match training report")

    expected_report_hashes = {
        name: sha256_file(path) for name, path in report_paths.items()
    }
    if run_manifest.get("report_sha256") != expected_report_hashes:
        raise ValueError("run manifest report SHA-256 references are invalid")


def initialization_metadata(training: dict[str, Any]) -> dict[str, Any]:
    verification = training["initial_checkpoint_verification"]
    verified_before = verification["verified_before_training"]
    return {
        "reportedPath": training["initial_checkpoint"],
        "expectedSha256": verification["expected_sha256"],
        "observedSha256": verification["actual_sha256"],
        "verifiedBeforeTraining": verified_before,
        "verificationStatus": "verified before training"
        if verified_before
        else "not captured at training time; retained file verified only after the run",
        "postRunVerificationAtUtc": verification.get("verified_post_run_at_utc"),
    }


def export_static(checkpoint: Path, output: Path) -> None:
    model = load_checkpoint(checkpoint).eval()
    output.parent.mkdir(parents=True, exist_ok=True)
    example = torch.zeros((1, 1, 32, 128), dtype=torch.float32)
    torch.onnx.export(
        model,
        example,
        output,
        export_params=True,
        opset_version=OPSET,
        do_constant_folding=True,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes=None,
        dynamo=False,
    )
    graph = onnx.load(output)
    onnx.checker.check_model(graph)


def verify_parity(
    checkpoint: Path,
    onnx_path: Path,
    data_root: Path,
    fixture_indices: list[int],
) -> dict[str, Any]:
    model = load_checkpoint(checkpoint).eval()
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    input_shape = session.get_inputs()[0].shape
    output_shape = session.get_outputs()[0].shape
    if input_shape != [1, 1, 32, 128] or output_shape != [1, 63, 11]:
        raise RuntimeError(f"unexpected ONNX contract: {input_shape} -> {output_shape}")
    dataset = dataset_for_manifest(data_root, "final_test")
    fixtures = []
    maximum = 0.0
    for index in fixture_indices:
        image, label = dataset[index]
        numpy_input = image.unsqueeze(0).numpy()
        with torch.inference_mode():
            torch_output = model(image.unsqueeze(0)).numpy()
        onnx_output = session.run(["output"], {"input": numpy_input})[0]
        difference = compare_outputs(torch_output, onnx_output)
        maximum = max(maximum, difference["max_absolute_difference"])
        torch_text = greedy_decode(torch_output)[0]
        onnx_text = greedy_decode(onnx_output)[0]
        if torch_text != onnx_text:
            raise RuntimeError(f"decoded parity failed at fixture {index}")
        fixtures.append(
            {
                "final_manifest_index": index,
                "label": label,
                "pytorch_decoded": torch_text,
                "onnx_decoded": onnx_text,
                **difference,
            }
        )
    return {
        "opset": OPSET,
        "input_shape": input_shape,
        "output_shape": output_shape,
        "rtol": 1e-3,
        "atol": 1e-5,
        "maximum_absolute_difference": maximum,
        "decoded_parity": True,
        "fixtures": fixtures,
    }


def metadata(
    model_path: Path,
    training: dict[str, Any],
    benchmark: dict[str, Any],
    calibration: dict[str, Any],
    final: dict[str, Any],
    parity: dict[str, Any],
    run_manifest: dict[str, Any],
    evaluation_lineage: dict[str, Any],
) -> dict[str, Any]:
    if not evaluation_lineage.get("current_report_consistency_validated"):
        raise ValueError("current evaluation report consistency is required for metadata")
    manifest = load_manifest()
    metric_keys = ("overall", "by_length", "repeated_digits")
    return {
        "schemaVersion": 2,
        "model": {
            "name": "CRNN Tiny EMNIST digit-sequence candidate",
            "path": model_path.name,
            "sha256": sha256_file(model_path),
            "bytes": model_path.stat().st_size,
            "onnxOpset": OPSET,
            "modificationNotice": "Modified 2026-07-16 from the Apache-2.0 CRNN Tiny architecture: input width changed from 160 to 128, labels changed to canonical one-to-three-digit sequences, the model was fine-tuned on EMNIST compositions, and it was exported as static batch-one ONNX; see upstreamReference for initialization-audit scope.",
        },
        "upstreamReference": {
            "repository": "https://github.com/zjykzj/crnn-ctc",
            "release": "v1.3.0",
            "revision": "aeceea3a2ab7e973b40d871ff628b327df31a045",
            "checkpoint": "crnn_tiny-emnist.pth",
            "checkpointUrl": "https://github.com/zjykzj/crnn-ctc/releases/download/v1.3.0/crnn_tiny-emnist.pth",
            "checkpointSha256": "6d2a653513fd71f9d5de1fc238311dc017d285f0bbc55e09da7ed9eea80479c9",
            "license": "Apache-2.0",
            "copyright": "Copyright 2023 zjykzj",
            "role": "Architecture and reported initialization reference; see initializationAudit for verification scope.",
            "initializationAudit": initialization_metadata(training),
        },
        "input": {
            "name": "input",
            "dtype": "float32",
            "shape": [1, 1, 32, 128],
            "range": [0.0, 1.0],
            "polarity": "white ink on black",
            "preprocessingVersion": "digits-model-input-v1",
            "contract": "row-major NCHW; preserve aspect ratio inside approximately 120x26 and center on a black 128x32 raster",
        },
        "output": {
            "name": "output",
            "dtype": "float32",
            "shape": [1, 63, 11],
            "values": "natural-log probabilities",
            "classes": "0123456789",
            "blankIndex": 10,
            "rawPredictionContract": "CTC decoding is unconstrained and may produce empty, leading-zero, overlength, or greater-than-255 text.",
            "acceptanceContract": "Preserve raw text for diagnostics, then require canonical unsigned decimal 0..255 and downstream deck membership before automatic acceptance or commit.",
            "rejectionContract": "Provisional rejection or dismissal may still act on raw output under the separately documented confidence and timing policy.",
        },
        "training": {
            key: training[key]
            for key in (
                "seed",
                "epochs_completed",
                "samples_per_epoch",
                "total_training_compositions",
                "batch_size",
                "optimizer",
                "learning_rate",
                "weight_decay",
                "scheduler",
                "best_epoch",
                "selected_checkpoint_sha256",
            )
        },
        "data": {
            "dataset": "NIST-hosted EMNIST Digits",
            "archiveSha256": manifest["source"]["archive_sha256"],
            "compositionVersion": manifest["composition_algorithm"],
            "manifestVersion": manifest["version"],
            "separation": "official train glyphs for training; disjoint official test-glyph pools for selection and calibration; the untouched v1 reserve pool is v2 final; the observed v1 final pool is retired",
            "finalPool": "Previously untouched v1 reserve glyphs, first composed for the v2 remediation final evaluation.",
            "remainingUntouchedReserveGlyphs": 0,
        },
        "metrics": {
            "modelSelection": evaluation_lineage["selected_model_epoch_record"][
                "model_selection"
            ],
            "calibration": {
                "manifest": calibration["manifest"],
                "compositionCount": calibration["composition_count"],
                **{key: calibration[key] for key in metric_keys},
                "beamWidth10": calibration["beam_width_10"],
                "confidenceExperiments": calibration["confidence"]["experiments"],
            },
            "reportedFinal": {
                "manifest": final["manifest"],
                "historicalPreFinalFreezeIndependentlyProven": False,
                "compositionCount": final["composition_count"],
                **{key: final[key] for key in metric_keys},
                "beamWidth10": final["beam_width_10"],
                "confidence": final["confidence"],
            },
        },
        "confidence": {
            "decoder": "CTC prefix beam width 10",
            **confidence_metadata(calibration),
            "comparedHeuristics": [
                "top sequence log score / 63",
                "top-minus-second sequence log-score margin",
                "top score / 63 + 0.05 * min(margin, 20)",
            ],
            "selectionRule": "minimize correct false rejections subject to <=1% acceptance among incorrect synthetic calibration predictions",
            "warning": "Provisional synthetic-only heuristic, not a calibrated correctness probability and not production-safe.",
        },
        "cpuBenchmark": {
            "device": benchmark["device"],
            "batchSize": benchmark["batch_size"],
            "torchThreads": benchmark["torch_threads"],
            "dataLoaderWorkers": benchmark["data_loader_workers"],
            "measuredSamples": benchmark["measured_samples"],
            "seconds": benchmark["seconds"],
            "samplesPerSecond": benchmark["samples_per_second"],
        },
        "parity": {
            "fixtureCount": len(parity["fixtures"]),
            "rtol": parity["rtol"],
            "atol": parity["atol"],
            "maximumAbsoluteDifference": parity["maximum_absolute_difference"],
            "decodedParity": parity["decoded_parity"],
        },
        "provenance": {
            "runManifest": "ml/digits/reports/run-manifest.json",
            "stageTimestampOrderValidated": run_manifest[
                "stage_timestamp_order_validated"
            ],
            "pipelineSourceUnchangedDuringTraining": run_manifest[
                "pipeline_source_unchanged_during_training"
            ],
            "pipelineSourceUnchangedFromTrainingCompletionThroughOriginalExport": run_manifest[
                "pipeline_source_unchanged_from_training_completion_through_original_export"
            ],
            "sourceHashAuditScope": run_manifest["pipeline_source_audit_scope"],
            "currentEvaluationReportConsistencyValidated": True,
            "historicalPreFinalFreezeIndependentlyProven": False,
            "calibrationReportSha256": evaluation_lineage[
                "calibration_report_sha256"
            ],
        },
        "reports": "ml/digits/reports/",
        "limitations": [
            "EMNIST scanned glyph compositions do not establish accuracy on finger handwriting.",
            "Synthetic confidence does not cover scribbles, partial digits, letters, signs, or other out-of-distribution input.",
            "No user handwriting was collected or retained.",
            "Browser rasterization, latency, physical-device behavior, and production-safe automatic actions remain unverified.",
            "The neural output is not constrained to canonical 0..255 text; downstream canonical and deck validation are mandatory before automatic acceptance or commit.",
            "The prior reserve pool was consumed for this untouched final evaluation; no official-test reserve remains for another model iteration.",
        ],
    }


def confidence_metadata(calibration: dict[str, Any]) -> dict[str, Any]:
    selected = calibration["confidence"]["selected"]
    contract = confidence_contract(
        selected["heuristic"], float(selected["raw_threshold"])
    )
    if selected["formula"] != contract["formula"]:
        raise ValueError("calibration confidence formula does not match runtime contract")
    if selected["confidence_threshold"] != contract["confidence_threshold"]:
        raise ValueError("calibration confidence threshold does not match runtime contract")
    return {
        **contract,
        "canonicalValidationRequiredForAcceptance": True,
        "deckValidationRequiredForAcceptance": True,
    }


def build_run_manifest(
    training: dict[str, Any],
    benchmark: dict[str, Any],
    calibration: dict[str, Any],
    final: dict[str, Any],
    parity: dict[str, Any],
    model_path: Path,
) -> dict[str, Any]:
    manifest = load_manifest()
    current_sources = pipeline_source_sha256()
    stages = [
        {"order": 1, "name": "cpu_benchmark", "completed_at_utc": benchmark["completed_at_utc"]},
        {"order": 2, "name": "training_started", "completed_at_utc": training["started_at_utc"]},
        {"order": 3, "name": "training_and_model_selection", "completed_at_utc": training["completed_at_utc"]},
        {"order": 4, "name": "confidence_calibration", "completed_at_utc": calibration["evaluated_at_utc"]},
        {"order": 5, "name": "untouched_final_evaluation", "completed_at_utc": final["evaluated_at_utc"]},
        {"order": 6, "name": "onnx_export_and_parity", "completed_at_utc": parity["exported_at_utc"]},
    ]
    timestamps = [stage["completed_at_utc"] for stage in stages]
    return {
        "schema_version": 2,
        "run_id": "digits-crnn-remediation-v2",
        "stages": stages,
        "stage_timestamp_order_validated": timestamps == sorted(timestamps),
        "selected_checkpoint_sha256": training["selected_checkpoint_sha256"],
        "onnx_sha256": sha256_file(model_path),
        "pipeline_source_sha256_before_training": training[
            "pipeline_source_sha256_before_training"
        ],
        "pipeline_source_sha256_after_training": training[
            "pipeline_source_sha256_after_training"
        ],
        "pipeline_source_unchanged_during_training": training[
            "pipeline_source_unchanged_during_training"
        ],
        "pipeline_source_unchanged_from_training_completion_through_original_export": current_sources
        == training["pipeline_source_sha256_after_training"],
        "pipeline_source_audit_scope": "Future-run source hashes are captured before training and compared after training; export compares the completion hash again.",
        "seeds": {
            "training": training["seed"],
            "glyph_split": manifest["glyph_split"]["seed"],
            "model_selection_composition": manifest["compositions"]["model_selection"]["seed"],
            "calibration_composition": manifest["compositions"]["calibration"]["seed"],
            "final_composition": manifest["compositions"]["final_test"]["seed"],
        },
        "augmentation_tuning": training["augmentation_tuning"],
        "final_evaluation_used_for_tuning": False,
        "post_final_pipeline_changes": "None; only deterministic export, parity, metadata, and report serialization followed final evaluation.",
        "final_pool_provenance": "The untouched v1 reserve glyph pool became the v2 final pool; the previously evaluated v1 final pool was retired.",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--data-root", type=Path, default=Path("artifacts/data"))
    parser.add_argument(
        "--fixtures", type=Path, default=Path("manifests/export-fixtures.json")
    )
    parser.add_argument("--training-report", type=Path, default=Path("reports/training.json"))
    parser.add_argument("--benchmark-report", type=Path, default=Path("reports/cpu-benchmark.json"))
    parser.add_argument("--calibration-report", type=Path, default=Path("reports/calibration.json"))
    parser.add_argument("--final-report", type=Path, default=Path("reports/final-test.json"))
    parser.add_argument("--parity-report", type=Path, default=Path("reports/onnx-parity.json"))
    parser.add_argument("--run-report", type=Path, default=Path("reports/run-manifest.json"))
    parser.add_argument(
        "--metadata-only",
        action="store_true",
        help="validate existing artifact/reports and regenerate metadata without exporting ONNX",
    )
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()

    training = json.loads(args.training_report.read_text())
    benchmark = json.loads(args.benchmark_report.read_text())
    calibration = json.loads(args.calibration_report.read_text())
    final = json.loads(args.final_report.read_text())
    report_paths = {
        "training": args.training_report,
        "cpu_benchmark": args.benchmark_report,
        "calibration": args.calibration_report,
        "final": args.final_report,
        "onnx_parity": args.parity_report,
    }
    checkpoint_sha256 = validate_checkpoint_lineage(
        args.checkpoint, training, calibration, final
    )
    evaluation_lineage = validate_evaluation_lineage(
        training, calibration, final, args.calibration_report
    )
    if args.metadata_only:
        parity = json.loads(args.parity_report.read_text())
        run_manifest = json.loads(args.run_report.read_text())
        if parity["selected_checkpoint_sha256"] != checkpoint_sha256:
            raise ValueError("parity report checkpoint does not match supplied checkpoint")
        if parity["onnx_sha256"] != sha256_file(args.output):
            raise ValueError("existing ONNX does not match parity report")
        if run_manifest["onnx_sha256"] != sha256_file(args.output):
            raise ValueError("existing ONNX does not match run manifest")
        validate_run_manifest(
            run_manifest,
            training,
            benchmark,
            calibration,
            final,
            parity,
            report_paths,
        )
    else:
        export_static(args.checkpoint, args.output)
        fixture_indices = json.loads(args.fixtures.read_text())["final_manifest_indices"]
        parity = verify_parity(
            args.checkpoint, args.output, args.data_root, fixture_indices
        )
        parity["exported_at_utc"] = utc_now()
        parity["selected_checkpoint_sha256"] = checkpoint_sha256
        parity["onnx_sha256"] = sha256_file(args.output)
        args.parity_report.parent.mkdir(parents=True, exist_ok=True)
        args.parity_report.write_text(json.dumps(parity, indent=2) + "\n")
        run_manifest = build_run_manifest(
            training, benchmark, calibration, final, parity, args.output
        )
        run_manifest["report_sha256"] = {
            name: sha256_file(path) for name, path in report_paths.items()
        }
        if not run_manifest["stage_timestamp_order_validated"]:
            raise RuntimeError("run stage timestamps are not chronological")
        if not run_manifest["pipeline_source_unchanged_during_training"]:
            raise RuntimeError("pipeline source changed during training")
        if not run_manifest[
            "pipeline_source_unchanged_from_training_completion_through_original_export"
        ]:
            raise RuntimeError("pipeline source changed after training completed")
        args.run_report.parent.mkdir(parents=True, exist_ok=True)
        args.run_report.write_text(json.dumps(run_manifest, indent=2) + "\n")
        validate_run_manifest(
            run_manifest,
            training,
            benchmark,
            calibration,
            final,
            parity,
            report_paths,
        )
    model_metadata = metadata(
        args.output,
        training,
        benchmark,
        calibration,
        final,
        parity,
        run_manifest,
        evaluation_lineage,
    )
    args.metadata.parent.mkdir(parents=True, exist_ok=True)
    args.metadata.write_text(json.dumps(model_metadata, indent=2) + "\n")
    print(json.dumps(parity, indent=2))
    print(f"model SHA-256: {model_metadata['model']['sha256']}")


if __name__ == "__main__":
    main()
