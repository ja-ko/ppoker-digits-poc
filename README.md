# ppoker-digits-poc

A self-contained proof of concept for recognizing finger-written one-to-three-
digit numbers in a mobile browser. The repository includes the reproducible model
pipeline, evaluation records, committed ONNX model, browser interaction, and
automated verification.

The POC is intentionally not connected to a voting server or another application.
It uses a fixed mock deck to exercise automatic commit, rejection, cancellation,
and animation behavior.

## Status and limitations

The implementation and automated desktop verification are complete. Physical
iPhone Safari and Android Chrome testing remains open in
[`docs/handwriting-poc-smoke-test.md`](docs/handwriting-poc-smoke-test.md).

This is not a production-safe handwriting recognizer. Its `0.95` confidence
threshold is a synthetic-data usability heuristic, not a probability of
correctness. The committed browser corpus documents known false accepts and false
rejects, including confidently misclassified out-of-distribution marks. See
[`docs/handwriting-poc-browser-evidence.md`](docs/handwriting-poc-browser-evidence.md).

No handwriting is uploaded or retained.

## Run the POC

Prerequisites are Node `^22.22.2 || ^24.15.0 || >=26.0.0 <27`, npm `12.0.x`, and
a current browser with JavaScript, Web Workers, and WebAssembly enabled.

```shell
./scripts/serve-handwriting-poc.sh
```

The launcher installs the locked dependencies when necessary, prepares the
self-hosted ONNX Runtime and legal assets, builds the POC, and starts a production
Vite preview on `0.0.0.0`. Scan the printed QR code from a phone connected to the
same LAN, or open the printed **Network** URL. Use `?diagnostics=1` for model state,
raster inspection, mock-deck and threshold controls, timings, and the repeatable
browser benchmark.

Use another port with:

```shell
./scripts/serve-handwriting-poc.sh --port 5173
```

Plain LAN HTTP is supported because the runtime uses one WASM thread and verifies
the model in JavaScript. The launcher is a test server, not public hosting.

## Verify

The web suite covers formatting, linting, unit tests, production assets, launcher
and server smoke tests, model integrity, Chromium E2E/visual behavior, and focused
WebKit interaction regressions:

```shell
cd web-client
npm ci
npx playwright install --with-deps --only-shell chromium webkit
npm run verify:full
```

The ML suite verifies unit behavior, manifest and report lineage, metadata, ONNX
structure, runtime constants, and the exact committed model bytes without
downloading training data or retraining:

```shell
cd ml/digits
uv sync --frozen
uv run pytest
uv run python verify.py
```

Equivalent jobs are defined in `.github/workflows/web.yml` and
`.github/workflows/ml.yml`. Automated browser checks do not replace physical phone
testing.

## Model pipeline

The committed deployment artifact is
[`web-client/public/models/digits-crnn.onnx`](web-client/public/models/digits-crnn.onnx):

- SHA-256: `bea69199be71c01a35f4485ad853ef6fd11608c616c452598cb3f330922db9af`
- Input: float32 `[1, 1, 32, 128]`, white ink on black
- Output: `[1, time, 11]`, digits `0-9` plus CTC blank
- Canonical application range: unsigned `0..255`

The ignored PyTorch checkpoint is a training/export intermediate. Reproduce a run
from the checksum-verified upstream checkpoint and NIST-hosted EMNIST Digits data:

```shell
cd ml/digits
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

The committed reports describe the selected historical run and its documented
provenance limitations. A new run replaces generated reports and model artifacts;
it does not recreate history merely by editing recorded hashes. Full details are
in [`ml/digits/README.md`](ml/digits/README.md).

## Repository layout

- `ml/digits/`: downloads, data composition, training, evaluation, export, tests,
  manifests, and reports
- `web-client/`: React POC, ONNX Runtime worker, tests, Playwright flows, and the
  committed model
- `docs/`: implementation plan, deterministic browser evidence, benchmark, and
  physical smoke-test checklist
- `scripts/serve-handwriting-poc.sh`: clean local build and LAN preview launcher

## Licensing

The CRNN Tiny architecture and trained model derive from `zjykzj/crnn-ctc`,
copyright 2023 zjykzj, under Apache-2.0. The precise source revision, checkpoint
lineage, modifications, and data provenance are recorded in
[`ml/digits/NOTICE.md`](ml/digits/NOTICE.md), with the complete license at
[`third_party/licenses/Apache-2.0.txt`](third_party/licenses/Apache-2.0.txt).

The production web build includes the project, model, runtime, and dependency
license texts under `legal/`; its authoritative notice is
[`web-client/legal/THIRD_PARTY_NOTICES.txt`](web-client/legal/THIRD_PARTY_NOTICES.txt).
EMNIST data and the upstream initialization checkpoint are not redistributed.
