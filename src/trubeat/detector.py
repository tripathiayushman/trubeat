"""Phase-2 detector: cache-backed features, validation tuning, video-level metrics.

Gate G2: person-disjoint AUC ≥ 0.70 on FF++ (docs/08 §G2).

Everything here reads the **trace cache** (`data/processed/traces/*.npz`),
never the raw videos — the cache is the expensive step and re-decoding would
also re-introduce the 1080p memory blow-up (R-13).

Design notes that matter for honesty:
  - The model is trained on **window-level** rows (one row per 10 s window)
    but **scored at the video level**: a video's score is the fraction of its
    windows voted "real". Every reported metric (AUC, accuracy, confusion
    matrix) is video-level, because that is the unit the gate is defined on.
  - Positional columns (`win_start_s`, `win_end_s`) are **excluded** from the
    feature set: they encode where a window sits in a clip, not blood-flow
    physics, and a fake re-encoded from a source video can inherit its
    timing. Excluding them also keeps train/predict column sets identical.
  - The operating threshold is chosen on the **validation** split only. The
    test split is touched exactly once, after everything is frozen.
  - Bootstrap CIs resample **source videos** (`split_group`), not windows,
    because one source video contributes both a real clip and its fakes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupKFold, cross_val_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

from . import features

# Columns that describe *where* a window sits rather than what the pulse
# does. Excluded from the feature set (see module docstring).
POSITIONAL_COLUMNS = ("win_start_s", "win_end_s")

# Feature columns the detector is allowed to use.
DETECTOR_COLUMNS = [
    c for c in features.FEATURE_COLUMNS if c not in POSITIONAL_COLUMNS
]


@dataclass
class VideoScore:
    """One video's detector score + per-window votes."""

    video_id: str
    label: str
    split: str
    split_group: str
    method: str
    score: float  # mean decision value over windows (positive = "real")
    vote_frac_real: float  # fraction of windows voted "real" (secondary)
    n_windows: int
    votes: list[str] = field(default_factory=list)


def load_cached_ppg(cache_dir: Path, video_id: str) -> tuple[np.ndarray, float] | None:
    """Load (ppg (T,R), fps) for one video from the trace cache.

    Returns None when the cache entry is missing or unreadable.
    """
    npz = Path(cache_dir) / f"{video_id}.npz"
    if not npz.is_file():
        return None
    try:
        with np.load(npz) as d:
            ppg = np.asarray(d["ppg"], dtype=float)
            fps = float(d["fps"])
    except (OSError, ValueError, KeyError):
        return None
    if ppg.ndim != 2 or ppg.shape[0] < 2:
        return None
    return ppg, fps


def load_cached_traces(
    cache_dir: Path, video_id: str
) -> tuple[np.ndarray, float] | None:
    """Load the raw ROI mean-RGB traces (T,R,3) + fps from the cache.

    The cache stores the *raw* traces alongside the method-specific ppg, so a
    different rPPG method can be evaluated without re-decoding the video
    (re-decoding re-introduces the 1080p memory blow-up, R-13).
    """
    npz = Path(cache_dir) / f"{video_id}.npz"
    if not npz.is_file():
        return None
    try:
        with np.load(npz) as d:
            traces = np.asarray(d["traces"], dtype=float)
            fps = float(d["fps"])
    except (OSError, ValueError, KeyError):
        return None
    if traces.ndim != 3 or traces.shape[0] < 2:
        return None
    return traces, fps


def ppg_for_method(
    cache_dir: Path, video_id: str, method: str
) -> tuple[np.ndarray, float] | None:
    """(ppg (T,R), fps) for one video under the requested rPPG method.

    Recomputed from the cached raw traces so the cache stays valid for any
    method; falls back to the cached method-specific ppg if the raw traces
    are missing.
    """
    got = load_cached_traces(cache_dir, video_id)
    if got is not None:
        traces, fps = got
        from . import signal

        return signal.extract_ppg(traces, fps, method=method), fps
    return load_cached_ppg(cache_dir, video_id)


def features_from_cache(
    cache_dir: Path,
    video_ids: list[str],
    win_s: float,
    overlap: float,
    method: str = "pos",
) -> pd.DataFrame:
    """Window-level consistency features for the given videos, from cache.

    Returns a DataFrame with one row per window and a `video_id` column.
    """
    parts: list[pd.DataFrame] = []
    for vid in video_ids:
        got = ppg_for_method(cache_dir, vid, method)
        if got is None:
            continue
        ppg, fps = got
        feat = features.window_features(ppg, fps, win_s=win_s, overlap=overlap)
        if len(feat) == 0:
            continue
        feat = feat.copy()
        feat.insert(0, "video_id", vid)
        parts.append(feat)
    if not parts:
        return pd.DataFrame(columns=["video_id", *DETECTOR_COLUMNS])
    return pd.concat(parts, ignore_index=True)


def method_of(video_id: str) -> str:
    """'original' | 'Deepfakes' | 'Face2Face' | 'FaceSwap' | 'NeuralTextures'."""
    parts = video_id.split("_")
    if len(parts) >= 2 and parts[0] == "ffpp":
        return parts[1]
    return "unknown"


def build_classifier(kind: str = "logreg") -> Pipeline:
    """StandardScaler + (LogisticRegression | RBF-SVM) pipeline.

    The SVM deliberately does NOT request `probability=True` (deprecated in
    scikit-learn 1.9): the video score uses `decision_function`, which is
    monotone in probability for the RBF kernel anyway and costs no extra
    calibration pass.
    """
    if kind == "logreg":
        clf = LogisticRegression(max_iter=5000)
    elif kind == "svm_rbf":
        clf = SVC(kernel="rbf", random_state=7)
    else:
        raise ValueError(f"unknown classifier {kind!r}")
    return Pipeline([("scaler", StandardScaler()), ("clf", clf)])


def fit_with_group_cv(
    X: pd.DataFrame, y: np.ndarray, groups: np.ndarray, kind: str = "logreg"
) -> tuple[Pipeline, float, float]:
    """Fit a classifier; report GroupKFold CV AUC (mean, std) for honesty."""
    pipe = build_classifier(kind)
    n_groups = len(np.unique(groups))
    n_splits = min(3, n_groups)
    if n_splits >= 2 and len(np.unique(y)) == 2:
        cv = GroupKFold(n_splits=n_splits)
        scores = cross_val_score(pipe, X, y, groups=groups, cv=cv, scoring="roc_auc")
        auc_mean, auc_std = float(scores.mean()), float(scores.std())
    else:
        auc_mean, auc_std = float("nan"), float("nan")
    pipe.fit(X, y)
    return pipe, auc_mean, auc_std


def score_videos(
    pipe: Pipeline,
    feat: pd.DataFrame,
    manifest: pd.DataFrame,
    columns: list[str] | None = None,
) -> list[VideoScore]:
    """Turn window-level predictions into one score per video.

    The score is the **mean decision value** over the video's windows
    (positive = "real"). A soft score keeps the ranking information that a
    hard vote fraction throws away; the binary decision is made later, at
    the operating threshold tuned on validation.
    """
    cols = columns or DETECTOR_COLUMNS
    meta = manifest.set_index("video_id")
    out: list[VideoScore] = []
    for vid, grp in feat.groupby("video_id", sort=False):
        X = grp[cols]
        pred = pipe.predict(X)
        votes = [
            "real" if str(p).strip().lower() in ("1", "true", "real") else "fake"
            for p in pred
        ]
        real_frac = sum(v == "real" for v in votes) / len(votes)
        if hasattr(pipe, "decision_function"):
            dec = np.asarray(pipe.decision_function(X), dtype=float).ravel()
        else:  # pragma: no cover — all our classifiers expose decision_function
            dec = np.asarray([1.0 if v == "real" else -1.0 for v in votes])
        score = float(np.mean(dec)) if dec.size else 0.0
        row = meta.loc[vid] if vid in meta.index else None
        out.append(
            VideoScore(
                video_id=str(vid),
                label=str(row["label"]) if row is not None else "unknown",
                split=str(row["split"]) if row is not None else "unknown",
                split_group=str(row["split_group"]) if row is not None else str(vid),
                method=method_of(str(vid)),
                score=score,
                vote_frac_real=real_frac,
                n_windows=len(votes),
                votes=votes,
            )
        )
    return out


def tune_threshold(scores: list[VideoScore]) -> float:
    """Pick the operating threshold on validation scores (Youden's J).

    The threshold applies to the video score: score >= threshold -> "real".
    Returns 0.0 when validation has only one class (degenerate).
    """
    y = np.array([s.label == "real" for s in scores], dtype=int)
    x = np.array([s.score for s in scores], dtype=float)
    if len(np.unique(y)) < 2:
        return 0.0
    best_t, best_j = 0.0, -np.inf
    for t in np.unique(x):
        pred = (x >= t).astype(int)
        tpr = float(np.sum((pred == 1) & (y == 1)) / max(np.sum(y == 1), 1))
        fpr = float(np.sum((pred == 1) & (y == 0)) / max(np.sum(y == 0), 1))
        j = tpr - fpr
        if j > best_j:
            best_j, best_t = j, float(t)
    return best_t


def bootstrap_auc_ci(
    scores: list[VideoScore],
    threshold: float,
    n_boot: int = 2000,
    seed: int = 7,
) -> tuple[float, float]:
    """95% percentile bootstrap CI for video-level AUC.

    Resamples *source videos* (split_group) with replacement, keeping each
    group's videos together — a real clip and its fakes must travel together
    or the pairing (and the leakage guarantee) is broken.
    """
    by_group: dict[str, list[VideoScore]] = {}
    for s in scores:
        by_group.setdefault(s.split_group, []).append(s)
    groups = list(by_group)
    if len(groups) < 3:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    aucs = []
    for _ in range(n_boot):
        picked = rng.integers(0, len(groups), len(groups))
        sample: list[VideoScore] = []
        for gi in picked:
            sample.extend(by_group[groups[gi]])
        y = np.array([s.label == "real" for s in sample], dtype=int)
        if len(np.unique(y)) < 2:
            continue
        x = np.array([s.score for s in sample], dtype=float)
        try:
            aucs.append(float(roc_auc_score(y, x)))
        except ValueError:
            continue
    if not aucs:
        return (float("nan"), float("nan"))
    return (float(np.percentile(aucs, 2.5)), float(np.percentile(aucs, 97.5)))


def video_metrics(
    scores: list[VideoScore], threshold: float
) -> dict:
    """Video-level metrics at a given threshold.

    Convention throughout: **positive = "fake"**. The video score is the mean
    decision value (positive = "real"), so a video is called fake when its
    score is *below* the threshold.

    The names below refer to the FAKE class:
      tp = fakes called fake      fn = fakes called real
      fp = **reals called fake**  tn = reals called real
    ``fpr_on_real`` is therefore the fraction of REAL videos wrongly flagged
    as fake — the number that matters (R-07, the BBC lesson) — not the
    fake-class miss rate.
    """
    if not scores:
        return {}
    y = np.array([s.label == "fake" for s in scores], dtype=int)  # 1 = fake
    x = np.array([s.score for s in scores], dtype=float)
    pred = (x < threshold).astype(int)  # 1 = "fake" (score below threshold)
    # sklearn, with 1 = fake:  tn = fake?no/fake?no  fp = fake?no/fake?yes
    #                             fn = fake?yes/fake?no  tp = fake?yes/fake?yes
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    out = {
        "n": len(scores),
        "n_real": int((y == 0).sum()),
        "n_fake": int((y == 1).sum()),
        "accuracy": float(accuracy_score(y, pred)),
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "f1": float(f1_score(y, pred, zero_division=0)),
        # Real videos wrongly flagged as fake — the R-07 headline.
        "fpr_on_real": float(fp / max(fp + tn, 1)),
        "tp": int(tp), "tn": int(tn), "fp": int(fp), "fn": int(fn),
    }
    # AUC: higher score = more "real", so the positive label for ranking
    # is "real" (1 - y).
    out["auc"] = (
        float(roc_auc_score(1 - y, x)) if len(np.unique(y)) == 2 else float("nan")
    )
    out["roc"] = _roc_points(1 - y, x)
    return out


def _roc_points(y: np.ndarray, x: np.ndarray) -> list[list[float]]:
    """Full ROC as [fpr, tpr] pairs — never quote a single operating point."""
    from sklearn.metrics import roc_curve

    if len(np.unique(y)) < 2:
        return []
    fpr, tpr, _ = roc_curve(y, x)
    return [[float(a), float(b)] for a, b in zip(fpr, tpr)]


def per_method_auc(scores: list[VideoScore]) -> list[dict]:
    """AUC of (real vs one manipulation method) over the given scores.

    Each manipulation method is compared against the real videos in the same
    score set — the detector's real task ("is this fake, and how was it
    made?"), one method at a time. A bootstrap CI over source videos is
    included because the per-method fake counts are small.
    """
    reals = [s for s in scores if s.label == "real"]
    out = []
    methods = sorted({s.method for s in scores if s.label == "fake"})
    for m in methods:
        fakes = [s for s in scores if s.label == "fake" and s.method == m]
        subset = reals + fakes
        y = np.array([s.label == "real" for s in subset], dtype=int)
        x = np.array([s.score for s in subset], dtype=float)
        auc = (
            float(roc_auc_score(y, x))
            if len(np.unique(y)) == 2
            else float("nan")
        )
        lo, hi = bootstrap_auc_ci(subset, threshold=0.0, n_boot=2000, seed=7)
        out.append(
            {
                "method": m,
                "n_real": len(reals),
                "n_fake": len(fakes),
                "auc": auc,
                "auc_ci": (lo, hi),
            }
        )
    return out


def hr_quality(scores: list[VideoScore], cache_dir: Path) -> dict:
    """HR-side quality of the scored videos, per class.

    FF++ has **no heart-rate ground truth** (YouTube clips, no oximeter), so
    an MAE cannot be computed here and the UBFC G1 number must NOT be reused
    as a proxy. What *is* computable is the health of the pulse signal
    itself: the in-band peak SNR of the cached traces, per class.
    """
    from .hr import estimate_hr

    per_class: dict[str, list[float]] = {}
    snr_by_class: dict[str, list[float]] = {}
    for s in scores:
        got = load_cached_ppg(cache_dir, s.video_id)
        if got is None:
            continue
        ppg, fps = got
        snrs = []
        for r in range(ppg.shape[1]):
            res = estimate_hr(ppg[:, r], fps, band=(0.7, 3.0))
            if np.isfinite(res.bpm):
                snrs.append(res.confidence)
        if not snrs:
            continue
        per_class.setdefault(s.label, []).append(float(np.mean(snrs)))
        snr_by_class.setdefault(s.label, []).append(s.score)
    return {
        "mean_peak_confidence": {
            k: float(np.mean(v)) for k, v in sorted(per_class.items())
        },
        "n_with_hr": {k: len(v) for k, v in sorted(per_class.items())},
    }


def pulse_visibility(
    cache_dir: Path, video_ids: list[str], method: str = "green"
) -> dict:
    """How visible is the pulse? Per class, on the given videos.

    Two numbers per class:
      - ``roi_hr_agreement_bpm``: standard deviation of the per-ROI heart
        rate estimates. If a pulse is visible, the regions of one face agree
        on the same rate (a few bpm). If the signal is noise, they disagree
        wildly. This is the physical precondition for every consistency
        feature — the FakeCatcher mechanism.
      - ``hr_band_energy_ratio``: in-band (0.7–3 Hz) power over the wide
        band (0.7–14 Hz) — the fraction of the spectrum that could be pulse.

    Compared between classes, this says whether the *physics* is present at
    all, independent of any classifier.
    """
    from .hr import estimate_hr

    agree: dict[str, list[float]] = {}
    ratio: dict[str, list[float]] = {}
    for vid in video_ids:
        got = ppg_for_method(cache_dir, vid, method)
        if got is None:
            continue
        ppg, fps = got
        if ppg.shape[1] < 2:
            continue
        bpms = []
        for r in range(ppg.shape[1]):
            res = estimate_hr(ppg[:, r], fps, band=(0.7, 3.0))
            if np.isfinite(res.bpm):
                bpms.append(res.bpm)
        if len(bpms) < 2:
            continue
        n = ppg.shape[0]
        fr = np.fft.rfftfreq(n, d=1.0 / fps)
        pw = np.abs(
            np.fft.rfft(ppg - np.nanmean(ppg, axis=0, keepdims=True), axis=0)
        ) ** 2
        hr_band = pw[(fr >= 0.7) & (fr <= 3.0)].mean()
        wide = pw[(fr >= 0.7) & (fr <= 14.0)].mean()
        agree.setdefault("all", []).append(float(np.std(bpms)))
        ratio.setdefault("all", []).append(float(hr_band / (wide + 1e-12)))
    if not agree:
        return {}
    return {
        "mean_roi_hr_agreement_bpm": float(np.mean(agree["all"])),
        "median_roi_hr_agreement_bpm": float(np.median(agree["all"])),
        "mean_hr_band_energy_ratio": float(np.mean(ratio["all"])),
        "n": len(agree["all"]),
    }


def dump_json(obj: dict) -> str:
    """JSON-serialise numpy types for the report."""
    def default(o):
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        raise TypeError(f"not serialisable: {type(o)}")

    return json.dumps(obj, indent=1, default=default)
