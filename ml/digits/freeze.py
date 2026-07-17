"""Validate compact frozen glyph/composition manifests against EMNIST."""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
from pathlib import Path

from dataset import (
    composition_spec,
    grouped_glyph_ids,
    load_emnist,
    load_manifest,
    pool_sha256,
    split_test_glyphs,
)


def spec_sha256(count: int, seed: int, groups: dict) -> str:
    digest = hashlib.sha256()
    for index in range(count):
        payload = json.dumps(
            dataclasses.asdict(composition_spec(index, seed, groups)),
            sort_keys=True,
            separators=(",", ":"),
        )
        digest.update(payload.encode())
        digest.update(b"\n")
    return digest.hexdigest()


def calculate(data_root: Path) -> dict:
    manifest = load_manifest()
    emnist = load_emnist(data_root, train=False)
    split = manifest["glyph_split"]
    pools = split_test_glyphs(
        emnist.targets, split["seed"], split["pool_size_per_digit"]
    )
    result = {
        "pool_sha256": {name: pool_sha256(ids) for name, ids in pools.items()},
        "composition_spec_sha256": {},
    }
    for name, definition in manifest["compositions"].items():
        groups = grouped_glyph_ids(emnist.targets, pools[definition["glyph_pool"]])
        result["composition_spec_sha256"][name] = spec_sha256(
            definition["count"], definition["seed"], groups
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=Path("artifacts/data"))
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    actual = calculate(args.data_root)
    if args.verify:
        manifest = load_manifest()
        expected = {
            "pool_sha256": manifest["glyph_split"]["pool_sha256"],
            "composition_spec_sha256": {
                name: definition["spec_sha256"]
                for name, definition in manifest["compositions"].items()
            },
        }
        if actual != expected:
            raise SystemExit(
                "manifest hash mismatch\n"
                f"expected: {json.dumps(expected, indent=2)}\n"
                f"actual: {json.dumps(actual, indent=2)}"
            )
        print("all frozen manifest hashes verified")
    else:
        print(json.dumps(actual, indent=2))


if __name__ == "__main__":
    main()
