"""Small shared helpers for auditable run timestamps and file identities."""

from __future__ import annotations

import hashlib
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
PIPELINE_INPUTS = (
    "dataset.py",
    "decode.py",
    "download.py",
    "evaluate.py",
    "export.py",
    "freeze.py",
    "model.py",
    "provenance.py",
    "train.py",
    "manifests/v2.json",
    "pyproject.toml",
    "uv.lock",
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def sha256_file(path: Path | str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pipeline_source_sha256() -> dict[str, str]:
    return {name: sha256_file(ROOT / name) for name in PIPELINE_INPUTS}


def _ordered_epoch_records(
    epochs: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], int, float]]:
    if not epochs:
        raise ValueError("training history has no epochs")
    try:
        records = []
        for item in epochs:
            epoch = item["epoch"]
            if type(epoch) is not int:
                raise TypeError
            records.append(
                (
                    item,
                    epoch,
                    float(item["model_selection"]["overall"]["accuracy"]),
                )
            )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("invalid training epoch history") from error
    if [epoch for _, epoch, _ in records] != list(range(1, len(records) + 1)):
        raise ValueError("training epochs must be ordered, unique, and contiguous from 1")
    if not all(math.isfinite(accuracy) for _, _, accuracy in records):
        raise ValueError("training epoch accuracy must be finite")
    return records


def select_model_epoch(epochs: list[dict[str, Any]]) -> tuple[int, float]:
    """Select maximum exact-match accuracy, breaking ties by earliest epoch."""
    records = _ordered_epoch_records(epochs)
    _, epoch, accuracy = max(records, key=lambda record: (record[2], -record[1]))
    return epoch, accuracy


def validate_training_history(
    epochs: list[dict[str, Any]], epochs_completed: int
) -> dict[str, Any]:
    if type(epochs_completed) is not int or epochs_completed < 1:
        raise ValueError("epochs_completed must be a positive integer")
    records = _ordered_epoch_records(epochs)
    if len(records) != epochs_completed:
        raise ValueError("training history length does not match epochs_completed")
    if records[-1][1] != epochs_completed:
        raise ValueError("final training epoch does not match epochs_completed")
    selected_record, selected_epoch, selected_accuracy = max(
        records, key=lambda record: (record[2], -record[1])
    )
    has_future_flags = any(
        "became_best_so_far" in item or "selected_for_export" in item
        for item, _, _ in records
    )
    has_historical_flags = any("selected_as_best" in item for item, _, _ in records)
    if has_future_flags and has_historical_flags:
        raise ValueError("training history mixes historical and future selection flags")

    running_best = -math.inf
    for item, epoch, accuracy in records:
        became_best = accuracy > running_best
        if became_best:
            running_best = accuracy
        if has_future_flags:
            if set(("became_best_so_far", "selected_for_export")) - item.keys():
                raise ValueError("future training history has incomplete selection flags")
            if item["became_best_so_far"] is not became_best:
                raise ValueError("became_best_so_far does not match strict best-so-far")
            if item["selected_for_export"] is not (epoch == selected_epoch):
                raise ValueError("selected_for_export does not match selected epoch")
        elif has_historical_flags:
            if "selected_as_best" not in item:
                raise ValueError("historical training history has incomplete selection flags")
            if item["selected_as_best"] is not became_best:
                raise ValueError("historical selected_as_best does not match best-so-far")
        else:
            raise ValueError("training history has no recognized selection flags")

    return {
        "selected_epoch": selected_epoch,
        "selected_accuracy": selected_accuracy,
        "selected_record": selected_record,
        "flag_format": "future_explicit" if has_future_flags else "historical_best_so_far",
    }
