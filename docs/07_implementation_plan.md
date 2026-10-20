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

- [x] **M2.1 — Compare the patches.** `consistency.py` + `features.py`:
      per-window pairwise coherence across 3–6 ROIs, lag-0 correlations,
      spectral features. A few evenings, as the brief says.
- [x] **M2.2 — Data.** FF++ c23 (real + all four fake methods) → manifests with
      `split_group = source_video_id`. Cache RGB traces.
- [x] **M2.3 — Train.** `model.py`: sklearn Pipeline (scaler → LogReg/SVM),
      `GroupKFold` on the split group. Window votes → majority label.
- [x] **M2.4 — Evaluate.** `eval.py`: accuracy, AUC, precision/recall, confusion
      matrix on a person-disjoint split. Report the false-positive rate on real
      videos separately (BBC lesson).
- **Gate G2:** AUC ≥ 0.70 person-disjoint. Above 0.50 (chance) is the honest
  minimum that says the pulse-consistency signal is real; 0.70 says it's useful.
  - **Status 2026-10-20: FAILED (honestly recorded).** Test AUC **0.5434**
    (95% bootstrap CI over source videos [0.4808, 0.6111]) on **250 usable
    test videos**, accuracy 0.564, **FPR on real videos 0.237** (32 of 135
    reals wrongly flagged). The CI excludes 0.70, so this run fails the gate
    rather than failing to measure it.
  - Test-split reconciliation (all counts read from disk by
    `scripts/audit_test_split.py`): 603 downloaded = 603 in manifest; of the
    259 official test rows, 255 cached (4 refused by the 10 s duration
    gate), 250 usable (5 more excluded: no detectable face → no signal),
    **250 scored** (135 real + 115 fake).
  - **The failure is method-specific, and that is the finding.** Per-method
    AUC against the same reals: **Deepfakes 0.730 [0.620, 0.835]** (the one
    family that replaces the pixels inside the face — and therefore the
    pulse — is detected), FaceSwap 0.595 [0.489, 0.702], Face2Face 0.459
    [0.352, 0.559], NeuralTextures 0.394 [0.290, 0.508]. The geometry
    methods re-enact the expression while preserving the original
    performer's pulse — pulse inheritance (R-06) — which is exactly what a
    blood-flow-consistency detector cannot see.
  - Supporting measurements: on FF++ c23 the three face regions disagree
    by ~8.6 bpm in **both** classes (no pulse to be consistent about,
    R-01 confirmed); a **lossless (raw) probe refutes compression as the
    cause** (`reports/raw_probe_result.md`); the coherence feature was found
    to be a **constant** (single-Welch-segment bug, fixed) and a 15 s window
    was found to **shrink the test set in a label-biased way** (coverage
    guard added).
  - **Phase 2 closes here, as a characterised partial result.** The full
    scientific write-up — verdict, per-method envelope, mechanism, the
    transposed-confusion-matrix disclosure, the reconciliation table, the
    supporting evidence and the reasoning for not proceeding to Phase 3 —
    is **`reports/g2_detector.md`**, the project's central document for the
    Phase-2 result. Read that before quoting any FF++ number.
  - **Phase 3 is not pursued** (human decision, 2026-10-20). Reason: pulse
    inheritance (R-06) means the geometry families leave the performer's
    pulse intact, so there is **no signal to learn** for three of the four
    families; a CNN on PPG maps could only latch onto artifacts (re-encoding,
    resolution — R-14), which cannot honestly be reported as rPPG progress
    and would not survive the cross-dataset exam.

## Phase 3 — FakeCatcher scale (1–2 weeks; the paper's full design)

> **Not pursued** — see the Phase-2 conclusion above. The steps below are
> kept for the record and for the case where the human later decides a
> different feature family is worth a try.

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

- [x] **M4.2a — Gradio app (Phase 4a).** `src/trubeat/app.py` + `trubeat serve
      [--port 7860] [--share]`: upload a video → three-state verdict with its
      evidence (per-region HR, inter-region agreement, `face_valid_frac`, SNR,
      per-ROI waveform plot) and the always-visible operating-envelope caveat.
      The analysis is a pure function (`analyze_video`) separate from the UI,
      so a future extension reuses it; Gradio's built-in API already exposes it
      over HTTP. The app degrades to a pulse/HR analyzer when no detector
      model is installed. See the README's "Run the app" section.
- [x] **M4.2b — Browser extension (Phase 4b).** `extension/`: Chrome MV3,
      vanilla JS, zero build step. Captures the tab via `tabCapture` in an
      offscreen document (MediaRecorder → WebM, max width 1280), refuses
      black/DRM frames instead of uploading them, uploads to the
      user-configured backend over the Gradio API, and overlays the
      three-state verdict in a shadow-DOM panel. It never computes a verdict
      or recalibrates a threshold: it calls the backend's `analyze_video`
      endpoint, which packages the same `analyze_video()` the app uses. No
      telemetry, no storage, no network traffic to anything but the
      configured backend. See `extension/README.md`.
- [ ] **M4.1 — API.** `serve.py`: FastAPI `POST /predict` → FR-12 JSON. Offline
      by default; model weights baked into the Docker image.
- [x] **M4.2 — Demo.** Gradio page: upload video → label + confidence +
      per-window votes + bpm + warnings shown. *(M4.2a above supersedes the
      original sketch: the verdict is three-state with its evidence, not a
      bare label.)*
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
