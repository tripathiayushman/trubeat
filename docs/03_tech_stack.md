# 03 — Tech Stack Recommendation

All choices verified Oct 2026 against the cited papers, the rPPG-Toolbox repo,
and the dataset sources. Free and open-source throughout.

## Recommended stack

| Layer | Choice | Why this | Alternatives considered |
|-------|--------|----------|------------------------|
| Language | **Python 3.11** | Mature scientific stack; MediaPipe wheels are solid on 3.11 | 3.10 fine; avoid 3.12+ until MediaPipe wheels catch up |
| Env & deps | **uv** + venv, `uv.lock` committed | Fast, reproducible, one lockfile | pip+venv (slower), conda (heavy) |
| Video I/O | **OpenCV** `VideoCapture` (P1–P2); **PyAV** (P3+) | The brief's path; PyAV adds frame-exact, thread-safe decode for dataset batches | ffmpeg CLI probing as a supplement |
| Face landmarks | **MediaPipe Face Landmarker** (`mediapipe` tasks-vision) | 478 landmarks, CPU real-time, actively maintained | Legacy FaceMesh solution (deprecated path), RetinaFace (heavier, needs its own weights), OpenCV DNN face detector (no landmarks) |
| Signal math | **NumPy + SciPy** | detrend, butter/SOS, sosfiltfilt, coherence, welch, rfft — everything in one place | — |
| rPPG methods | **rPPG-Toolbox** harness (NeurIPS 2023, ubicomplab) | Reference benchmark suite: GREEN/ICA/CHROM/LGI/PBV/POS/OMIT unsupervised + PhysNet/DeepPhys/TS-CAN/PhysFormer/EfficientPhys/BigSmall with **pretrained checkpoints in the repo**; UBFC/PURE loaders included | Hand-rolled green-mean (keep as the P1 learning baseline — the brief's weekend path), vitallens-python (MIT-licensed local pos/chrom — good correctness reference), **pyVHR is GPL-3.0: read-only reference, never a dependency** |
| Classical ML | **scikit-learn** | LogisticRegression / SVC / GroupKFold / Pipeline — exactly the brief's step 6 | — |
| Deep learning (P3) | **PyTorch** | rPPG-Toolbox models + the PPG-map CNN are PyTorch-native | — |
| Experiment tracking | **MLflow** (local file store) + **DVC** | No account needed; DVC versions the datasets | W&B (needs account), bare CSV logs (doesn't scale) |
| API (P4) | **FastAPI** + uvicorn | Typed, fast, trivial to containerize | Flask |
| Demo UI (P4) | **Gradio** | Fastest path to a video-upload demo page | Streamlit |
| Container (P4) | **Docker** | Reproducible service image | — |
| Tests & lint | **pytest**, **ruff** | — | — |
| Plots | **matplotlib** | Signal traces, spectra, Bland-Altman, ROC | — |

## Architecture Decision Records (short form)

- **ADR-01 — Face Landmarker over legacy FaceMesh.** Same 478-point topology,
  maintained API, GPU delegate optional. Pin `mediapipe==0.10.x`.
- **ADR-02 — rPPG-Toolbox as the baseline harness.** Its published UBFC-rPPG
  numbers (POS ≈ 3–4 bpm MAE in their harness) beat any first hand-rolled
  attempt; use it to validate your own pipeline's output, not just to copy it.
- **ADR-03 — POS as the primary unsupervised method.** Designed to suppress
  illumination variation; degrades more gracefully than green-mean on real-world
  video. Keep green-mean as the sanity baseline — on UBFC-rPPG's perfectly
  stable lighting, green can *outperform* CHROM/POS. That reversal is expected
  physics, not a bug.
- **ADR-04 — Classical classifier before CNN.** The brief is right: logistic
  regression / SVM on coherence features is enough for Phase 2 signal. The CNN
  on PPG maps is a Phase 3 scale-up, not a starting point.
- **ADR-05 — Local-first, no cloud.** Privacy (faces are biometric data) and
  cost. The inference path makes zero network calls.
- **ADR-06 — Train on mixed compression.** Intel's own finding: training only
  on clean video then testing on compressed video drops accuracy; adding
  compressed video to training restores it. FF++ ships raw / c23 / c40 for
  exactly this reason.

## Pinned starting environment

```bash
uv venv --python 3.11 && source .venv/bin/activate
uv pip install "numpy<2.0" opencv-python==4.9.0.80 mediapipe==0.10.21 \
  scipy scikit-learn matplotlib mlflow dvc fastapi "uvicorn[standard]" gradio
# Phase 3 adds: torch (per pytorch.org for your platform)
```

**Quirks captured so you don't rediscover them:**
- `numpy` must stay **< 2.0** with `mediapipe 0.10.21` (its own metadata pins it;
  pip resolved 1.26.4 on a clean install — verified Oct 2026). Python may be
  **3.11 or 3.12** — 0.10.21 ships cp312 wheels.
- Use `opencv-python-headless` inside Docker; full `opencv-python` on the dev
  machine only if you want `imshow` debugging.
- Verify the rPPG-Toolbox repo license before vendoring any of its code; treat
  it as a harness you run, not code you copy, until checked.

## Hardware

- Phases 1–2: any 4-core laptop, 16 GB RAM recommended, ~120 GB free disk (UBFC alone is ~60 GB uncompressed).
- Phase 3 (CNN training): a CUDA GPU helps; CPU training on the FF++ c23
  subset is possible but slow — budget overnight runs.
- Optional: any webcam for live self-tests against a finger pulse oximeter or
  phone HR app.
