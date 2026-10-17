"""Dry-run the G1 heart-rate gate end-to-end on synthetic data.

No real faces, no downloaded datasets. Stages a synthetic UBFC-shaped tree
(subjectXX/vid.avi + ground_truth.txt), builds the manifest with the real
scripts/build_manifest.py, then runs the real CLI eval path (cli.cmd_eval)
with only one link mocked: MediaPipe face tracking — synthetic videos are
solid-colored by design and contain no face, so `tracks_landmarks` is
replaced by a full-478 synthetic landmark array (same bypass as
tests/test_e2e_synthetic.py). Everything after the face link — ingest, ROI,
signal, hr, metrics, report writer — is the real code path.

Run:  .venv/bin/python scripts/dryrun_g1.py
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import unittest.mock
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "tests"))
sys.path.insert(0, str(REPO_ROOT / "src"))

import synth  # noqa: E402 (tests/synth.py)
from trubeat import cli, eval as evalmod  # noqa: E402


def stage_subjects(root: Path, specs: list[tuple[str, float]]) -> pd.DataFrame:
    """Write subjectXX/vid.avi + ground_truth.txt trees. Returns staged rows."""
    for name, bpm in specs:
        sdir = root / name
        sdir.mkdir(parents=True, exist_ok=True)
        vid = sdir / "vid.avi"
        if not vid.is_file():
            synth.write_pulse_video(
                str(vid), fps=30.0, duration_s=60.0, bpm=bpm, mode="coherent"
            )
        n = int(30.0 * 60.0)
        ppg = synth.pulse_wave(n, 30.0, bpm, noise_std=0.02, seed=int(bpm))
        with open(sdir / "ground_truth.txt", "w") as f:
            f.write(" ".join(f"{v:.4f}" for v in ppg) + "\n")
            f.write(" ".join([f"{bpm:.2f}"] * n) + "\n")  # per-frame HR
            f.write(" ".join(f"{i / 30.0:.6f}" for i in range(n)) + "\n")
    manifest = REPO_ROOT / "data" / "manifests" / "dryrun_ubfc.csv"
    subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "build_manifest.py"),
         "--dataset", "ubfc", "--raw", str(root), "--out", str(manifest)],
        check=True,
    )
    return pd.read_csv(manifest)


def run(config_path: Path, report: str) -> dict:
    """Exact CLI code path (cmd_eval) via argparse, face link mocked."""
    import trubeat.face as facemod

    def fake_track(frames, fps):
        # Full 478 landmarks in a central ellipse (all ROI polygons valid);
        # the pulse is coherent across the whole frame, so polygon placement
        # does not change what we measure.
        return synth.synthetic_landmarks(len(frames),
                                         h=frames.shape[1],
                                         w=frames.shape[2])

    # Build the config the way cli.load_config does (band list → tuple)
    config = cli.load_config(config_path)
    args = argparse.Namespace(
        dataset=str(REPO_ROOT / "data" / "manifests" / "dryrun_ubfc.csv"),
        config=str(config_path), task="hr", model=None,
        report=report,
    )
    with unittest.mock.patch.object(facemod, "track_landmarks", fake_track):
        cli.cmd_eval(args)  # writes the markdown report itself
    out = evalmod.__name__  # silence linters; results parsed from report
    return {"report": report, "out": out}


def main() -> None:
    p = argparse.ArgumentParser(prog="dryrun_g1")
    p.add_argument("--config",
                   default=str(REPO_ROOT / "configs" / "p1_hr.yaml"))
    p.add_argument("--report",
                   default=str(REPO_ROOT / "reports" / "dryrun_g1_ubfc.md"))
    p.add_argument("--tmp", default="/tmp/opencode/g1_dryrun")
    p.add_argument("--mae-max", type=float, default=2.0,
                   help="assert dry-run MAE below this (synthetic = near 0)")
    args = p.parse_args()

    root = Path(args.tmp) / "ubfc_rppg"
    manifest = stage_subjects(root, [("subject1", 60.0),
                                     ("subject2", 72.0),
                                     ("subject3", 90.0)])
    print(f"staged {len(manifest)} synthetic subjects; manifest rows:")
    print(manifest[["video_id", "fps", "duration_s", "gt_path"]].to_string(
        index=False))

    res = run(Path(args.config), args.report)
    lines = Path(args.report).read_text().splitlines()
    mae = next(float(l.split(":")[1].split()[0]) for l in lines
               if l.startswith("- MAE:"))
    print(f"MAE = {mae:.3f} bpm (assert < {args.mae_max}); report: "
          f"{res['report']}")
    assert mae < args.mae_max, f"dry-run MAE={mae} — integration failure"
    print("DRYRUN_G1_OK")


if __name__ == "__main__":
    main()
