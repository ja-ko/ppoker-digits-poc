import json
import math

import pytest

from decode import confidence_contract
from evaluate import (
    load_calibration_report,
    validate_evaluation_request,
    validate_final_confidence,
)


def calibration_report() -> dict:
    selected = confidence_contract("margin", math.log(4.0))
    return {
        "evaluation_role": "calibration",
        "manifest": "calibration",
        "confidence": {
            "data_role": "threshold selection only",
            "selected": selected,
        },
    }


def test_final_requires_calibration_and_model_selection_cannot_select_confidence() -> None:
    with pytest.raises(ValueError, match="requires --calibration-report"):
        validate_evaluation_request("final_test", True, None)
    with pytest.raises(ValueError, match="requires confidence"):
        validate_evaluation_request("final_test", False, None)
    with pytest.raises(ValueError, match="only for calibration"):
        validate_evaluation_request("model_selection", True, None)


def test_calibration_loader_rejects_wrong_report_role(tmp_path) -> None:
    report = calibration_report()
    report["evaluation_role"] = "final"
    path = tmp_path / "wrong-role.json"
    path.write_text(json.dumps(report))
    with pytest.raises(ValueError, match="wrong evaluation role"):
        load_calibration_report(path)


def test_final_preserves_exact_calibration_formula_and_threshold() -> None:
    selected = calibration_report()["confidence"]["selected"]
    validate_final_confidence(dict(selected), selected)
    changed = dict(selected)
    changed["raw_threshold"] = float(changed["raw_threshold"]) + 0.1
    with pytest.raises(ValueError, match="raw_threshold"):
        validate_final_confidence(changed, selected)
