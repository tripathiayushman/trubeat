# Lossless probe — does the pulse return at raw quality? (2026-10-20)

**Question.** G2 failed on FF++ **c23** (test AUC 0.474). The working
hypothesis was R-01/ADR-06: heavy compression destroys the pulse, so the
inter-ROI consistency mechanism has nothing to measure. If that is true, a
**lossless (raw)** copy of the same source videos should bring the pulse
back — and the mechanism with it.

**Answer: NO. The hypothesis is refuted.**

## Setup

- 80 lossless FF++ videos (40 original + 20 Deepfakes + 20 Face2Face) — the
  *same source videos* as the c23 set, downloaded from the same server at
  `-c raw` (raw ≈ 94 MB/video vs 1.7 MB for c23; ~6.4 GB total).
- Cached into a **separate** cache directory (`data/processed/traces_raw`)
  because the cache key includes the video bytes and the raw/c23 clips share
  video ids.
- Measured on **train+val only** (never test).
- Metric: the spread of the per-ROI heart-rate estimates within one face.
  A visible pulse means the regions agree on one rate; noise means they
  disagree. Full-clip estimation (best available FFT resolution).

## Result

| set | class | n | ROI-HR spread (bpm) | HR-band energy ratio |
|-----|-------|---|----------------------|----------------------|
| c23 | real | 157 | 8.6 (median 7.4) | 4.50 |
| c23 | fake | 158 | 8.5 (median 7.4) | 4.29 |
| **raw** | **real** | **31** | **6.9 (median 5.1)** | **4.40** |
| **raw** | **fake** | **19** | **6.6 (median 6.5)** | **4.09** |

Same measurement with the POS method (full-clip HR estimates):

| set | real | fake |
|-----|------|------|
| c23 | 10.8 | 11.0 |
| raw | 10.4 | 15.2 |

## Reading

1. **Lossless quality tightens the spread for BOTH classes** (c23 → raw:
   real 8.6 → 6.9, fake 8.5 → 6.6) — a small, real improvement in pulse
   visibility, and it is *not* class-specific.
2. **The class gap stays at zero.** c23: real 8.6 vs fake 8.5. raw: real
   6.9 vs fake 6.6. There is no separation to exploit.
3. The raw+POS numbers (real 10.4 vs fake 15.2) hint at a wider spread for
   fakes, but **n=19 fakes** — that is far too small to conclude anything
   from, and POS is the worse method everywhere else. Not a finding.

## Conclusion

**Mixed compression is not the fix.** ADR-06's prescription ("train on raw
+ c23 + c40") was our best hypothesis and the data refutes it for *this*
signal: at lossless quality the pulse is no more separable than it is at
c23. The limit is not compression.

What the limit actually is, based on everything measured:

- FF++ clips are short (median 16.5 s) YouTube footage of people talking:
  small faces, studio lighting, motion, and re-encoding.
- The rPPG estimate per ROI is coarse at this length (a 16 s clip gives
  ~3.7 bpm FFT bins), so a per-ROI spread of 5–8 bpm is only weakly
  diagnostic even when a pulse is present.
- On UBFC (still subjects, fixed camera, lossless) the same pipeline reads
  heart rates to ~1 bpm and the regions agree tightly. The pipeline is not
  the problem; the FF++ material is.

## Consequences for the plan

- **G2 stays FAILED** — and the honest reason is now sharper: not
  "c23 compressed the pulse away", but "the inter-ROI consistency signal
  does not separate real from fake on FF++ footage at any available
  quality".
- **Mixed-compression training (M3.3) is demoted** from "the fix" to "a
  robustness check for the final model", unless a different feature family
  shows a compression-dependent gap.
- The next lever is a **different signal**, not a better-tuned one:
  Phase 3's per-region PPG maps (32 sub-regions, time signal + spectrum
  texture) give the CNN far more to look at than three ROI means — and
  R-06 (pulse-inheriting fakes) already warns that a global HR feature
  cannot catch the strongest fakes.
- **Enlarge the test split** regardless (R-15): 56 usable test videos give
  a ±0.27 CI around the AUC. Any future gate verdict needs a test set that
  can resolve it.

## Reproduce

```bash
.venv/bin/python scripts/build_raw_manifest.py --out data/manifests/ffpp_raw_probe.csv
.venv/bin/python scripts/cache_traces.py --manifest data/manifests/ffpp_raw_probe.csv \
    --out-dir data/processed/traces_raw --method pos --resume
.venv/bin/python scripts/compare_pulse_visibility.py \
    --manifest-a data/manifests/ffpp_c23_qc.csv --cache-a data/processed/traces \
    --manifest-b data/manifests/ffpp_raw_probe.csv --cache-b data/processed/traces_raw \
    --method green
```
