# Spike result

Status: public-fixture mechanics completed with a quality FAIL; awaiting execution on real June
`system.wav` recordings.

Public fixture run on 2026-07-09 (`pnpm persona:spike -- --smoke`):

- `sherpa-onnx` 1.13.4, CPU provider;
- segmentation model: 5,992,913 bytes;
- embedding model: 26,530,550 bytes;
- four cross-recording genuine pairs: 0.1714 to 0.9191;
- sixteen cross-recording impostor pairs: 0.3192 to 0.8405;
- per-file real-time factor: 0.026 to 0.041 on Apple Silicon;
- the locked dependency graph passes `cargo +1.80.0 check --locked`;
- the 48 kHz anti-alias smoke preserved a 1 kHz tone at 0.7071 RMS and
  suppressed a 12 kHz tone to 0.0012 RMS before 16 kHz resampling;
- one 2.98-second single-speaker clip fragmented into a second 0.30-second
  anonymous cluster.

The hardened harness returned FAIL because that fragment split one known
identity across two clusters; its low-speech embedding also overlaps the
impostor distribution. This is a useful mechanics result over clean public
clips, not the PRD quality gate and not a production threshold. The next run
must use compressed June System source recordings from different
meetings/devices and the operator must listen for mixed or fragmented clusters.

Do not advance the production implementation from this placeholder. Phase 1
stays gated until real recordings show a clean enough score separation and the
diarized listening WAVs are not materially mixed or fragmented.
