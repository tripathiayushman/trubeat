"""Classifier training + single-video prediction. FR-11, FR-12."""

from collections import Counter
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold, cross_val_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from . import face, features, hr, ingest, roi, signal
from .errors import NoFace


@dataclass
class Prediction:
    label: str  # "real" | "fake"
    confidence: float
    n_windows: int
    votes: list[str] = field(default_factory=list)
    hr_bpm: float | None = None
    warnings: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "label": self.label,
            "confidence": self.confidence,
            "n_windows": self.n_windows,
            "votes": self.votes,
            "hr_bpm": self.hr_bpm,
            "warnings": self.warnings,
        }


def _to_label(value) -> str:
    """Normalise a classifier vote to "real" | "fake".

    Accepts string labels ("real"/"fake") or 0/1-style encodings
    (1/True == "real", 0/False == "fake"). Anything else passes through
    as str(value).
    """
    s = str(value).strip().lower()
    if s in ("1", "1.0", "true", "real"):
        return "real"
    if s in ("0", "0.0", "false", "fake"):
        return "fake"
    return str(value)


def train_classifier(X: pd.DataFrame, y: np.ndarray, groups: np.ndarray) -> Pipeline:
    """Fit Pipeline(StandardScaler, LogisticRegression) with GroupKFold CV.

    groups = split_group from the manifest (subject / source video).
    NEVER train without groups — random splits leak identity (R-04).
    Runs GroupKFold(n_splits=3) CV (ROC AUC) for an honest estimate, prints
    mean ± std, then refits on the full data and returns the fitted pipeline.
    Phase 3: swap in the PyTorch CNN on PPG maps (same interface).
    """
    pipe = Pipeline(
        [
            ("scaler", StandardScaler()),
            ("clf", LogisticRegression(max_iter=2000)),
        ]
    )
    cv = GroupKFold(n_splits=3)
    scores = cross_val_score(pipe, X, y, groups=groups, cv=cv, scoring="roc_auc")
    print(
        f"[train_classifier] GroupKFold(n_splits=3) CV AUC: "
        f"{scores.mean():.4f} ± {scores.std():.4f} (n={len(X)})"
    )
    pipe.fit(X, y)
    return pipe


def predict_video(path: str, model, config: dict) -> Prediction:
    """Full pipeline on one video → label + per-window votes. Majority wins.

    Wires ingest → face → roi → signal → features per the frozen interfaces
    (docs/04 §4), predicts every window with `model`, majority vote wins.
    Confidence is the winning vote fraction. hr_bpm comes from the forehead
    ROI (column 0 of the ppg matrix).
    """
    warnings: list[str] = []
    band = tuple(config.get("band", (0.7, 3.0)))
    method = config.get("method", "pos")

    stream = ingest.open_video(
        path, frame_height=config.get("frame_height", ingest.DEFAULT_FRAME_HEIGHT)
    )
    landmarks, valid = face.track_landmarks(stream.frames, stream.fps)
    if not np.any(valid):
        # No face in any frame: nothing to analyze. Surface the designed
        # error code rather than crashing later on NaN features (AGENTS.md §5).
        raise NoFace(f"no face tracked in any frame: {path}")
    if float(np.mean(valid)) < 0.7:
        warnings.append("W_UNSTABLE_TRACK: face tracked in <70% of frames")
    traces = roi.extract_roi_means(
        stream.frames, landmarks, valid, config.get("roi_defs", roi.ROI_DEFS_P1)
    )
    ppg = signal.extract_ppg(traces, stream.fps, method=method)
    feat = features.window_features(
        ppg,
        stream.fps,
        win_s=config.get("window_s", 10.0),
        overlap=config.get("overlap", 0.5),
    )
    if len(feat) == 0:
        raise ValueError(f"no analysis windows produced for video {path!r}")

    votes = [_to_label(v) for v in model.predict(feat)]
    label, n_win = Counter(votes).most_common(1)[0]
    confidence = n_win / len(votes)

    hr_res = hr.estimate_hr(ppg[:, 0], stream.fps, band=band)
    return Prediction(
        label=label,
        confidence=float(confidence),
        n_windows=len(votes),
        votes=votes,
        hr_bpm=float(hr_res.bpm),
        warnings=warnings,
    )
