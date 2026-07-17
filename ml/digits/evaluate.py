"""Exact-match evaluation and synthetic confidence calibration."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import torch
from torch.utils.data import DataLoader

from dataset import (
    CompositionDataset,
    collate_compositions,
    dataset_for_manifest,
    has_repeated_digit,
)
from decode import (
    confidence_contract,
    confidence_features,
    decision_metrics,
    greedy_decode,
    is_canonical_prediction,
    prefix_beam_decode,
    select_threshold,
)
from model import CrnnTiny, load_checkpoint
from provenance import sha256_file, utc_now


def _metric(correct: int, total: int) -> dict[str, float | int]:
    return {"correct": correct, "total": total, "accuracy": correct / total if total else 0.0}


def validate_evaluation_request(
    manifest: str,
    confidence: bool,
    calibration_report: Path | None,
) -> None:
    if manifest == "final_test":
        if not confidence:
            raise ValueError("final_test requires confidence evaluation")
        if calibration_report is None:
            raise ValueError("final_test requires --calibration-report")
        return
    if calibration_report is not None:
        raise ValueError("--calibration-report is valid only for final_test")
    if confidence and manifest != "calibration":
        raise ValueError("confidence selection is valid only for calibration")


def load_calibration_report(path: Path) -> dict[str, Any]:
    report = json.loads(path.read_text())
    if report.get("evaluation_role") != "calibration" or report.get("manifest") != "calibration":
        raise ValueError("calibration report has the wrong evaluation role or manifest")
    confidence = report.get("confidence", {})
    if confidence.get("data_role") != "threshold selection only" or "selected" not in confidence:
        raise ValueError("calibration report does not contain threshold selection")
    selected = confidence["selected"]
    expected = confidence_contract(
        selected["heuristic"], float(selected["raw_threshold"])
    )
    for key in ("heuristic", "formula", "raw_threshold", "confidence_threshold"):
        if selected.get(key) != expected[key]:
            raise ValueError(f"calibration report has inconsistent {key}")
    return report


def validate_final_confidence(
    final_confidence: dict[str, Any], selected: dict[str, Any]
) -> None:
    for key in ("heuristic", "formula", "raw_threshold", "confidence_threshold"):
        if final_confidence.get(key) != selected.get(key):
            raise ValueError(f"final confidence does not preserve calibration {key}")


def evaluate_model(
    model: CrnnTiny,
    dataset: CompositionDataset,
    batch_size: int,
    workers: int,
    confidence: bool = False,
    fixed_confidence: dict[str, Any] | None = None,
    evaluation_role: str = "model_selection",
) -> dict[str, Any]:
    if confidence and fixed_confidence is None and evaluation_role != "calibration":
        raise ValueError("only calibration evaluation may select confidence")
    if fixed_confidence is not None and evaluation_role != "final":
        raise ValueError("fixed calibration confidence is valid only for final evaluation")
    loader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=workers,
        collate_fn=collate_compositions,
        persistent_workers=workers > 0,
    )
    totals: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    feature_values: dict[str, list[float]] = defaultdict(list)
    beam_correctness: list[bool] = []
    beam_canonical: list[bool] = []
    beam_correct = 0
    greedy_noncanonical = 0
    model.eval()
    with torch.inference_mode():
        for images, _, _, labels in loader:
            output = model(images)
            predictions = greedy_decode(output)
            for prediction, label in zip(predictions, labels, strict=True):
                is_correct = prediction == label
                greedy_noncanonical += int(not is_canonical_prediction(prediction))
                totals["overall"][0] += int(is_correct)
                totals["overall"][1] += 1
                key = f"length_{len(label)}"
                totals[key][0] += int(is_correct)
                totals[key][1] += 1
                if has_repeated_digit(label):
                    totals["repeated_digits"][0] += int(is_correct)
                    totals["repeated_digits"][1] += 1
            if confidence:
                for sample, label in zip(output, labels, strict=True):
                    alternatives = prefix_beam_decode(sample, beam_width=10)
                    is_beam_correct = alternatives[0].text == label
                    beam_correct += int(is_beam_correct)
                    beam_correctness.append(is_beam_correct)
                    beam_canonical.append(is_canonical_prediction(alternatives[0].text))
                    for name, value in confidence_features(
                        alternatives, sample.shape[0]
                    ).items():
                        feature_values[name].append(value)

    report: dict[str, Any] = {
        "decoder": "greedy CTC",
        "raw_prediction_contract": "Unconstrained CTC text; may be empty, noncanonical, or outside 0..255.",
        "greedy_noncanonical_predictions": greedy_noncanonical,
        "overall": _metric(*totals["overall"]),
        "by_length": {
            str(length): _metric(*totals[f"length_{length}"])
            for length in (1, 2, 3)
        },
        "repeated_digits": _metric(*totals["repeated_digits"]),
    }
    if confidence:
        report["beam_width_10"] = _metric(beam_correct, len(beam_correctness))
        if fixed_confidence is None:
            experiments = {
                name: select_threshold(values, beam_correctness, beam_canonical)
                for name, values in feature_values.items()
            }
            selected_name, selected = min(
                experiments.items(),
                key=lambda item: (
                    item[1]["false_rejects"],
                    item[1]["false_accepts"],
                    ("combined", "margin", "top_score_per_step").index(item[0]),
                ),
            )
            report["confidence"] = {
                "data_role": "threshold selection only",
                "beam_width": 10,
                "max_incorrect_acceptance_rate": 0.01,
                "experiments": experiments,
                "selected": {
                    **confidence_contract(selected_name, float(selected["raw_threshold"])),
                    **selected,
                },
                "acceptance_contract": "Automatic acceptance or commit requires canonical 0..255 text, confidence threshold, and downstream deck validation; provisional rejection or dismissal may still use raw output.",
                "warning": "Synthetic-only heuristic; not a probability and not production-safe.",
            }
        else:
            selected = fixed_confidence["selected"]
            values = feature_values[selected["heuristic"]]
            report["confidence"] = {
                "data_role": "untouched final evaluation",
                **confidence_contract(
                    selected["heuristic"], float(selected["raw_threshold"])
                ),
                **decision_metrics(
                    values,
                    beam_correctness,
                    beam_canonical,
                    float(selected["raw_threshold"]),
                ),
                "acceptance_contract": "Automatic acceptance or commit requires canonical 0..255 text, confidence threshold, and downstream deck validation; provisional rejection or dismissal may still use raw output.",
                "warning": "Synthetic-only heuristic; not a probability and not production-safe.",
            }
            validate_final_confidence(report["confidence"], selected)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("manifest", choices=("model_selection", "calibration", "final_test"))
    parser.add_argument("--data-root", type=Path, default=Path("artifacts/data"))
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--threads", type=int, default=16)
    parser.add_argument("--confidence", action="store_true")
    parser.add_argument("--calibration-report", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    validate_evaluation_request(args.manifest, args.confidence, args.calibration_report)
    torch.set_num_threads(args.threads)
    dataset = dataset_for_manifest(args.data_root, args.manifest)
    fixed = None
    calibration_reference = None
    if args.calibration_report:
        calibration = load_calibration_report(args.calibration_report)
        checkpoint_sha256 = sha256_file(args.checkpoint)
        if calibration["checkpoint_sha256"] != checkpoint_sha256:
            raise ValueError("calibration report checkpoint does not match final checkpoint")
        fixed = calibration["confidence"]
        selected = fixed["selected"]
        calibration_reference = {
            "path": str(args.calibration_report),
            "sha256": sha256_file(args.calibration_report),
            **{
                key: selected[key]
                for key in (
                    "heuristic",
                    "formula",
                    "raw_threshold",
                    "confidence_threshold",
                )
            },
        }
    evaluation_role = {
        "model_selection": "model_selection",
        "calibration": "calibration",
        "final_test": "final",
    }[args.manifest]
    report = {
        "evaluated_at_utc": utc_now(),
        "checkpoint_sha256": sha256_file(args.checkpoint),
        "evaluation_role": evaluation_role,
        "manifest": args.manifest,
        "composition_count": len(dataset),
        **evaluate_model(
            load_checkpoint(args.checkpoint),
            dataset,
            args.batch_size,
            args.workers,
            args.confidence,
            fixed,
            evaluation_role,
        ),
    }
    if calibration_reference is not None:
        report["calibration_report"] = calibration_reference
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
