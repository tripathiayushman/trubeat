# 05 — Data Strategy

## 1. Datasets

| Dataset | Role | Contents | Access | Size note |
|---------|------|----------|--------|-----------|
| **UBFC-rPPG** | Phase 1 heart-rate validation | 42 subjects, 640×480 @ ~30 fps, ~60 s each, **uncompressed** 8-bit RGB; CMS50E finger pulse-oximeter ground truth (`ground_truth.txt`: PPG waveform, per-frame HR, timestamps) | Official Google Sites page, Drive folder behind it — Drive **rate-limits** the 42 `vid.avi` files hard (quota lockout on first pull, 2026-10-18); working route: HuggingFace mirror **`thachha901/UBFC`** (ungated, byte-identical LFS sizes vs official; `snapshot_download("thachha901/UBFC")` → `data/raw/ubfc_mirror/UBFC/subjectN/` → flatten into `data/raw/ubfc_rppg/subjectXX/`); Kaggle mirrors exist but are re-encoded (a few GB) and lose pulse fidelity | **~60 GB uncompressed** (42 × ~1.4 GB). Start here |
| **FaceForensics++ (c23)** | Phase 2–3 detector training | 1,000 real YouTube videos (720/140/140 train/val/test) + 4 manipulation methods (DeepFakes, Face2Face, FaceSwap, NeuralTextures); qualities: raw / c23 / c40 | Academic request **form** required | Full raw is hundreds of GB — download **c23** only, real + all four fake methods |
| **Celeb-DF v2** | Held-out cross-dataset test (Phase 3) | 590 real / 5,639 fake celebrity videos | Request form | Never train on it — it is the generalization exam |
| **Self-made fakes** | Pulse-inheritance stress test (Phase 3) | Your own footage → face-swap with DeepFaceLive or similar | You create it | Directly tests the 2025 finding: does your detector catch fakes that *inherited* the real pulse? |
| PURE / MMPD (optional) | Robustness | Motion and illumination variety | Request forms | Only if Phase 2 saturates |

## 2. Access plan (do this in Phase 0)

1. Submit the FF++ and Celeb-DF forms on day one — approvals take days.
2. Pull UBFC-rPPG immediately (fastest win; unblocks all of Phase 1).
3. If Drive throttles UBFC, use a Kaggle mirror rather than retrying for a week.
4. **License/compliance note:** UBFC-rPPG terms forbid showing subjects **21 and
   27** in any publication, presentation, or report. Honor dataset licenses;
   faces are biometric data — treat the raw videos accordingly.

## 3. Storage & versioning

```
data/
  raw/ubfc_rppg/subject{N}/vid.avi + ground_truth.txt
  raw/ffpp_c23/{real,fake_df,fake_f2f,fake_fs,fake_nt}/*.mp4
  raw/celebdf_v2/...
  processed/traces/<dataset>/<content_hash>.npy   # cached (T,R,3) traces
  manifests/ubfc.csv, manifests/ffpp_train.csv, manifests/ffpp_test.csv, ...
```

- `data/` is **DVC-tracked**; only `.dvc` pointer files go in git.
- Raw face videos are **never** committed to git, never uploaded anywhere.
- Trace caches are keyed by hash of (video bytes + ROI definition + method) —
  changing the ROI set invalidates the cache automatically.

## 4. Manifest schema

`video_id, subject_id, source_video_id, label, split_group, dataset, quality, fps, duration_s, path`

- `split_group`: UBFC → `subject_id`; FF++ → `source_video_id` (keeps each
  real video and its four fakes on the same side of the split).
- `quality`: raw / c23 / c40 — needed for the mixed-compression training plan.

## 5. Split protocol (the rule that protects you from fooling yourself)

- **Never random-split.** Always `GroupKFold` / group holdout on `split_group`.
- A manifest validator runs before every training job and **fails the run** if
  any group appears on both sides.
- FF++: respect the official 720/140/140 video split; group by source video
  within it.
- Final exam: a dataset the model never saw (Celeb-DF v2 and/or self-made
  fakes), evaluated once, reported with the protocol attached.

## 6. Preprocessing pipeline

```
raw video → open_video → track_landmarks → extract_roi_means → (T,R,3) trace
→ cache to processed/traces/ → condition → ppg (T,R) → windows → features
```

- Trace extraction is the expensive step (~minutes per video on CPU) — hence the cache.
- Everything downstream of the cache re-runs in seconds, so method/band/window
  experiments stay cheap.
- Record per-video QC in the manifest: `face_valid_frac`, `mean_snr`, notes.

## 7. A note on UBFC-rPPG physics

UBFC was recorded in stable indoor light with a fixed camera and still subjects.
On this dataset, plain **green-mean can outperform CHROM/POS** — the color-ratio
methods are designed to suppress illumination variation that UBFC barely has.
Expect this reversal; it does **not** mean green-mean is the better method for
real-world video. Validate method choice on PURE/MMPD-style varied data before
concluding anything.
