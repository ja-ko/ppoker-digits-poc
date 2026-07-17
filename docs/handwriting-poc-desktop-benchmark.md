# Handwriting POC Desktop Browser Benchmark

## Scope

This report records one automated desktop Chromium run of the POC's existing
diagnostics benchmark against a production Vite build served over local HTTP.
The harness creates a fresh browser profile, waits for cold recognizer readiness,
draws a simple raster, then uses the UI's 10 warmups and 100 measured sequential
runs. Reproduce it from `web-client/` with:

```shell
npm run benchmark:browser
```

Set `CHROME_BIN` when Chromium is installed under another command. Readiness is
observed by polling the page and therefore has roughly 25 ms sampling precision.
Page load is the Navigation Timing `loadEventEnd`; model timing wraps
`session.run`; roundtrip timing covers the main-thread/worker request and result.

## Recorded Run

Measured `2026-07-16T18:54:25.929Z`:

| Item | Result |
| --- | ---: |
| Navigation DOM content loaded | 30.70 ms |
| Navigation load event | 31.20 ms |
| Cold recognizer readiness observed | 297.60 ms |
| Model `session.run` median, 100 runs | 2.60 ms |
| Model `session.run` p95, 100 runs | 3.00 ms |
| Worker roundtrip median, 100 runs | 4.00 ms |
| Worker roundtrip p95, 100 runs | 4.50 ms |

Environment: Linux `7.1.3-arch1-2` x86-64 on an AMD Ryzen 9 9950X,
Chromium `150.0.7871.114` in headless mode with a fresh profile and `390x844`
viewport, Node `26.4.0`, and npm `12.0.0`. The browser reported 32 logical
processors, 32 GiB device memory, and `crossOriginIsolated=false`. The production
build and all recognition assets were served from loopback over plain HTTP.
Cold readiness includes metadata, model, integrity verification, WASM, and ONNX
session initialization; those worker resource phases were not timed separately
in this harness.

This desktop result is engineering evidence only. It is not a phone benchmark,
does not validate touch behavior, and is not an iPhone or Android acceptance
result.
