# Handwriting POC Physical Smoke Test

## Status

All checks below are **product-owner tasks pending** on physical iPhone and
Android devices. Run the root command in [README.md](../README.md), use the
printed Network URL, and test in current Safari on iPhone and Chrome on Android.
Do not retain ink: no screenshots or recordings of traces/diagnostic rasters,
exports, or handwriting samples. Record only device/browser details, entered
numeric values, observed behavior, timing impressions, and text descriptions of
failures.

Repeat the checklist once per device/browser:

- [ ] Record device model, OS version, browser/version, and whether the URL is
  plain LAN HTTP. Confirm the recognizer reaches `ready` and drawing is disabled
  while it loads.
- [ ] With the default deck, enter `1`, `2`, `3`, `5`, `8`, and `13` repeatedly.
  Note first-attempt recognition, visible stalls, wrong commits, and whether each
  trace resolves cleanly into the typeset result. Confirm `coffee` is context,
  not a handwriting target.
- [ ] Open `?diagnostics=1`; set the numeric deck to include `0`, missing
  single digits such as `4`, `7`, and `9`, representative two-digit values such
  as `10`, `42`, and `99`, and three-digit values `100`, `128`, and `255`.
  Exercise every listed value and note recognition quality without retaining ink.
- [ ] Write multi-stroke digits. During the inactivity/settling interval, begin
  another stroke and confirm the earlier partial value never commits. Interrupt
  an active stroke by rotating or otherwise causing cancellation; confirm the
  partial stroke is discarded, completed strokes remain, and later input works.
- [ ] Write a confident value absent from the current deck; confirm it waits,
  shakes, clears, and never claims a card. Temporarily raise the diagnostics
  confidence threshold so an otherwise readable sample falls below it; confirm
  it waits and fades without shaking or showing a correction choice.
- [ ] After several successful and rejected attempts, use both **Clear surface**
  and **Clear and try again**. Confirm each returns a fully reusable empty pad.
- [ ] Rotate portrait to landscape and back before, during, and after input.
  Background and resume the browser. Confirm geometry remains usable, stale work
  does not commit, and recognition still works or presents a recoverable error.
- [ ] Enable the OS/browser reduced-motion preference before loading. Confirm
  commit, rejection, and clear remain understandable without full motion.
- [ ] Exercise a loading failure, for example by making the test server
  temporarily unreachable during a fresh uncached load. Confirm an explicit
  error and retry control appear, then restore the server and recover.
- [ ] Record qualitative animation and recognition notes, concrete failing
  numeric examples, and whether the interaction feels responsive. Record no ink,
  raster, image, video, or user handwriting data.

## Pending Owner Result

- [ ] iPhone Safari checklist completed without retained ink.
- [ ] Android Chrome checklist completed without retained ink.
- [ ] Product owner records the qualitative gate result and concrete failure
  categories.
- [ ] Product owner accepts or rejects continued use of this recognizer. This
  decision does not approve the provisional confidence rule for production or
  establish out-of-distribution safety.
