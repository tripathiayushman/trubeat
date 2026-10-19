"""Compare pulse visibility across compression levels (R-01 / ADR-06).

Question: does the pulse become visible at lower compression? If the
inter-ROI agreement tightens for REAL videos while the fakes stay wide,
the FakeCatcher mechanism has something to measure again — and mixed
compression is the path. If nothing changes, rPPG-based detection is
capped by the data, not by our code.

For each video we compute, per ROI, the heart-rate estimate from the
cached pulse signal, and report the spread across the ROIs of one face.
A visible pulse -> the regions agree (single-digit bpm). Noise -> they
disagree wildly.

Usage:
    python scripts/compare_pulse_visibility.py \
        --manifest-a data/manifests/ffpp_c23_qc.csv --cache-a data/processed/traces \
        --manifest-b data/manifests/ffpp_raw_probe.csv --cache-b data/processed/traces_raw
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from trubeat import detector


def _measure(manifest: Path, cache: Path, method: str, split_filter: set[str]) -> dict:
    df = pd.read_csv(manifest)
    if "usable" in df.columns:
        df = df[df["usable"].astype(bool)]
    if split_filter:
        df = df[df["split"].isin(split_filter)]
    out: dict[str, dict] = {}
    for label in ("real", "fake"):
        ids = df[df["label"] == label]["video_id"].tolist()
        agree, ratio = [], []
        for vid in ids:
            got = detector.ppg_for_method(cache, vid, method)
            if got is None:
                continue
            ppg, fps = got
            if ppg.shape[1] < 2:
                continue
            from trubeat.hr import estimate_hr

            bpms = []
            for r in range(ppg.shape[1]):
                res = estimate_hr(ppg[:, r], fps, band=(0.7, 3.0))
                if np.isfinite(res.bpm):
                    bpms.append(res.bpm)
            if len(bpms) < 2:
                continue
            n = ppg.shape[0]
            fr = np.fft.rfftfreq(n, d=1.0 / fps)
            clean = np.nan_to_num(ppg, nan=0.0, posinf=0.0, neginf=0.0)
            pw = np.abs(
                np.fft.rfft(clean - clean.mean(axis=0, keepdims=True), axis=0)
            ) ** 2
            hb = pw[(fr >= 0.7) & (fr <= 3.0)].mean()
            wb = pw[(fr >= 0.7) & (fr <= 14.0)].mean()
            if np.isfinite(hb) and np.isfinite(wb) and wb > 0:
                agree.append(float(np.std(bpms)))
                ratio.append(float(hb / wb))
        if agree:
            out[label] = {
                "n": len(agree),
                "mean_roi_hr_agreement_bpm": float(np.mean(agree)),
                "median_roi_hr_agreement_bpm": float(np.median(agree)),
                "mean_hr_band_energy_ratio": float(np.mean(ratio)),
            }
    return out


def main() -> None:
    p = argparse.ArgumentParser(prog="compare_pulse_visibility")
    p.add_argument("--manifest-a", required=True, help="baseline (e.g. c23)")
    p.add_argument("--cache-a", required=True)
    p.add_argument("--manifest-b", required=True, help="candidate (e.g. raw)")
    p.add_argument("--cache-b", required=True)
    p.add_argument("--method", default="green")
    p.add_argument("--splits", default="train,val",
                   help="splits to use (never the test split)")
    args = p.parse_args()

    split_filter = {s for s in args.splits.split(",") if s}
    print(f"method: {args.method}   splits: {sorted(split_filter)}")
    print()
    results = {}
    for tag, man, cache in (
        ("A (" + Path(args.manifest_a).stem + ")", args.manifest_a, args.cache_a),
        ("B (" + Path(args.manifest_b).stem + ")", args.manifest_b, args.cache_b),
    ):
        results[tag] = _measure(Path(man), Path(cache), args.method, split_filter)

    print(f"{'set':<28} {'class':<6} {'n':>4} {'ROI-HR spread (bpm)':>22} "
          f"{'HR-band energy ratio':>22}")
    for tag, r in results.items():
        for label in ("real", "fake"):
            if label not in r:
                print(f"{tag:<28} {label:<6}   --  (no cache yet)")
                continue
            d = r[label]
            print(
                f"{tag:<28} {label:<6} {d['n']:>4} "
                f"{d['mean_roi_hr_agreement_bpm']:>15.1f} (median "
                f"{d['median_roi_hr_agreement_bpm']:>4.1f}) "
                f"{d['mean_hr_band_energy_ratio']:>22.3f}"
            )
    print()
    print("Read: a VISIBLE pulse -> the face regions agree on one rate")
    print("      (small spread). Tight spread for reals + wide spread for")
    print("      fakes => the signal exists and separates them.")


if __name__ == "__main__":
    main()
