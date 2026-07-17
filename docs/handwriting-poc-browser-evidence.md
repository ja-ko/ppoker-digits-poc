# Handwriting POC Deterministic Browser Evidence

## Scope

The Playwright slice drives committed line templates through browser pointer
input, deterministic rasterization, the production Web Worker, the checked-in
ONNX model, and the UI state machine. It runs against the production Vite
preview in pinned Chromium with one worker. A focused Playwright WebKit slice
also covers the iOS-related interaction regressions; physical Safari remains a
separate acceptance gate.

The browser POC uses one explicit, adjustable confidence threshold of `0.95` for
every decoded value. This usability default lets the observed valid fixtures
commit, but it also accepts known invalid/out-of-distribution marks that the
model confidently decodes as default-deck values. There is no geometric or
value-specific policy. Canonical `0..255` parsing and exact mock-deck membership
remain separate gates. The model, metadata, calibration report, and other ML
artifacts remain unchanged.

Committed E2E verifies that all numeric default-deck templates (`1`, `2`, `3`,
`5`, `8`, and `13`) reach the expected UI commit. The real-model corpus also
records unscaled landscape `2`, `3`, `5`, and `8`, plus independently redrawn
joined two-stroke `5`, based `1`, two-loop `8`, and non-aliased `13` fixtures. A
pending `1` cannot commit after the second stroke starts; explicit
`orientationchange` and resize interruptions discard an active partial stroke;
an adjusted threshold of `1` rejects a recognized template; and removing `5`
from the diagnostic deck prevents its commit. Canonical deck parsing rejects
`01` and `256`.

## Committed Corpus

`web-client/e2e/confidence-corpus.ts` is driven through pointer capture,
rasterization, the real worker/model, diagnostics, and the UI acceptance path.
The table records deterministic Chromium observations at the `0.95` usability
threshold. Confidence is the displayed six-decimal provisional margin
heuristic; `-` means the tiny-input guard did not invoke the model. Reproduce it
with `npm run test:e2e:focused -- "POC browser confidence corpus"`.

| Case                   |  Beam | Greedy | Confidence | Threshold | UI evidence             |
| ---------------------- | ----: | -----: | ---------: | --------: | ----------------------- |
| default `1`            |     1 |      1 |   0.996158 |      pass | commit 1                |
| default `2`            |     2 |      2 |   0.999977 |      pass | commit 2                |
| default `3`            |     3 |      3 |   0.999929 |      pass | commit 3                |
| default `5`            |     5 |      5 |   0.999974 |      pass | commit 5                |
| default `8`            |     8 |      8 |   0.999947 |      pass | commit 8                |
| default `13`           |    13 |     13 |   0.999760 |      pass | commit 13               |
| unscaled landscape `2` |     2 |      2 |   0.996571 |      pass | commit 2                |
| unscaled landscape `3` |     3 |      3 |   0.983747 |      pass | commit 3                |
| unscaled landscape `5` |     5 |      5 |   0.996911 |      pass | commit 5                |
| unscaled landscape `8` |     2 |      2 |   0.261995 |      fail | known false reject      |
| joined two-stroke `5`  |     5 |      5 |   0.999991 |      pass | commit 5                |
| based `1`              |     1 |      1 |   0.998110 |      pass | commit 1                |
| two-loop `8`           |     8 |      8 |   0.999842 |      pass | commit 8                |
| non-aliased `13`       |    13 |     13 |   0.999945 |      pass | commit 13               |
| tiny diagonal          |     - |      - |          - |         - | no commit               |
| horizontal dash        | empty |  empty |   0.870621 |      fail | no commit               |
| cross                  | empty |  empty |   0.889082 |      fail | no commit               |
| circle                 |     0 |      0 |   0.997141 |      pass | no commit; not in deck  |
| letter-like `M`        |    11 |     11 |   0.463123 |      fail | no commit               |
| wide zigzag            |     3 |      3 |   0.991893 |      pass | known false accept as 3 |
| tight `13`             |    13 |     13 |   0.750995 |      fail | no commit               |
| repeated `11`          |    11 |     11 |   0.999622 |      pass | no commit; not in deck  |
| overlapping `13`       |     8 |      8 |   0.999924 |      pass | known false accept as 8 |

The wide zigzag and overlapping `13` are known false accepts because they decode
to in-deck values above `0.95`; beam/greedy agreement does not distinguish them.
The zigzag and overlapping trace still exceed the usability threshold and
decode to in-deck values. Their committed corpus cases pin the raw text, greedy
text, confidence, and threshold result, but deliberately do not require the
undesirable UI commit forever. The bounded zone also changes template geometry;
the unchanged relative landscape `8` now records a low-confidence false reject.
This evidence establishes neither invalid-mark rejection nor
out-of-distribution safety.

The landscape fixtures use the same relative default-card points without
reciprocal narrowing at an `844x390` viewport. They exercise viewport, pointer
capture, canonical-coordinate, raster, worker, and model integration. They are
not independent handwriting diversity. The joined/multi-stroke and non-aliased
fixtures vary their point paths independently from the defaults, but remain
engineered templates rather than sampled handwriting.

## Snapshot Reproducibility

Visual tests use a dedicated Chromium project/worker, wait for fonts and finite
animations, disable transitions and font hinting, and capture only stable empty
and committed states. A full update, visual-only update, then full update kept
these Linux baseline SHA-256 values unchanged:

- Empty portrait: `a05a45e11749124a785ae18ac470e92b41dcd369a35a50b5df458e9abaf4481d`
- Committed five: `c311fea434c610b2a99f103683e7ae790f537ad9c9ffe4c13f3fa0f54f8c5c65`

## Limitation

These paths are fixed engineering fixtures, not sampled physical handwriting.
They overlap with the templates used to establish browser behavior and are not
an independent accuracy set. The `0.95` threshold explicitly favors observed
valid-input usability over invalid-input rejection. Defining representative
data, false-accept limits, an out-of-distribution policy, and a production-safe
automatic-commit threshold remains a product-phase obligation. Passing this
corpus demonstrates deterministic pipeline and interaction behavior only.
Physical iPhone Safari and Android Chrome gates remain open.
