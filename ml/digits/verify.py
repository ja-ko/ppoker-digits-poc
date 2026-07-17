"""Verify committed model artifacts and report lineage without training or data."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import onnx
from onnx import TensorProto

from export import metadata, validate_evaluation_lineage, validate_run_manifest
from provenance import sha256_file

ROOT = Path(__file__).resolve().parent
MODEL_ROOT = ROOT.parents[1] / "web-client" / "public" / "models"
RUNTIME_TYPES = ROOT.parents[1] / "web-client" / "src" / "recognition" / "types.ts"
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def validate_manifest_links(
    manifest: dict[str, Any],
    fixtures: dict[str, Any],
    reports: dict[str, dict[str, Any]],
) -> None:
    if manifest.get("version") != "digits-manifests-v2":
        raise ValueError("unexpected manifest version")
    source = manifest.get("source", {})
    source_hashes = [source.get("archive_sha256")]
    source_hashes.extend(source.get("raw_sha256", {}).values())
    pool_hashes = manifest.get("glyph_split", {}).get("pool_sha256", {})
    source_hashes.extend(pool_hashes.values())
    if not source_hashes or not all(
        isinstance(value, str) and SHA256_PATTERN.fullmatch(value)
        for value in source_hashes
    ):
        raise ValueError("manifest contains an invalid SHA-256")

    compositions = manifest.get("compositions", {})
    if set(compositions) != {"model_selection", "calibration", "final_test"}:
        raise ValueError("manifest composition roles are incomplete")
    report_links = (
        (reports["training"]["model_selection_evaluation"], "model_selection"),
        (reports["calibration"], "calibration"),
        (reports["final"], "final_test"),
    )
    for report, role in report_links:
        if report.get("manifest") != role:
            raise ValueError(f"report does not reference {role} manifest")
        if report.get("composition_count") != compositions[role]["count"]:
            raise ValueError(f"{role} composition count does not match manifest")
        spec_hash = compositions[role].get("spec_sha256")
        if not isinstance(spec_hash, str) or not SHA256_PATTERN.fullmatch(spec_hash):
            raise ValueError(f"{role} has an invalid composition SHA-256")

    indices = fixtures.get("final_manifest_indices")
    if fixtures.get("manifest") != "final_test" or not isinstance(indices, list):
        raise ValueError("export fixtures must reference final_test")
    if len(indices) != len(set(indices)) or not all(
        type(index) is int and 0 <= index < compositions["final_test"]["count"]
        for index in indices
    ):
        raise ValueError("export fixture indices are invalid")


def tensor_shape(value_info: onnx.ValueInfoProto) -> list[int]:
    return [dimension.dim_value for dimension in value_info.type.tensor_type.shape.dim]


def runtime_constant(source: str, name: str) -> str:
    match = re.search(
        rf"export const {re.escape(name)}\s*=\s*(?:\[([^]]+)\]|\"([^\"]+)\"|(\d+))",
        source,
    )
    if not match:
        raise ValueError(f"runtime constant {name} is missing")
    return next(value for value in match.groups() if value is not None)


def verify_committed() -> dict[str, Any]:
    report_paths = {
        "training": ROOT / "reports/training.json",
        "cpu_benchmark": ROOT / "reports/cpu-benchmark.json",
        "calibration": ROOT / "reports/calibration.json",
        "final": ROOT / "reports/final-test.json",
        "onnx_parity": ROOT / "reports/onnx-parity.json",
    }
    reports = {name: load_json(path) for name, path in report_paths.items()}
    run = load_json(ROOT / "reports/run-manifest.json")
    manifest = load_json(ROOT / "manifests/v2.json")
    fixtures = load_json(ROOT / "manifests/export-fixtures.json")
    validate_manifest_links(manifest, fixtures, reports)
    recorded_manifest_sha256 = reports["training"][
        "pipeline_source_sha256_at_training_completion"
    ]["manifests/v2.json"]
    if sha256_file(ROOT / "manifests/v2.json") != recorded_manifest_sha256:
        raise ValueError("manifest file does not match its recorded SHA-256")

    lineage = validate_evaluation_lineage(
        reports["training"],
        reports["calibration"],
        reports["final"],
        report_paths["calibration"],
    )
    validate_run_manifest(
        run,
        reports["training"],
        reports["cpu_benchmark"],
        reports["calibration"],
        reports["final"],
        reports["onnx_parity"],
        report_paths,
    )

    model_path = MODEL_ROOT / "digits-crnn.onnx"
    metadata_path = MODEL_ROOT / "digits-crnn.json"
    committed_metadata = load_json(metadata_path)
    expected_metadata = metadata(
        model_path,
        reports["training"],
        reports["cpu_benchmark"],
        reports["calibration"],
        reports["final"],
        reports["onnx_parity"],
        run,
        lineage,
    )
    if committed_metadata != expected_metadata:
        raise ValueError("committed model metadata does not match reports and artifact")

    model_sha256 = sha256_file(model_path)
    model_references = {
        "metadata": committed_metadata["model"]["sha256"],
        "run manifest": run["onnx_sha256"],
        "parity report": reports["onnx_parity"]["onnx_sha256"],
    }
    if any(value != model_sha256 for value in model_references.values()):
        raise ValueError("ONNX SHA-256 references do not match committed model")
    if committed_metadata["model"]["bytes"] != model_path.stat().st_size:
        raise ValueError("model metadata byte count does not match committed model")
    runtime_source = RUNTIME_TYPES.read_text()
    runtime_contract = {
        "MODEL_METADATA_PATH": f"models/{metadata_path.name}",
        "MODEL_SHA256": model_sha256,
        "MODEL_INPUT_SHAPE": ", ".join(
            str(value) for value in committed_metadata["input"]["shape"]
        ),
        "MODEL_OUTPUT_SHAPE": ", ".join(
            str(value) for value in committed_metadata["output"]["shape"]
        ),
        "MODEL_CLASSES": committed_metadata["output"]["classes"],
        "CTC_BLANK_INDEX": str(committed_metadata["output"]["blankIndex"]),
        "CONFIDENCE_FORMULA": committed_metadata["confidence"]["formula"],
    }
    for name, expected in runtime_contract.items():
        if runtime_constant(runtime_source, name) != expected:
            raise ValueError(f"runtime constant {name} does not match model metadata")

    parity_indices = [
        fixture["final_manifest_index"]
        for fixture in reports["onnx_parity"].get("fixtures", [])
    ]
    if parity_indices != fixtures["final_manifest_indices"]:
        raise ValueError("parity report fixtures do not match export fixture manifest")
    if reports["onnx_parity"].get("decoded_parity") is not True:
        raise ValueError("parity report does not record decoded parity")

    graph = onnx.load(model_path, load_external_data=False)
    onnx.checker.check_model(graph)
    opsets = [
        item.version for item in graph.opset_import if item.domain in ("", "ai.onnx")
    ]
    if opsets != [committed_metadata["model"]["onnxOpset"]]:
        raise ValueError("ONNX opset does not match model metadata")
    model_input = graph.graph.input[0]
    model_output = graph.graph.output[0]
    if (
        model_input.name != committed_metadata["input"]["name"]
        or model_input.type.tensor_type.elem_type != TensorProto.FLOAT
        or tensor_shape(model_input) != committed_metadata["input"]["shape"]
        or model_output.name != committed_metadata["output"]["name"]
        or model_output.type.tensor_type.elem_type != TensorProto.FLOAT
        or tensor_shape(model_output) != committed_metadata["output"]["shape"]
    ):
        raise ValueError("ONNX input/output contract does not match model metadata")

    return {
        "model_sha256": model_sha256,
        "reports": sorted(report_paths),
        "manifest": manifest["version"],
    }


def main() -> None:
    result = verify_committed()
    print(
        "committed ML artifacts verified "
        f"({result['manifest']}, model SHA-256 {result['model_sha256']})"
    )


if __name__ == "__main__":
    main()
