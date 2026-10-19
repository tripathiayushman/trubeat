# Trace-cache QC — 2026-10-19 23:55

## Setup

- manifest: `data/manifests/ffpp_c23.csv`
- trace cache: `data/processed/traces`
- method: pos (cache key includes ROI set + method + frame height)

## Totals

- manifest rows: **400**
- cached: **384**
- missing cache: **16**
- **usable: 371** (92.8%)
- excluded: **29**

## Aggregate QC (cached videos)

- mean `face_valid_frac`: **0.9667**
- median `face_valid_frac`: 1.0000
- min `face_valid_frac`: 0.0000
- mean `mean_snr`: **32.81**
- median `mean_snr`: 32.12
- min / max `mean_snr`: 0.00 / 98.06

### Exclusions by reason

| reason | n |
|--------|---|
| MISSING_CACHE | 16 |
| NO_FACE | 11 |
| NO_SIGNAL | 11 |
| UNSTABLE_TRACK | 2 |

### Excluded videos

| video_id | label | split | reason |
|---|---|---|---|
| ffpp_original_033 | real | train | UNSTABLE_TRACK |
| ffpp_original_096 | real | train | NO_FACE;NO_SIGNAL |
| ffpp_original_192 | real | val | MISSING_CACHE |
| ffpp_original_221 | real | train | NO_FACE;NO_SIGNAL |
| ffpp_original_241 | real | train | MISSING_CACHE |
| ffpp_original_254 | real | val | NO_FACE;NO_SIGNAL |
| ffpp_original_456 | real | train | NO_FACE;NO_SIGNAL |
| ffpp_original_648 | real | train | NO_FACE;NO_SIGNAL |
| ffpp_original_664 | real | val | MISSING_CACHE |
| ffpp_original_817 | real | val | NO_FACE;NO_SIGNAL |
| ffpp_original_891 | real | train | MISSING_CACHE |
| ffpp_Deepfakes_033_097 | fake | train | NO_FACE;NO_SIGNAL |
| ffpp_Deepfakes_192_134 | fake | val | MISSING_CACHE |
| ffpp_Deepfakes_241_210 | fake | train | MISSING_CACHE |
| ffpp_Face2Face_033_097 | fake | train | NO_FACE;NO_SIGNAL |
| ffpp_Face2Face_134_192 | fake | val | MISSING_CACHE |
| ffpp_Face2Face_210_241 | fake | train | MISSING_CACHE |
| ffpp_Face2Face_648_654 | fake | train | NO_FACE;NO_SIGNAL |
| ffpp_FaceSwap_033_097 | fake | train | NO_FACE;NO_SIGNAL |
| ffpp_FaceSwap_134_192 | fake | val | MISSING_CACHE |
| ffpp_FaceSwap_192_134 | fake | val | MISSING_CACHE |
| ffpp_FaceSwap_210_241 | fake | train | MISSING_CACHE |
| ffpp_FaceSwap_241_210 | fake | train | MISSING_CACHE |
| ffpp_NeuralTextures_033_097 | fake | train | UNSTABLE_TRACK |
| ffpp_NeuralTextures_134_192 | fake | val | MISSING_CACHE |
| ffpp_NeuralTextures_192_134 | fake | val | MISSING_CACHE |
| ffpp_NeuralTextures_210_241 | fake | train | MISSING_CACHE |
| ffpp_NeuralTextures_241_210 | fake | train | MISSING_CACHE |
| ffpp_NeuralTextures_648_654 | fake | train | NO_FACE;NO_SIGNAL |

## Usable by label

| label | n |
|---|---|
| fake | 182 |
| real | 189 |

## Honesty checklist

- [x] every cached video has QC (face_valid_frac, mean_snr)
- [x] unusable videos are excluded with a recorded reason
- [x] no silent drops
- [ ] class balance re-checked after exclusions (see above)
