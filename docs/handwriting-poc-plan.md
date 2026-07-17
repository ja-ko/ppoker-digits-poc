# Handwriting Recognizer Proof-Of-Concept Plan

## Status

This proof of concept evaluates the riskiest mobile-client requirement: whether
finger-written one-to-three-digit numbers can be recognized and committed in a
fast, satisfying browser interaction. It deliberately excludes room networking
and does not establish that automatic confidence decisions are production-safe.

The final product plan is maintained in
[mobile-client-product-plan.md](mobile-client-product-plan.md).

Checklist convention:

- `[x]` means the requirement or decision is settled.
- `[ ]` means implementation or verification remains.

## Outcome

Produce a standalone mobile web page where a user can write a number, see a
deck-valid result commit through an ink-to-number animation, see input classified
by the provisional confidence rule disappear appropriately, and clear a
committed number to try again.

The proof establishes whether the recognizer and ink interaction are viable for
continued product development. It does not approve the provisional confidence
rule for production automatic commits. The product owner performs and records a
qualitative smoke test on physical iOS and Android devices; synthetic model
accuracy alone is insufficient for the feasibility decision.

## Requirements

### Input

- [x] Use a fullscreen drawing surface optimized for portrait phones.
- [x] Support finger, stylus, and mouse input.
- [x] Support canonical unsigned integers from `0` through `255`.
- [x] Do not support signs, decimal separators, fractions, or written words.
- [x] Store input as strokes containing ordered `x`, `y`, and timestamp values.
- [x] Store pressure and pointer type when available, but do not require them.
- [x] Derive velocity from position and time when rendering needs it.
- [x] Use coalesced Pointer Events when available and fall back to the dispatched
  event when they are not.
- [x] Prevent page scrolling, selection, callouts, and browser gestures from
  interrupting normal drawing inside the pad.

### Recognition And Finish Detection

- [x] Recognition runs automatically after the user pauses.
- [x] Quiet time is measured from the most recently captured input point and
  inference does not start while a pointer is active.
- [x] A confident recognized number commits automatically when it occurs in the
  current mock deck.
- [x] The UI never presents a low-confidence candidate for confirmation.
- [x] Low-confidence input dissipates after the inactivity grace period.
- [x] Confident input outside the deck shakes and then disappears.
- [x] Rejection is never immediate after a stroke; the user can add strokes that
  change an incomplete digit or number.
- [x] Exact values that prefix longer deck cards receive a longer wait.
- [x] Proper prefixes receive a longer wait and then fade as incomplete input.
- [x] Any new `pointerdown` preserves existing ink, starts a new drawing
  revision, and cancels pending inference, effects, and timers.
- [x] Stale inference responses cannot change the current input.

Initial timing targets:

| Situation | Quiet period before action |
| --- | ---: |
| Valid card, not a longer-card prefix | 650-700 ms |
| Valid card and longer-card prefix | about 1,000 ms |
| Proper prefix only, then fade as incomplete | about 1,100 ms |
| Invalid or low confidence | about 1,100 ms |

These values are tuning defaults, not protocol guarantees.

### Committed And Rejected States

- [x] A committed result is displayed as a large typeset number.
- [x] The original trace settles, contracts, or dissolves into that number.
- [x] A clear button removes the committed number and restores the empty pad.
- [x] Scratch-out-to-clear is not included in the proof of concept.
- [x] Invalid input shakes before fading.
- [x] Low-confidence input fades without a shake or claimed result.
- [x] Visual feedback is complete without haptics.
- [x] Android vibration may be added as progressive enhancement.
- [x] Programmable iOS haptics are not expected in the web proof.

### Mock Deck

- [x] Use this fixed proof-of-concept mock deck for commit validation:
  `1`, `2`, `3`, `5`, `8`, `13`, and `☕`.
- [x] Only numeric cards are recognized by handwriting.
- [x] Keep recognition output visible in diagnostics even when deck validation
  rejects it.
- [x] Do not implement the deck picker in this proof.

## Technology Decisions

- [x] Use React, TypeScript, and Vite in `web-client/`.
- [x] Keep high-frequency point capture and drawing outside React state.
- [x] Use Canvas 2D for visible ink and offscreen recognition rasterization.
- [x] Use a Web Worker for model initialization and inference.
- [x] Use ONNX Runtime Web's WASM-only import.
- [x] Use one WASM thread to avoid cross-origin-isolation requirements.
- [x] Do not require WebGPU or WebGL.
- [x] Commit the selected ONNX model and its metadata to the repository.
- [x] Source matching ONNX Runtime assets from the locked npm dependency and
  self-host them in the built application.
- [x] Download the upstream checkpoint and EMNIST data with verified checksums;
  do not commit them.
- [x] Use Vitest for deterministic TypeScript unit tests.
- [x] Use `uv` for reproducible Python model tooling.
- [x] Record supported Node and Python versions alongside their lockfiles.
- [x] Do not add Rust/WASM or restructure the existing Rust package in this proof.

## Model Decision

Fine-tune the Apache-2.0 CRNN Tiny model from
[`zjykzj/crnn-ctc`](https://github.com/zjykzj/crnn-ctc), starting from the
`crnn_tiny-emnist.pth` checkpoint published with release
[`v1.3.0`](https://github.com/zjykzj/crnn-ctc/releases/tag/v1.3.0).

- [x] Architecture: convolutional feature extractor, two-layer bidirectional GRU,
  linear classifier, and CTC decoding.
- [x] Output alphabet: `0` through `9` plus CTC blank.
- [x] Published checkpoint size: approximately 1.7 MB.
- [x] Published input: grayscale `32x160` images containing five digits.
- [x] Proof input: grayscale `32x128` images containing one to three digits.
- [x] Reuse the checkpoint because model weights do not depend on the horizontal
  sequence length.
- [x] Export a static batch-one ONNX model after fine-tuning.
- [x] Do not use `thawro/yolov8-digits-detection` in the proof.

Model contract:

```text
Input name: input
Input type: float32
Input shape: [1, 1, 32, 128]
Input range: 0.0 to 1.0
Polarity: white ink on black
Output name: output
Output shape: [1, time, 11]
Classes: 0-9, blank at index 10
Output values: natural-log probabilities produced by log-softmax
```

## Training Data Plan

Use the NIST-hosted EMNIST Digits dataset, which contains 280,000 balanced
single-digit images. Multi-digit samples are generated dynamically rather than
collected from users.

### Label Generation

- [x] Choose sequence length uniformly from one, two, or three.
- [x] Generate canonical labels without leading zeroes except for `0` itself.
- [x] Sample one-digit labels from `0-9`.
- [x] Sample two-digit labels from `10-99`.
- [x] Sample three-digit labels from `100-255`.
- [x] Include repeated digits naturally, including `11`, `100`, and `222`.
- [x] Balance sequence lengths so three-digit samples do not dominate.

### Glyph And Sequence Augmentation

- [x] Select a separate EMNIST glyph for every digit.
- [x] Apply mild independent rotation, scaling, translation, and shear.
- [x] Vary stroke thickness with restrained morphology operations.
- [x] Vary digit baseline and vertical scale.
- [x] Vary inter-digit spacing and allow slight overlap.
- [x] Vary complete-sequence scale and horizontal placement within `32x128`.
- [x] Keep a clean black background because the target is a drawing canvas, not a
  photographed document.
- [x] Avoid augmentation that changes the digit's semantic identity.

### Data Separation

- [x] Build training compositions only from official EMNIST training glyphs.
- [x] Split official EMNIST test glyphs into disjoint model-selection,
  confidence-calibration, final-test, and unused reserve pools.
- [x] Use a fixed split seed and fixed composition seeds for model-selection,
  calibration, and final-test manifests.
- [x] Freeze the reserve glyph IDs without composing or evaluating them unless a
  later model iteration needs a new untouched final-test set.
- [x] Never use a non-training-pool glyph in training.
- [x] Do not collect, upload, or persist application-user handwriting.
- [x] Do not retain handwriting from the product owner's physical-device smoke
  tests.
- [x] Do not claim that the synthetic calibration pool represents scribbles,
  partial digits, letters, signs, or other out-of-distribution input.

### Initial Training Run

- [x] Initialize from the published CRNN Tiny checkpoint.
- [x] Generate 100,000 training compositions per epoch.
- [x] Begin with 10 fine-tuning epochs and a learning rate around `1e-4`.
- [x] Save the checkpoint with the best model-selection exact-match accuracy.
- [x] Report exact-match accuracy by sequence length and for repeated digits.
- [ ] Measure local CPU training throughput before changing batch or epoch counts.
- [ ] Tune augmentation only in response to documented model-selection failures.
- [ ] Freeze all composition manifests before using the calibration or final-test
  results.
- [ ] Treat the final-test result as a report, not a tuning input. Any later model
  iteration must use a newly frozen final-test set that has not informed changes.

## Browser Recognition Pipeline

### Capture And Visible Rendering

- [ ] Capture Pointer Events and coalesced points into stroke objects.
- [ ] Use pointer capture until `pointerup` or `pointercancel`.
- [ ] Accept only the primary pointer and the primary mouse button; ignore
  additional simultaneous pointers.
- [ ] On `pointercancel`, lost capture, resize, or orientation change, discard the
  active partial stroke, preserve completed strokes, and cancel pending work.
- [ ] Require a subsequent clean pointer interaction before recognizing preserved
  strokes after cancellation.
- [ ] Smooth visible traces with quadratic or equivalent interpolated curves.
- [ ] Derive a restrained visible line-width response from filtered velocity.
- [ ] Handle device-pixel ratio without changing logical stroke coordinates.
- [ ] Verify iOS gesture suppression on a physical device.

### Recognition Raster

- [ ] Compute a bounding box over all current stroke points.
- [ ] Reject empty and trivially small accidental input before inference.
- [ ] Add proportional padding around the ink.
- [ ] Preserve the complete drawing's aspect ratio.
- [ ] Fit the drawing inside approximately `120x26` model pixels.
- [ ] Center it on a black `128x32` raster.
- [ ] Render white strokes with fixed model width, round caps, and round joins.
- [ ] Convert pixels to row-major NCHW `Float32Array` in the range `0.0-1.0`.
- [ ] Expose the exact model raster in diagnostic mode.
- [ ] Freeze versioned preprocessing parameters for padding, tiny-input cutoff,
  stroke width, resampling, and rounding before confidence calibration.

### Inference And Decoding

- [ ] Load ONNX Runtime and the model once in a worker.
- [ ] Surface loading progress and initialization failures to the page.
- [ ] Transfer tensors rather than copying large canvas state unnecessarily.
- [ ] Run the batch-one ONNX session through the WASM execution provider.
- [ ] Implement CTC greedy decoding as a correctness baseline.
- [ ] Implement a small CTC prefix beam that combines paths with log-sum-exp.
- [ ] Rank alternatives by CTC sequence log-score and compute the top-versus-
  second score margin.
- [ ] Return text, confidence, alternatives, and inference duration.
- [ ] Discard responses whose request ID is no longer current.
- [ ] Measure `inferenceMs` around `session.run`; report worker round-trip and
  rasterization time separately in diagnostics.

Recognizer interface:

```ts
type Recognition = {
  text: string;
  // Provisional synthetic-data heuristic in the range 0..1, not a calibrated
  // probability of correctness on arbitrary user input.
  confidence: number;
  alternatives: Array<{
    text: string;
    // Beam-estimated natural-log CTC sequence score; higher is better.
    score: number;
  }>;
  inferenceMs: number;
};
```

### Confidence

- [x] Confidence is used only for automatic acceptance or dismissal.
- [x] Normal UI does not show alternatives or ask the user to choose one.
- [x] Confidence in this proof is a provisional heuristic, not a claimed
  probability that the prediction is correct.
- [ ] Compare deterministic heuristics derived from the top sequence score and
  top-versus-second margin against the frozen synthetic calibration pool.
- [ ] Document and freeze the selected confidence formula before evaluating the
  untouched synthetic final-test pool.
- [ ] Select the initial automatic-action threshold against the calibration pool.
- [ ] Display raw scores, top alternatives, margin, formula inputs, and threshold
  result in diagnostics.
- [ ] Let the product owner tune the threshold temporarily during qualitative
  device testing without retaining handwriting or changing recorded final-test
  metrics.
- [ ] Prefer false rejection over a wrong automatic commit.
- [x] Production confidence and invalid-input safety require separate future
  evaluation with representative data under an approved data policy.

### Recognizer Failure Handling

- [ ] Track recognizer readiness separately as `loading`, `ready`, or `failed`.
- [ ] Disable drawing until the recognizer is ready.
- [ ] Surface initialization and worker failures with a retry control.
- [ ] Time out hung inference without committing or rejecting the input.
- [ ] Preserve ink after an inference failure so retry or additional input is
  possible.

## Interaction State Machine

```text
Recognizer readiness
  loading -> ready
  loading or ready -> failed -> loading (retry)

Vote input, enabled only while the recognizer is ready
  empty -> drawing -> settling
  settling -> drawing (new input; pending work canceled)
  settling -> committing -> committed
  settling -> rejecting -> empty
  settling -> drawing (inference failure; ink preserved)
  committing or rejecting -> drawing (new input; effect canceled)
  committed -> clearing -> empty
```

- [ ] Represent transitions as explicit reducer events.
- [ ] Keep at most one pending inference/action timer for the current drawing
  revision, replacing it when classification selects an extended deadline.
- [ ] Increment the drawing revision immediately on each accepted `pointerdown`
  and on clear.
- [ ] Cancel deadlines when drawing resumes.
- [ ] Prevent model completion from committing an old revision.
- [ ] Schedule initial inference after the base quiet period from the last point.
- [ ] Commit a valid non-prefix result when current inference completes.
- [ ] Delay an exact card that is also a longer-card prefix until its extended
  deadline, then commit it if the revision is still current.
- [ ] Delay a proper-prefix-only result until its extended deadline, then fade it
  as incomplete input without a shake.
- [ ] Apply invalid and low-confidence effects at their extended deadline; if
  inference finishes after a deadline, act immediately only when its revision is
  still current.
- [ ] Restore the complete vector trace when drawing cancels a settling, commit,
  or rejection animation.
- [ ] Prevent drawing while the committed state is visible.

## Animation Plan

- [ ] Keep the original vector trace until its transition completes.
- [ ] On commit, subtly tighten or scale the trace toward the result's center.
- [ ] Crossfade the trace into a clean typeset number.
- [ ] Add a restrained landing scale/easing to the typeset result.
- [ ] On invalid input, shake the trace horizontally and then fade it.
- [ ] On low confidence, fade or disperse without a shake.
- [ ] On clear, remove the committed number and restore the drawing surface.
- [ ] Ensure animations cannot complete against a newer drawing revision.
- [ ] Provide a reduced-motion variant.

## Diagnostics

Diagnostic mode should be available through a development control or query
parameter and must not alter recognition behavior.

- [ ] Display model readiness and initialization errors.
- [ ] Display raw stroke and point counts.
- [ ] Display the normalized `32x128` input raster enlarged with nearest-neighbor
  scaling.
- [ ] Display predicted text, confidence, alternatives, and inference time.
- [ ] Display raw sequence scores, top-versus-second margin, and separate
  rasterization, worker round-trip, and model timings.
- [ ] Display current interaction state, drawing revision, and timer reason.
- [ ] Allow the mock numeric deck and confidence threshold to be adjusted in
  diagnostics.
- [ ] Reject noncanonical diagnostic deck entries and numeric entries outside
  `0-255`; ignore duplicate entries for prefix matching.
- [ ] Provide a repeatable warm-inference benchmark control.

## Proposed Project Layout

```text
web-client/
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── public/
│   ├── models/digits-crnn.onnx
│   ├── models/digits-crnn.json
│   └── ort/
└── src/
    ├── ink/
    │   ├── capture.ts
    │   ├── render.ts
    │   ├── rasterize.ts
    │   └── types.ts
    ├── recognition/
    │   ├── client.ts
    │   ├── ctc.ts
    │   ├── worker.ts
    │   └── types.ts
    ├── poc/
    │   ├── RecognitionPad.tsx
    │   ├── recognition-state.ts
    │   └── Diagnostics.tsx
    ├── App.tsx
    └── styles.css

ml/digits/
├── pyproject.toml
├── dataset.py
├── model.py
├── train.py
├── evaluate.py
├── export.py
├── manifests/
├── reports/
├── tests/
└── README.md
```

## Implementation Checklist

### Scaffold

- [ ] Create the Vite React TypeScript project in `web-client/`.
- [ ] Add formatting, linting, Vitest, and production build scripts.
- [ ] Pin the supported Node version and package-manager behavior.
- [ ] Add web artifacts to `.gitignore`.
- [ ] Add a dedicated web CI job without changing native release behavior.
- [ ] Do not change native release-versioning policy while the proof remains
  unmerged; revisit release isolation before product integration.

### Model Tooling

- [ ] Create the `ml/digits/` `uv` project.
- [ ] Pin Python, PyTorch, torchvision, ONNX, and ONNX Runtime versions.
- [ ] Add model and checkpoint attribution notices.
- [ ] Add checksum-verified checkpoint and EMNIST download instructions.
- [ ] Implement deterministic sequence generation and unit tests.
- [ ] Generate and freeze model-selection, calibration, and final-test composition
  manifests plus a reserve-glyph manifest, documenting pool sizes, composition
  counts, and seeds.
- [ ] Load the published CRNN Tiny checkpoint.
- [ ] Measure CPU training throughput before committing to the full run.
- [ ] Fine-tune and evaluate the variable-length model.
- [ ] Export ONNX at a documented opset.
- [ ] Verify PyTorch and ONNX Runtime output parity.
- [ ] Record model checksum, source revision, confidence formula, preprocessing
  version, metrics, and training configuration in committed metadata and reports.

### Web Integration

- [ ] Implement stroke capture and visible rendering.
- [ ] Implement deterministic rasterization with snapshot fixtures.
- [ ] Add ONNX Runtime WASM assets and the inference worker.
- [ ] Implement CTC decoding and confidence diagnostics.
- [ ] Implement finish detection and the interaction reducer.
- [ ] Implement recognizer retry, crash, and timeout handling.
- [ ] Implement commit, rejection, and clear animations.
- [ ] Add the mock deck and diagnostic controls.

### Verification

- [ ] Unit-test CTC collapse, repeated digits, and blank handling.
- [ ] Unit-test prefix-beam path merging, score ordering, margin calculation, and
  the selected confidence formula.
- [ ] Unit-test bounding-box, padding, scaling, and pixel polarity.
- [ ] Test raster geometry and tensor conversion as pure functions; use explicit
  tolerances for browser Canvas antialiasing checks rather than portable
  pixel-perfect snapshots.
- [ ] Unit-test state transitions with fake timers and stale inference responses.
- [ ] Unit-test pointer cancellation, recognizer failure, and delayed-prefix
  transitions.
- [ ] Verify production Vite asset paths for model, worker, `.mjs`, and `.wasm`.
- [ ] Test desktop mouse input.
- [ ] Provide a production-build URL and qualitative physical-device smoke-test
  checklist to the product owner.
- [ ] Product owner tests physical iPhone Safari input and lifecycle.
- [ ] Product owner tests physical Android Chrome input and lifecycle.
- [ ] In the development browser, record cold load and, after 10 warm-up runs,
  warm inference median and p95 over 100 runs. Record model and end-to-end timings
  separately.
- [ ] Make the same benchmark available to the product owner during device smoke
  testing without making a numeric result part of the qualitative device gate.

## Acceptance Gates

### Model Gates

- [ ] Overall exact-match accuracy is at least 98% on the untouched generated
  final-test manifest.
- [ ] No one-, two-, or three-digit final-test bucket is below 97% exact match.
- [ ] Repeated-digit final-test results are reported separately and meet the same
  97% floor.
- [ ] ONNX inference matches PyTorch decoding on committed fixtures.
- [ ] Synthetic calibration and untouched final-test metrics are reported
  separately, including false acceptance of incorrect digit predictions and false
  rejection of correct predictions.

### Browser Gates

- [ ] The UI does not visibly stall while inference runs.
- [ ] The POC mock numeric deck values can each be entered repeatedly on iOS and
  Android with qualitatively acceptable first-attempt recognition.
- [ ] The product owner exercises `0`, digits absent from the mock deck, and
  representative two- and three-digit values through `255` using diagnostic deck
  controls.
- [ ] Multi-stroke digits are not rejected before the inactivity grace period.
- [ ] Adding a stroke during settling never commits the prior partial number.
- [ ] Inputs provisionally classified as invalid wait, shake, and clear without
  submitting anything.
- [ ] Inputs below the provisional confidence threshold disappear without showing
  a correction workflow.
- [ ] Clear always returns to a fully usable empty pad.
- [ ] No handwriting data leaves the browser.
- [ ] The product owner records qualitative device results and concrete failing
  examples without retaining handwriting traces or rasters.

### Exit Decision

- [ ] Accept CRNN Tiny and its preprocessing as viable for continued product
  development, or document concrete failure categories and reject it.
- [ ] If rejected, determine whether the failure is rasterization, synthetic-data
  domain mismatch, model capacity, or confidence calibration before selecting a
  replacement.
- [ ] Record explicitly that POC acceptance does not approve the confidence rule
  for production automatic commits or establish out-of-distribution safety.
- [ ] Do not begin Rust/WASM room integration until the recognizer exit decision
  is recorded.

## Non-Goals

- [x] No WebSocket or server connection.
- [x] No QR code generation or room URL routing.
- [x] No Rust crate restructuring or browser WASM poker client.
- [x] No name generation, persistence, or session resumption.
- [x] No reveal, reset, average, distribution, or exact-vote views.
- [x] No deck picker implementation.
- [x] No special-card handwriting recognition.
- [x] No decimal, fraction, sign, or number-word recognition.
- [x] No scratch-out clear gesture.
- [x] No iOS native wrapper or guaranteed iOS haptics.
- [x] No model personalization or user handwriting collection.
- [x] No retained manual-handwriting calibration or out-of-distribution dataset.
- [x] No claim that production-safe automatic acceptance or rejection has been
  validated.
- [x] No custom ONNX Runtime minimal build until normal WASM payload and latency
  have been measured.
- [x] No installable PWA or offline application shell.

## Risks

- [ ] EMNIST glyphs come from scanned handwriting rather than phone finger input;
  normalization and augmentation may not close the domain gap.
- [ ] Synthetic stitching does not preserve correlations between digits written
  by the same person.
- [ ] The published model's confidence may be overconfident on unfamiliar canvas
  input.
- [ ] The general ONNX Runtime WASM payload may dominate cold-load time despite
  the small model.
- [ ] iOS browser gesture handling may still produce `pointercancel` on edge-case
  interactions and must be tested physically.
- [ ] A visually expressive variable-width trace may differ from the fixed-width
  recognition raster; both must remain geometrically faithful to the same input.

## References

- CRNN Tiny source and checkpoint:
  <https://github.com/zjykzj/crnn-ctc/releases/tag/v1.3.0>
- EMNIST dataset:
  <https://www.nist.gov/itl/products-and-services/emnist-dataset>
- ONNX Runtime Web deployment:
  <https://onnxruntime.ai/docs/tutorials/web/deploy.html>
- Pointer Events specification:
  <https://www.w3.org/TR/pointerevents3/>
