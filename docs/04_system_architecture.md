# 04 — System Architecture

## 1. Context

```
                    +-------------------+
                    |   Video file      |
                    | (mp4/mov/avi/mkv) |
                    +--------+----------+
                             |
                    +--------v----------+
                    |    TrueBeat      |
                    |    pipeline       |
                    +--------+----------+
                             |
            +----------------+----------------+
            |                                 |
   {label, confidence,               {metrics, plots,
    per-window votes,                  run report}
    hr_bpm, warnings}
```

Single-machine, offline-first. No component calls the network during inference.

## 2. Component architecture

```
+----------+   +-------------+   +--------------+   +-------------------+
|  Ingest  |-->| FaceTracker |-->| ROIExtractor |-->| SignalConditioner |
| ingest.py|   |  face.py    |   |    roi.py    |   |    signal.py      |
+----------+   +-------------+   +--------------+   +---------+---------+
                                                              |
                       +------------+   +---------------------+------------------+
                       | HREstimator|   | ConsistencyAnalyzer |  FeatureBuilder  |
                       |   hr.py    |   |   consistency.py    |   features.py    |
                       +-----+------+   +---------+-----------+   +-------+--------+
                             |                    |                       |
                             +----------+---------+-----------+-----------+
                                        |
                              +---------v---------+
                              |    Classifier     |
                              |     model.py      |
                              | LogReg/SVM (P2)   |
                              | CNN on PPG maps   |
                              |       (P3)        |
                              +---------+---------+
                                        |
                        +---------------+---------------+
                        |                               |
                 +------v------+                 +------v------+
                 |  Evaluator  |                 |  Serve (P4) |
                 |   eval.py   |                 |  app.py     |
                 +-------------+                 +-------------+
```

The Phase-4a web app (`app.py`) sits on top of the *same* pipeline the CLI
uses — it does not reimplement any stage. Its analysis half
(`analyze_video`) is a pure function returning a `PulseAnalysis`
(three-state verdict + per-region heart rate, inter-region agreement,
`face_valid_frac`, SNR, ROI waveforms), and the interface half
(`build_demo`) is Gradio wiring. A browser extension can therefore reuse
`analyze_video` — over Gradio's built-in API or a purpose-built one —
without a second implementation.

## 3. Data flow (the pipeline, end to end)

1. **Ingest.** `open_video(path)` → frames `uint8 (T,H,W,3)`, plus `fps`
   (from container — never assumed), `n_frames`, duration. Gate: duration ≥ 10 s,
   fps ≥ 15, else `E_SHORT_VIDEO` / `E_LOW_FPS`. Videos taller than
   `frame_height` (default 480) are downscaled with the aspect ratio preserved
   and never upscaled — a 1920×1080 clip of ~900 frames is 5.8 GB decoded and
   OOM-kills the process on a small machine. `MAX_DECODED_BYTES` (2.5 GB)
   raises `E_UNREADABLE` rather than letting the kernel kill the process.
2. **FaceTracker.** MediaPipe Face Landmarker per frame → `landmarks (T,478,2)`,
   `valid (T,)` bool mask. Lost track → re-detect; if valid < 70% of frames,
   warn `W_UNSTABLE_TRACK`.
3. **ROIExtractor.** Landmark polygons → per-frame mean RGB per ROI →
   `traces (T,R,3)` float. P1–2: R = 3–6 (forehead, cheeks, …). P3: R = 32
   sub-regions tiled over the face (FakeCatcher layout).
4. **SignalConditioner.** Per ROI, per channel: `detrend` → SOS band-pass
   (`butter`, `sosfiltfilt`, zero-phase) → `extract_ppg(method)` with
   method ∈ {green, chrom, pos} → `ppg (T,R)`.
5. **HREstimator** (parallel branch). Window the forehead/mean-face PPG,
   `rfft` → strongest bin in 0.7–3.0 Hz → `bpm = f*60`, plus peak SNR.
6. **ConsistencyAnalyzer** (parallel branch). Sliding windows (default 10 s,
   50% overlap): pairwise magnitude-squared coherence between all ROI pairs
   (`scipy.signal.coherence`), cross-correlation at lag 0.
7. **FeatureBuilder.** Per window → feature vector: coherence mean/std/min,
   lag-0 correlation stats, spectral entropy, dominant-peak sharpness,
   per-ROI SNR. P3 also builds **PPG maps**: for each of the 32 regions, the
   time-domain signal and its power spectrum stacked into one 2-D map —
   the CNN input from the FakeCatcher paper.
8. **Classifier.** P2: sklearn `Pipeline(StandardScaler, LogisticRegression|SVC)`
   trained with `GroupKFold` grouped by subject/source video. P3: PyTorch CNN
   on PPG maps. Inference: each window votes; majority wins.
9. **Evaluator / Serve.** Batch scoring vs. manifests (eval), or single-video
   JSON + demo UI (serve).

## 4. Module interfaces

```python
# ingest.py
def open_video(path: str, frame_height: int | None = DEFAULT_FRAME_HEIGHT) -> VideoStream
    # frames, fps, n_frames, w, h, duration_s
    # frame_height caps the decoded frame height (aspect preserved, never
    # upscaled); None keeps native resolution.

# face.py
def track_landmarks(frames: np.ndarray, fps: float) -> tuple[np.ndarray, np.ndarray]
    # -> landmarks (T,478,2) float32, valid (T,) bool

# roi.py
ROI_DEFS_P1 = {"forehead": [...], "cheek_l": [...], "cheek_r": [...]}  # landmark idx lists
def extract_roi_means(frames, landmarks, valid, roi_defs) -> np.ndarray  # (T,R,3)

# signal.py
def condition(trace: np.ndarray, fps: float, band=(0.7, 3.0)) -> np.ndarray
def extract_ppg(traces: np.ndarray, fps: float, method="pos") -> np.ndarray  # (T,R)

# hr.py
@dataclass
class HRResult: bpm: float; confidence: float; spectrum: np.ndarray; freqs: np.ndarray
def estimate_hr(ppg: np.ndarray, fps: float, band=(0.7, 3.0)) -> HRResult

# consistency.py
def coherence_features(ppg_win: np.ndarray, fps: float) -> dict  # pairwise mscohere stats
def lag0_correlation(ppg_win: np.ndarray) -> dict

# features.py
def window_features(ppg: np.ndarray, fps: float, win_s=10.0, overlap=0.5) -> pd.DataFrame
def build_ppg_maps(ppg: np.ndarray, fps: float) -> np.ndarray  # (R, F, T)  Phase 3

# model.py
def train_classifier(X, y, groups) -> Pipeline  # GroupKFold CV inside
def predict_video(path: str, model) -> Prediction  # label, confidence, votes[], hr, warnings

# eval.py
def evaluate_hr(manifest) -> HRReport      # MAE, RMSE, Pearson, Bland-Altman
def evaluate_detector(manifest, model) -> DetectionReport  # acc, AUC, PR, confusion
```

## 5. Key design numbers

- **Frequency resolution:** a 10 s window at 30 fps = 300 samples → 0.1 Hz bins →
  **6 bpm steps**. A 30 s window → ~0.033 Hz → **2 bpm steps**. Use 10 s sliding
  windows for detection votes, 30 s windows when reporting a heart-rate number.
- **Bands:** 0.7–3.0 Hz = 42–180 bpm (HR work); 0.7–14 Hz for the detector —
  FakeCatcher deliberately keeps the above-pulse residual because it carries
  fake-vs-real signal.
- **Windowing:** 10 s windows, 50% overlap → a 60 s clip yields 11 votes.
- **Splits:** `GroupKFold` on `split_group` (= subject for UBFC, source-video for
  FF++ real/fake pairs). A manifest validator asserts no group crosses the split.

## 6. Storage layout

```
trubeat/
  src/trubeat/{ingest,face,roi,signal,hr,consistency,features,model,eval,serve}.py
  configs/{p1_hr.yaml, p2_detector.yaml, p3_cnn.yaml}
  data/
    raw/{ubfc_rppg, ffpp_c23, celebdf_v2}/   # DVC-tracked, never in git
    processed/traces/<dataset>/              # cached (T,R,3) traces, content-hashed
    manifests/*.csv
  runs/            # MLflow file store
  reports/         # eval reports (md + png)
  tests/
```

## 7. Deployment views

- **Phases 1–3 (dev):** laptop, `uv run trubeat …`, MLflow local, DVC local.
- **Phase 4 (service):** Docker image (`python:3.11-slim`, headless OpenCV,
  model weights baked in) → `uvicorn serve:app`; Gradio demo on the same host.
  Still offline-capable: no external calls in the request path.

## 8. Error taxonomy

| Code | Meaning | Behavior |
|------|---------|----------|
| `E_UNREADABLE` | file won't decode | abort with message |
| `E_LOW_FPS` | fps missing or < 15 | abort — bpm math is invalid |
| `E_SHORT_VIDEO` | < 10 s usable | abort — frequency resolution meaningless |
| `E_NO_FACE` | face found in < 70% of frames | abort |
| `W_UNSTABLE_TRACK` | intermittent tracking | continue, flag in output |
| `W_LOW_CONFIDENCE` | weak spectral peak / low vote margin | continue, flag in output |

## 9. Design principles

1. **Config-driven, not hard-coded.** Bands, windows, ROI sets, methods all live
   in YAML; every report records the config hash.
2. **One stage, one module, one test file.** Signal math gets property tests
   (e.g., a synthetic 72 bpm sine must read 72 ± resolution).
3. **Cache the expensive step.** RGB trace extraction dominates runtime; cache
   by content hash and never recompute silently.
4. **Honest outputs.** Every prediction carries confidence and warnings; every
   evaluation carries its split protocol. No bare accuracy numbers.
