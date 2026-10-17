"""Batch evaluation + run reports. FR-13, FR-14."""

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

from . import face, hr, ingest, roi, signal
from .errors import NoFace
from .model import _to_label, predict_video


@dataclass
class HRReport:
    mae: float
    rmse: float
    pearson_r: float
    per_subject: pd.DataFrame


@dataclass
class DetectionReport:
    accuracy: float
    auc: float
    precision: float
    recall: float
    fpr_on_real: float  # headline metric — the BBC lesson
    # Additive extensions (fields above are frozen):
    confusion: dict = field(default_factory=dict)  # {"tp","tn","fp","fn"}, "fake" = positive
    ci: dict = field(default_factory=dict)  # bootstrap CIs, e.g. {"accuracy": (lo, hi)}
    n: int = 0


_VALID_SPLITS = {"train", "val", "test"}


def validate_manifest(manifest: pd.DataFrame) -> None:
    """Fail fast on bad splits or identity leakage (NFR-08).

    Requires a 'split' column with values in {train, val, test} and asserts
    no 'split_group' appears in more than one split. Raises ValueError
    listing the offending groups — never let a leaky split train (R-04).
    """
    if "split" not in manifest.columns:
        raise ValueError("manifest is missing required column 'split'")
    bad = set(manifest["split"].unique()) - _VALID_SPLITS
    if bad:
        raise ValueError(
            f"manifest 'split' has invalid values: {sorted(bad)}; "
            f"expected subset of {_VALID_SPLITS}"
        )
    if "split_group" not in manifest.columns:
        raise ValueError("manifest is missing required column 'split_group'")
    per_group = manifest.groupby("split_group")["split"].nunique()
    leaky = per_group[per_group > 1].index.tolist()
    if leaky:
        raise ValueError(
            f"identity leakage: {len(leaky)} split_group(s) appear in more than "
            f"one split (R-04): {leaky}"
        )


def _pearson_r(a: np.ndarray, b: np.ndarray) -> float:
    """Pearson r, NaN (without warnings) when either side is constant."""
    if len(a) < 2:
        return float("nan")
    with np.errstate(invalid="ignore", divide="ignore"):
        r = np.corrcoef(a, b)[0, 1]
    return float(r)


def _load_gt_hr(row: pd.Series) -> float:
    """Ground-truth mean HR for a manifest row (UBFC-rPPG layout).

    Reads the UBFC ground_truth.txt format — 3 lines: PPG waveform samples,
    instantaneous HR in BPM, timestamps in seconds — and returns the mean of
    the per-frame HR line. Uses row["gt_path"] when present, otherwise
    ground_truth.txt next to the video file. Tests monkeypatch this helper.
    """
    gt_path = row.get("gt_path") or os.path.join(
        os.path.dirname(str(row["path"])), "ground_truth.txt"
    )
    with open(gt_path) as f:
        lines = f.read().strip().splitlines()
    if len(lines) < 2:
        raise ValueError(f"malformed ground truth file: {gt_path}")
    hr_vals = np.array([float(x) for x in lines[1].split()])
    hr_vals = hr_vals[np.isfinite(hr_vals)]
    if hr_vals.size == 0:
        raise ValueError(f"no finite HR values in {gt_path}")
    return float(np.mean(hr_vals))


def _extract_ppg(path: str, config: dict) -> tuple[np.ndarray, float]:
    """Shared ingest → face → roi → signal wiring. Returns (ppg (T,R), fps)."""
    stream = ingest.open_video(path)
    landmarks, valid = face.track_landmarks(stream.frames, stream.fps)
    traces = roi.extract_roi_means(
        stream.frames, landmarks, valid, config.get("roi_defs", roi.ROI_DEFS_P1)
    )
    ppg = signal.extract_ppg(traces, stream.fps, method=config.get("method", "pos"))
    return ppg, stream.fps


def evaluate_hr(manifest: pd.DataFrame, config: dict) -> HRReport:
    """Score HR estimates vs ground truth. Gate G1: MAE ≤ 5 bpm.

    Per row: extract the ppg, run estimate_hr on the forehead ROI
    (column 0), compare against _load_gt_hr. Returns MAE / RMSE /
    Pearson r plus a per-subject table.
    """
    band = tuple(config.get("band", (0.7, 3.0)))
    est, gt, subjects = [], [], []
    for i, (_, row) in enumerate(manifest.iterrows()):
        ppg, fps = _extract_ppg(str(row["path"]), config)
        res = hr.estimate_hr(ppg[:, 0], fps, band=band)
        if not np.isfinite(res.bpm):
            # No valid pulse signal (face never tracked / empty ROI): a silent
            # NaN would poison MAE — fail loudly instead (AGENTS.md §5).
            who = row.get("subject_id", row.get("video_id", f"row{i}"))
            raise NoFace(
                f"no pulse signal for {who} (bpm is NaN — face never tracked "
                f"or all-NaN ROI traces)"
            )
        est.append(float(res.bpm))
        gt.append(float(_load_gt_hr(row)))
        subjects.append(row.get("subject_id", row.get("video_id", f"row{i}")))
    est_a = np.asarray(est)
    gt_a = np.asarray(gt)
    err = np.abs(est_a - gt_a)
    mae = float(np.mean(err))
    rmse = float(np.sqrt(np.mean((est_a - gt_a) ** 2)))
    pearson = _pearson_r(est_a, gt_a)
    per_subject = pd.DataFrame(
        {"subject_id": subjects, "est_bpm": est_a, "gt_bpm": gt_a, "abs_err": err}
    )
    return HRReport(mae=mae, rmse=rmse, pearson_r=pearson, per_subject=per_subject)


def _bootstrap_cis(
    y_true_bin: np.ndarray,
    y_pred_bin: np.ndarray,
    scores: np.ndarray,
    n_boot: int = 1000,
    seed: int = 7,
) -> dict:
    """Bootstrap 95% percentile CIs for accuracy and AUC."""
    rng = np.random.default_rng(seed)
    n = len(y_true_bin)
    accs, aucs = [], []
    for _ in range(n_boot):
        idx = rng.integers(0, n, n)
        yt, yp, ys = y_true_bin[idx], y_pred_bin[idx], scores[idx]
        accs.append(float(np.mean(yt == yp)))
        if len(np.unique(yt)) == 2:
            aucs.append(float(roc_auc_score(yt, ys)))

    def _ci(vals: list) -> tuple:
        if not vals:
            return (float("nan"), float("nan"))
        return (float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5)))

    return {"accuracy": _ci(accs), "auc": _ci(aucs)}


def evaluate_detector(manifest: pd.DataFrame, model, config: dict) -> DetectionReport:
    """Score the detector. Gate G2: AUC ≥ 0.70 person-disjoint.

    Runs validate_manifest first (no leakage, NFR-08), predicts every row
    with predict_video, and reports accuracy / AUC (real-vote fraction as
    score) / precision / recall ("fake" = positive class) / confusion matrix /
    false-positive rate on real videos + 1000-resample bootstrap CIs.
    """
    validate_manifest(manifest)
    y_true, scores, y_pred = [], [], []
    for _, row in manifest.iterrows():
        pred = predict_video(str(row["path"]), model, config)
        y_true.append(_to_label(row["label"]))
        real_frac = sum(1 for v in pred.votes if v == "real") / max(len(pred.votes), 1)
        scores.append(real_frac)
        y_pred.append(pred.label)
    y_true = np.array(y_true)
    y_pred = np.array(y_pred)
    scores = np.array(scores)

    tp = int(np.sum((y_true == "fake") & (y_pred == "fake")))
    tn = int(np.sum((y_true == "real") & (y_pred == "real")))
    fp = int(np.sum((y_true == "real") & (y_pred == "fake")))
    fn = int(np.sum((y_true == "fake") & (y_pred == "real")))
    n = len(y_true)
    accuracy = (tp + tn) / n if n else float("nan")
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    fpr_on_real = fp / (fp + tn) if (fp + tn) else 0.0
    y_bin = (y_true == "real").astype(int)
    auc = (
        float(roc_auc_score(y_bin, scores))
        if len(np.unique(y_bin)) == 2
        else float("nan")
    )
    ci = _bootstrap_cis(
        y_bin,
        (y_pred == "real").astype(int),
        scores,
        n_boot=int(config.get("n_bootstrap", 1000)),
        seed=int(config.get("seed", 7)),
    )
    return DetectionReport(
        accuracy=float(accuracy),
        auc=auc,
        precision=float(precision),
        recall=float(recall),
        fpr_on_real=float(fpr_on_real),
        confusion={"tp": tp, "tn": tn, "fp": fp, "fn": fn},
        ci=ci,
        n=n,
    )


def write_report(report, config: dict, out_path: str) -> None:
    """Write a markdown run report per docs/08_acceptance_test_plan.md §5."""
    cfg_hash = hashlib.sha256(
        json.dumps(config, sort_keys=True, default=str).encode()
    ).hexdigest()[:8]
    date = datetime.now().strftime("%Y-%m-%d %H:%M")
    L = [f"# Run report — {date} — {cfg_hash}", "", "## Setup", ""]
    for key in (
        "dataset",
        "split_protocol",
        "method",
        "rois",
        "band",
        "window_s",
        "overlap",
        "model",
        "seed",
    ):
        if key in config:
            L.append(f"- {key}: {config[key]}")
    L.append(f"- config_hash: {cfg_hash}")
    L.append("")

    if isinstance(report, HRReport):
        L += [
            "## Heart-rate",
            "",
            f"- MAE: {report.mae:.3f} bpm (gate G1: ≤ 5)",
            f"- RMSE: {report.rmse:.3f} bpm",
            f"- Pearson r: {report.pearson_r:.3f}",
            "",
            "### Per-subject",
            "",
            "```",
            report.per_subject.to_string(index=False),
            "```",
            "",
        ]
    elif isinstance(report, DetectionReport):
        c = report.confusion
        L += [
            "## Detection",
            "",
            f"- Accuracy: {report.accuracy:.3f}",
            f"- AUC: {report.auc:.3f} (gate G2: ≥ 0.70)",
            f"- Precision: {report.precision:.3f} (positive class: fake)",
            f"- Recall: {report.recall:.3f}",
            (
                f"- Confusion: tp={c.get('tp')} tn={c.get('tn')} "
                f"fp={c.get('fp')} fn={c.get('fn')}"
            ),
            (
                "- False-positive rate on real videos (standalone): "
                f"{report.fpr_on_real:.3f}"
            ),
            "",
        ]
        if report.ci:
            L.append("- Bootstrap CIs (1000 resamples):")
            for k, (lo, hi) in report.ci.items():
                L.append(f"  - {k}: [{lo:.3f}, {hi:.3f}]")
            L.append("")
        L += [
            "## Cross-dataset",
            "",
            str(config.get("cross_dataset", "not run")),
            "",
            "## Compression",
            "",
            str(config.get("compression", "not run")),
            "",
        ]
    else:
        raise TypeError(f"unknown report type: {type(report).__name__}")

    L.append("## Honesty checklist")
    L.append("")
    L.append(
        "- [x] split protocol documented"
        if config.get("split_protocol")
        else "- [ ] split protocol documented"
    )
    L.append(
        "- [x] no leakage (validate_manifest green)"
        if isinstance(report, DetectionReport)
        else "- [ ] no leakage (validate_manifest green)"
    )
    L.append(
        "- [x] CIs reported"
        if getattr(report, "ci", None)
        else "- [ ] CIs reported"
    )
    L.append("- [ ] operating threshold tuned on validation only")
    L.append("- [ ] limitations listed (motion, compression, skin tone, pulse inheritance)")
    L.append("")

    with open(out_path, "w") as f:
        f.write("\n".join(L))
