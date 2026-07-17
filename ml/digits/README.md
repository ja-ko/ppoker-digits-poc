# Digit model tooling

Reproducible CPU tooling for the handwriting POC's static
`[1, 1, 32, 128]` white-on-black CRNN. The neural decoder emits unconstrained
digit text: it can be empty, have a leading zero, or exceed `255`. Preserve raw
text for diagnostics and exact-match errors, but never accept it unless
`canonical_value` validates canonical unsigned `0..255` text and downstream deck
validation also passes. No application-user handwriting is downloaded, uploaded,
or retained.

## Environment and sources

- Python is pinned to CPython 3.12.10 in `.python-version`.
- Exact CPU PyTorch, torchvision, ONNX, ONNX Runtime, and test dependencies are
  locked by `uv.lock`.
- `download.py` verifies SHA-256 before exposing the v1.3.0 upstream checkpoint,
  NIST-hosted EMNIST archive, or each extracted Digits file. Corrupt/missing raw
  files are replaced atomically. Downloads, data, caches, and `.pth` files stay
  below ignored `artifacts/`.
- `NOTICE.md` records CRNN Apache-2.0 attribution, its checkpoint-lineage
  boundary, and EMNIST provenance; the full license is tracked at
  `../../third_party/licenses/Apache-2.0.txt`.

```sh
uv sync --frozen
uv run pytest
uv run python verify.py
```

Those are the clean-checkout CI checks. They validate unit behavior, committed
manifest/report lineage and hashes, model metadata, ONNX structure, and exact
model bytes without training or downloading EMNIST/the upstream checkpoint.
Dataset-backed manifest regeneration is a separate, explicit check:

```sh
uv run python download.py all
uv run python freeze.py --verify
```

The official EMNIST train glyphs are the only training source. Official test
glyph IDs are deterministically split per class into four disjoint 10,000-glyph
pools. `manifests/v2.json` freezes the split algorithm, pool hashes, composition
seeds/counts, and hashes of every generated composition specification. Reserve
glyphs from v1 became the untouched v2 final pool; no unused test-glyph reserve
remains after this remediation iteration.

## Reproduce the selected run

Run these in order. The first command bootstraps the ignored upstream checkpoint
and EMNIST files under `artifacts/`, verifying their published and extracted
checksums before exposing them to training. Calibration is not run until
training/model selection is finished; final test is not run until the confidence
choice is frozen.

```sh
uv run python download.py all
uv run python train.py benchmark --steps 20
uv run python train.py fit --epochs 10 --samples-per-epoch 100000
uv run python evaluate.py artifacts/runs/best.pth calibration --confidence \
  --output reports/calibration.json
uv run python evaluate.py artifacts/runs/best.pth final_test --confidence \
  --calibration-report reports/calibration.json --output reports/final-test.json
uv run python export.py artifacts/runs/best.pth \
  ../../web-client/public/models/digits-crnn.onnx \
  --metadata ../../web-client/public/models/digits-crnn.json
```

Training labels cycle evenly through lengths one, two, and three, then sample
uniformly from `0-9`, `10-99`, and `100-255`. Each position uses a distinct
source glyph. Restrained deterministic augmentation varies rotation, affine
shape, thickness, baseline, spacing/overlap, and complete-sequence placement.
The background remains clean black.

## Evaluation boundary

`reports/training.json` contains model-selection results only.
`reports/calibration.json` compares top-score, top-versus-second margin, and a
combined heuristic. `reports/final-test.json` is the single untouched final
evaluation. `reports/onnx-parity.json` covers generated committed fixture IDs.
`reports/run-manifest.json` records stage timestamps, pipeline hashes, seeds, and
the selected fine-tuned checkpoint checksum. The existing v2 run captured source
hashes only at training completion, so it proves continuity from completion to
the original export, not unchanged source during training. Future runs compare
source and initialization-checkpoint hashes before and after training.

All confidence results are synthetic-only. They are not a correctness
probability, do not cover invalid or incomplete input, and are not safe evidence
for production automatic acceptance. EMNIST is scanned handwriting, not phone
finger input; browser and physical-device validation remain required.
