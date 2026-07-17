import math

import numpy as np
import torch

from decode import (
    Alternative,
    canonical_value,
    confidence_contract,
    confidence_features,
    confidence_value,
    decision_metrics,
    greedy_decode,
    prefix_beam_decode,
    select_threshold,
)
from model import CrnnTiny


def logits_for_path(path: list[int]) -> np.ndarray:
    values = np.full((len(path), 11), -20.0, dtype=np.float32)
    for index, char in enumerate(path):
        values[index, char] = 0.0
    return values


def test_model_shape_for_static_contract() -> None:
    output = CrnnTiny().eval()(torch.zeros((2, 1, 32, 128)))
    assert output.shape == (2, 63, 11)
    assert torch.allclose(torch.logsumexp(output, dim=-1), torch.zeros((2, 63)), atol=1e-5)


def test_greedy_ctc_collapses_blanks_and_preserves_separated_repeats() -> None:
    blank = 10
    values = logits_for_path([blank, 1, 1, blank, 1, blank, 0, 0, blank])
    assert greedy_decode(values) == ["110"]


def test_prefix_beam_decodes_repeated_digit() -> None:
    values = logits_for_path([1, 10, 1])
    alternatives = prefix_beam_decode(values, beam_width=5)
    assert alternatives[0].text == "11"
    assert alternatives[0].score > alternatives[1].score


def test_prefix_beam_merges_paths_for_the_same_text() -> None:
    values = np.full((2, 11), -math.inf, dtype=np.float32)
    values[:, 1] = math.log(0.5)
    values[:, 10] = math.log(0.5)
    alternatives = prefix_beam_decode(values, beam_width=5)
    assert alternatives[0].text == "1"
    assert math.isclose(alternatives[0].score, math.log(0.75), abs_tol=1e-6)


def test_confidence_features_and_threshold_selection() -> None:
    features = confidence_features(
        [Alternative("13", -1.0), Alternative("18", -3.0)], time_steps=10
    )
    assert features == {"top_score_per_step": -0.1, "margin": 2.0, "combined": 0.0}
    assert math.isclose(confidence_value("top_score_per_step", -0.1), math.exp(-0.1))
    result = select_threshold([0.9, 0.8, 0.7, 0.1], [True, False, True, False])
    assert math.isclose(float(result["raw_threshold"]), 0.9)
    assert result["false_accepts"] == 0


def test_canonical_validation_rejects_unconstrained_decoder_text() -> None:
    assert canonical_value("0") == 0
    assert canonical_value("13") == 13
    assert canonical_value("255") == 255
    for text in ("", "00", "01", "256", "999", "-1", "1.0", "１２"):
        assert canonical_value(text) is None


def test_decision_metrics_require_canonical_text_and_use_false_rejection_schema() -> None:
    result = decision_metrics(
        [0.9, 0.9, 0.4],
        [False, True, True],
        [False, True, True],
        threshold=0.8,
    )
    assert result["false_accepts"] == 0
    assert result["false_rejects"] == 1
    assert result["false_rejection_rate"] == 0.5
    assert result["noncanonical_predictions"] == 1
    assert "correct_rejection_rate" not in result


def test_every_confidence_contract_maps_to_zero_one() -> None:
    for heuristic, raw_threshold in (
        ("top_score_per_step", -0.1),
        ("margin", 2.0),
        ("combined", 0.5),
    ):
        contract = confidence_contract(heuristic, raw_threshold)
        assert contract["heuristic"] == heuristic
        assert contract["formula"]
        assert 0.0 <= contract["confidence_threshold"] <= 1.0


def test_selected_margin_mapping_has_known_values_and_threshold_ordering() -> None:
    assert confidence_value("margin", -1.0) == 0.0
    assert confidence_value("margin", 0.0) == 0.0
    assert math.isclose(confidence_value("margin", math.log(2.0)), 0.5)
    assert math.isclose(confidence_value("margin", math.log(4.0)), 0.75)
    threshold = confidence_contract("margin", math.log(4.0))
    assert threshold["formula"] == (
        "1 - exp(-max(top-minus-second CTC sequence log-score margin, 0))"
    )
    assert math.isclose(threshold["confidence_threshold"], 0.75)
    assert confidence_value("margin", math.log(2.0)) < threshold["confidence_threshold"]
    assert confidence_value("margin", math.log(8.0)) > threshold["confidence_threshold"]
