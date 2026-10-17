"""CLI: trubeat hr|train|predict|eval. (SRS §3)"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from . import eval as evalmod
from . import face, features, ingest, roi, signal
from . import hr as hrmod
from . import model as modelmod
from .errors import TrueBeatError


def load_config(path):
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
    if isinstance(cfg.get("band"), list):
        cfg["band"] = tuple(cfg["band"])
    return cfg


def _jsonable(d):
    """NaN → None so output is always valid JSON."""
    return {
        k: (None if isinstance(v, float) and math.isnan(v) else v)
        for k, v in d.items()
    }


def _feat_for_video(path, config):
    """Shared wiring: video → windowed feature DataFrame."""
    method = config.get("method", "pos")
    stream = ingest.open_video(path)
    landmarks, valid = face.track_landmarks(stream.frames, stream.fps)
    traces = roi.extract_roi_means(stream.frames, landmarks, valid, roi.ROI_DEFS_P1)
    ppg = signal.extract_ppg(traces, stream.fps, method=method)
    return features.window_features(
        ppg, stream.fps,
        win_s=config.get("window_s", 10.0),
        overlap=config.get("overlap", 0.5),
    )


def cmd_hr(args):
    config = load_config(args.config) if args.config else {}
    band = tuple(config.get("band", (0.7, 3.0)))
    method = config.get("method", "pos")
    stream = ingest.open_video(args.video)
    landmarks, valid = face.track_landmarks(stream.frames, stream.fps)
    traces = roi.extract_roi_means(stream.frames, landmarks, valid, roi.ROI_DEFS_P1)
    ppg = signal.extract_ppg(traces, stream.fps, method=method)
    res = hrmod.estimate_hr(np.nanmean(ppg, axis=1), stream.fps, band=band)
    print(json.dumps(_jsonable({
        "bpm": round(float(res.bpm), 1),
        "confidence": round(float(res.confidence), 3),
        "fps": float(stream.fps),
        "duration_s": round(float(stream.duration_s), 1),
        "face_valid_frac": round(float(np.mean(valid)), 3),
    })))


def cmd_train(args):
    import joblib

    config = load_config(args.config)
    manifest = pd.read_csv(args.manifest)
    evalmod.validate_manifest(manifest)
    train_rows = manifest[manifest["split"] == "train"]
    if train_rows.empty:
        sys.exit("no rows with split=='train' in manifest")
    X_parts, y, groups = [], [], []
    for _, row in train_rows.iterrows():
        feat = _feat_for_video(row["path"], config)
        if len(feat) == 0:
            print(f"warning: no windows for {row['path']}", file=sys.stderr)
            continue
        X_parts.append(feat)
        y.extend([row["label"]] * len(feat))
        groups.extend([row["split_group"]] * len(feat))
    X = pd.concat(X_parts, ignore_index=True)
    # NOTE (known wart): training on all window_features columns, including
    # win_start_s/win_end_s, because predict_video feeds the full frame to
    # model.predict — train/predict must see identical columns. Revisit with a
    # proper feature-selection step before Phase-2 real-data training.
    model = modelmod.train_classifier(X, np.array(y), np.array(groups))
    out = args.output or "runs/trubeat_model.joblib"
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "config": config}, out)
    print(json.dumps({"saved": out, "n_windows": len(X),
                      "n_videos": len(train_rows)}))


def _load_bundle(path):
    import joblib

    bundle = joblib.load(path)
    if isinstance(bundle, dict):
        return bundle["model"], bundle.get("config", {})
    return bundle, {}


def cmd_predict(args):
    model, saved_config = _load_bundle(args.model)
    config = load_config(args.config) if args.config else saved_config
    pred = modelmod.predict_video(args.video, model, config)
    print(json.dumps(_jsonable(pred.to_json())))


def cmd_eval(args):
    config = load_config(args.config)
    ds = args.dataset
    if Path(ds).exists():
        manifest_path = ds
    elif Path(ds).is_absolute():
        sys.exit(f"manifest not found: {ds}")
    else:
        manifest_path = f"data/manifests/{ds}.csv"
    manifest = pd.read_csv(manifest_path)
    if args.task == "hr":
        report = evalmod.evaluate_hr(manifest, config)
        summary = {"mae": report.mae, "rmse": report.rmse,
                   "pearson_r": report.pearson_r}
    else:
        if not args.model:
            sys.exit("eval --task detect requires --model")
        model, _ = _load_bundle(args.model)
        report = evalmod.evaluate_detector(manifest, model, config)
        summary = {"accuracy": report.accuracy, "auc": report.auc,
                   "fpr_on_real": report.fpr_on_real}
    out = args.report or "reports/eval_report.md"
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    evalmod.write_report(report, config, out)
    print(json.dumps(_jsonable({"report": out, **summary})))


def main() -> None:
    p = argparse.ArgumentParser(prog="trubeat")
    sub = p.add_subparsers(dest="cmd", required=True)

    h = sub.add_parser("hr", help="estimate heart rate from a video")
    h.add_argument("video")
    h.add_argument("--config", default=None)

    t = sub.add_parser("train", help="train the detector on a manifest")
    t.add_argument("--manifest", required=True)
    t.add_argument("--config", required=True)
    t.add_argument("--output", default=None)

    pr = sub.add_parser("predict", help="classify one video (offline)")
    pr.add_argument("video")
    pr.add_argument("--model", required=True)
    pr.add_argument("--config", default=None)

    e = sub.add_parser("eval", help="batch-score a dataset manifest")
    e.add_argument("--dataset", required=True,
                   help="manifest CSV path or data/manifests/<name>")
    e.add_argument("--config", required=True)
    e.add_argument("--task", default="detect", choices=["detect", "hr"])
    e.add_argument("--model", default=None)
    e.add_argument("--report", default=None)

    args = p.parse_args()
    try:
        {"hr": cmd_hr, "train": cmd_train, "predict": cmd_predict,
         "eval": cmd_eval}[args.cmd](args)
    except TrueBeatError as exc:
        print(json.dumps({"error": exc.code, "message": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
