# 07 — Implementation Plan

Phases map 1:1 onto the brief's build steps. Each phase ends in a gate —
do not start the next phase until the gate is met or consciously waived.

## Phase 0 — Foundations (½ day)

- [ ] `uv venv --python 3.11`, install the pinned stack (doc 03), commit `uv.lock`.
- [ ] Repo skeleton: `src/trubeat/`, `configs/`, `tests/`, `data/` (DVC init), `reports/`.
- [ ] Submit FF++ + Celeb-DF access forms; download UBFC-rPPG.
- [ ] Write the manifest validator (NFR-08) and a synthetic-signal property test
      (72 bpm sine in → 72 ± resolution out) before any real video is touched.
- **Done when:** `pytest` green, UBFC on disk, forms submitted.

## Phase 1 — Heart-rate reader (a weekend; brief steps 1–4)

- [ ] **M1.1 — Video + face.** `ingest.py` + `face.py`. Read true fps; 478
      landmarks per frame; validity mask. (~1 h)
- [ ] **M1.2 — Patches + averages.** `roi.py`. Forehead + both cheeks; plot
      landmark indices on one frame to confirm placement; per-frame mean RGB.
      Start with the forehead (strongest in the 2008 literature). (~1 h)
- [ ] **M1.3 — Clean + read bpm.** `signal.py` + `hr.py`: detrend → SOS
      band-pass 0.7–3.0 Hz → `rfft` peak-pick × 60. Verify against your own
      wrist-counted pulse on a still, well-lit self-recording. Skip CHROM/POS
      until green works. (~1 h)
- [ ] **M1.4 — Validate properly.** Score MAE against UBFC-rPPG ground truth.
      Then run POS/CHROM via the rPPG-Toolbox harness on the same data and
      compare — your hand-rolled numbers should be in the same ballpark.
- **Gate G1:** MAE ≤ 5 bpm on UBFC-rPPG still clips. (Published POS/CHROM
  baselines sit ~1–6 bpm; ≤ 5 is a fair bar for a from-scratch build.)

## Phase 2 — Consistency + classical detector (3–4 evenings; brief steps 5–6)

- [ ] **M2.1 — Compare the patches.** `consistency.py` + `features.py`:
      per-window pairwise coherence across 3–6 ROIs, lag-0 correlations,
      spectral features. A few evenings, as the brief says.
- [ ] **M2.2 — Data.** FF++ c23 (real + all four fake methods) → manifests with
      `split_group = source_video_id`. Cache RGB traces.
- [ ] **M2.3 — Train.** `model.py`: sklearn Pipeline (scaler → LogReg/SVM),
      `GroupKFold` on the split group. Window votes → majority label.
- [ ] **M2.4 — Evaluate.** `eval.py`: accuracy, AUC, precision/recall, confusion
      matrix on a person-disjoint split. Report the false-positive rate on real
      videos separately (BBC lesson).
- **Gate G2:** AUC ≥ 0.70 person-disjoint. Above 0.50 (chance) is the honest
  minimum that says the pulse-consistency signal is real; 0.70 says it's useful.
  - **Status 2026-10-20: FAILED (honestly recorded).** Test AUC **0.474**
    (95% bootstrap CI over source videos [0.281, 0.648]) on 56 usable test
    videos, FPR on real videos 0.75. The diagnosis is measured, not guessed:
    on c23 the three face regions disagree by ~12 bpm in **both** classes —
    there is no single pulse to be consistent about (R-01 confirmed), the
    colour-ratio methods sit at chance while only the raw green channel
    survives, and the inter-ROI coherence feature was found to be a
    *constant* (single-Welch-segment bug, since fixed). The test split is
    also too small to resolve the gate (R-15). Next: mixed compression
    (ADR-06 / R-01) and a larger test split — see `reports/g2_detector.md`.

## Phase 3 — FakeCatcher scale (1–2 weeks; the paper's full design)

- [ ] **M3.1 — 32 ROIs + PPG maps.** Tile the face into 32 sub-regions;
      per region, stack time signal + power spectrum into a 2-D PPG map.
- [ ] **M3.2 — CNN classifier.** PyTorch CNN on PPG maps (small custom net first;
      pretrained backbone only if needed). GPU recommended; CPU overnight runs work.
- [ ] **M3.3 — Mixed-compression training.** Train on raw + c23 (+ c40); verify
      the Intel finding holds: compression-matched training restores accuracy.
- [ ] **M3.4 — Generalization exam.** Evaluate once on Celeb-DF v2 (never trained
      on) + self-made DeepFaceLive fakes (the pulse-inheritance stress test, R-06).
      Report per-dataset, per-quality, per-manipulation-method.
- **Gate G3:** full cross-dataset report with protocol, CIs, and an honest
  comparison against the paper's 96 / 94.65 / 91.5 / 91.07 numbers — expect to
  land below them; above-chance generalization is the real win.

## Phase 4 — Productize (2–3 days)

- [ ] **M4.1 — API.** `serve.py`: FastAPI `POST /predict` → FR-12 JSON. Offline
      by default; model weights baked into the Docker image.
- [ ] **M4.2 — Demo.** Gradio page: upload video → label + confidence +
      per-window votes + bpm + warnings shown.
- [ ] **M4.3 — Container.** Dockerfile (3.11-slim, headless OpenCV), one-command
      `docker run`.
- **Gate G4:** `trubeat predict video.mp4` works end-to-end offline.

## Effort summary

| Phase | Calendar | Depends on |
|-------|----------|------------|
| 0 | ½ day | — |
| 1 | 1 weekend | 0 |
| 2 | 3–4 evenings | G1, FF++ download |
| 3 | 1–2 weeks | G2, GPU (optional) |
| 4 | 2–3 days | G3 |

## Definition of done (every phase)

1. Gate metric met and recorded in `reports/`.
2. `trubeat eval` reproduces the headline numbers in one command.
3. No identity leakage (validator green).
4. Run logged to MLflow with config hash.
