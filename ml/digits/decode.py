"""Greedy and prefix-beam CTC decoding plus deterministic confidence utilities."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import torch

from model import BLANK_INDEX

CONFIDENCE_FORMULAS = {
    "top_score_per_step": "exp(min(top CTC sequence natural-log score / time steps, 0))",
    "margin": "1 - exp(-max(top-minus-second CTC sequence log-score margin, 0))",
    "combined": "sigmoid(top_score_per_step + 0.05 * min(margin, 20))",
}


@dataclass(frozen=True)
class Alternative:
    text: str
    score: float


def _as_numpy(value: torch.Tensor | np.ndarray) -> np.ndarray:
    if isinstance(value, torch.Tensor):
        return value.detach().cpu().numpy()
    return value


def greedy_decode(log_probs: torch.Tensor | np.ndarray) -> list[str]:
    values = _as_numpy(log_probs)
    if values.ndim == 2:
        values = values[None, ...]
    decoded: list[str] = []
    for sample in values.argmax(axis=-1):
        previous = BLANK_INDEX
        text: list[str] = []
        for current in sample.tolist():
            if current != BLANK_INDEX and current != previous:
                text.append(str(current))
            previous = current
        decoded.append("".join(text))
    return decoded


def canonical_value(text: str) -> int | None:
    """Return a canonical unsigned 0..255 value, or None for any raw invalid text."""
    if not text or not text.isascii() or not text.isdecimal():
        return None
    if len(text) > 1 and text.startswith("0"):
        return None
    value = int(text)
    return value if value <= 255 else None


def is_canonical_prediction(text: str) -> bool:
    return canonical_value(text) is not None


def _logadd(*values: float) -> float:
    finite = [value for value in values if value != -math.inf]
    if not finite:
        return -math.inf
    maximum = max(finite)
    return maximum + math.log(sum(math.exp(value - maximum) for value in finite))


def prefix_beam_decode(
    log_probs: torch.Tensor | np.ndarray,
    beam_width: int = 10,
) -> list[Alternative]:
    values = _as_numpy(log_probs)
    if values.ndim != 2:
        raise ValueError("prefix beam decoding expects [time, classes]")
    beams: dict[tuple[int, ...], tuple[float, float]] = {(): (0.0, -math.inf)}
    for frame in values:
        next_beams: dict[tuple[int, ...], tuple[float, float]] = {}
        for prefix, (blank_score, nonblank_score) in beams.items():
            existing_blank, existing_nonblank = next_beams.get(
                prefix, (-math.inf, -math.inf)
            )
            next_beams[prefix] = (
                _logadd(
                    existing_blank,
                    blank_score + float(frame[BLANK_INDEX]),
                    nonblank_score + float(frame[BLANK_INDEX]),
                ),
                existing_nonblank,
            )
            for char in range(BLANK_INDEX):
                probability = float(frame[char])
                if prefix and char == prefix[-1]:
                    same_blank, same_nonblank = next_beams[prefix]
                    next_beams[prefix] = (
                        same_blank,
                        _logadd(same_nonblank, nonblank_score + probability),
                    )
                    extended = prefix + (char,)
                    ext_blank, ext_nonblank = next_beams.get(
                        extended, (-math.inf, -math.inf)
                    )
                    next_beams[extended] = (
                        ext_blank,
                        _logadd(ext_nonblank, blank_score + probability),
                    )
                else:
                    extended = prefix + (char,)
                    ext_blank, ext_nonblank = next_beams.get(
                        extended, (-math.inf, -math.inf)
                    )
                    next_beams[extended] = (
                        ext_blank,
                        _logadd(
                            ext_nonblank,
                            blank_score + probability,
                            nonblank_score + probability,
                        ),
                    )
        ranked = sorted(
            next_beams.items(),
            key=lambda item: _logadd(*item[1]),
            reverse=True,
        )[:beam_width]
        beams = dict(ranked)
    return [
        Alternative("".join(map(str, prefix)), _logadd(*scores))
        for prefix, scores in sorted(
            beams.items(), key=lambda item: _logadd(*item[1]), reverse=True
        )
    ]


def confidence_features(alternatives: list[Alternative], time_steps: int) -> dict[str, float]:
    top_score = alternatives[0].score
    second_score = alternatives[1].score if len(alternatives) > 1 else -math.inf
    margin = top_score - second_score
    normalized_score = top_score / time_steps
    return {
        "top_score_per_step": normalized_score,
        "margin": margin,
        "combined": normalized_score + 0.05 * min(margin, 20.0),
    }


def confidence_value(heuristic: str, raw_value: float) -> float:
    """Map each calibration feature monotonically into the runtime 0..1 contract."""
    if heuristic == "top_score_per_step":
        return math.exp(min(raw_value, 0.0))
    if heuristic == "margin":
        return 1.0 - math.exp(-max(raw_value, 0.0))
    if heuristic == "combined":
        if raw_value >= 0:
            return 1.0 / (1.0 + math.exp(-raw_value))
        exponent = math.exp(raw_value)
        return exponent / (1.0 + exponent)
    raise ValueError(f"unsupported confidence heuristic: {heuristic}")


def confidence_contract(heuristic: str, raw_threshold: float) -> dict[str, float | str]:
    if heuristic not in CONFIDENCE_FORMULAS:
        raise ValueError(f"unsupported confidence heuristic: {heuristic}")
    return {
        "heuristic": heuristic,
        "formula": CONFIDENCE_FORMULAS[heuristic],
        "raw_threshold": raw_threshold,
        "confidence_threshold": confidence_value(heuristic, raw_threshold),
    }


def decision_metrics(
    values: list[float],
    correct: list[bool],
    canonical: list[bool],
    threshold: float,
) -> dict[str, float | int]:
    if not values or len(values) != len(correct) or len(values) != len(canonical):
        raise ValueError("confidence values, correctness, and canonical flags must align")
    accepted = [
        is_canonical and value >= threshold
        for value, is_canonical in zip(values, canonical, strict=True)
    ]
    false_accepts = sum(a and not c for a, c in zip(accepted, correct, strict=True))
    false_rejects = sum(not a and c for a, c in zip(accepted, correct, strict=True))
    incorrect_total = sum(not item for item in correct)
    correct_total = sum(correct)
    return {
        "raw_threshold": threshold,
        "false_accepts": false_accepts,
        "false_rejects": false_rejects,
        "incorrect_total": incorrect_total,
        "correct_total": correct_total,
        "noncanonical_predictions": sum(not item for item in canonical),
        "incorrect_acceptance_rate": false_accepts / incorrect_total
        if incorrect_total
        else 0.0,
        "false_rejection_rate": false_rejects / correct_total if correct_total else 0.0,
    }


def select_threshold(
    values: list[float],
    correct: list[bool],
    canonical: list[bool] | None = None,
    max_incorrect_acceptance: float = 0.01,
) -> dict[str, float | int]:
    if not values or len(values) != len(correct):
        raise ValueError("confidence values and correctness must be non-empty and aligned")
    if canonical is None:
        canonical = [True] * len(values)
    if len(canonical) != len(values):
        raise ValueError("canonical flags must align with confidence values")
    candidates = sorted(set(values), reverse=True)
    candidates.append(math.nextafter(min(values), -math.inf))
    best: dict[str, float | int] | None = None
    for threshold in candidates:
        candidate = decision_metrics(values, correct, canonical, threshold)
        if candidate["incorrect_acceptance_rate"] > max_incorrect_acceptance:
            continue
        if best is None or candidate["false_rejects"] < best["false_rejects"]:
            best = candidate
    assert best is not None
    return best
