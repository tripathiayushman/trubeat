"""Join per-video QC from the trace cache into a manifest (docs/05 §6).

The cache writes one sidecar JSON per video with `face_valid_frac`,
`mean_snr` and warnings. This script joins that QC onto the manifest and
marks every row as usable / excluded, so training never sees a video that
produced no measurable signal.

Usage:
    python scripts/qc_manifest.py \
        --manifest data/manifests/ffpp_c23.csv \
        --traces data/processed/traces \
        --out data/manifests/ffpp_c23_qc.csv \
        --report reports/qc_ffpp_c23.md

Exclusion rules (each is recorded, never silent):
  - MISSING_CACHE  : no trace was cached for this video
  - NO_FACE        : face never tracked (face_valid_frac == 0)
  - UNSTABLE_TRACK : face tracked in < 70% of frames (W_UNSTABLE_TRACK)
  - NO_SIGNAL      : mean_snr == 0 (nothing measurable in band)
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

MIN_FACE_VALID_FRAC = 0.7


def load_qc(traces_dir: Path) -> dict[str, dict]:
    """Read every <video_id>.json sidecar in the trace cache."""
    out: dict[str, dict] = {}
    for j in sorted(traces_dir.glob("*.json")):
        try:
            d = json.loads(j.read_text())
        except json.JSONDecodeError:
            continue
        vid = d.get("video_id")
        if vid:
            out[str(vid)] = d
    return out


def exclusion_reasons(row: pd.Series, qc: dict | None) -> list[str]:
    """Why this row cannot be used for training (empty list = usable)."""
    if qc is None:
        return ["MISSING_CACHE"]
    valid = float(qc.get("face_valid_frac", 0.0))
    snr = float(qc.get("mean_snr", 0.0))
    reasons: list[str] = []
    if valid <= 0.0:
        reasons.append("NO_FACE")
    elif valid < MIN_FACE_VALID_FRAC:
        reasons.append("UNSTABLE_TRACK")
    if snr <= 0.0:
        reasons.append("NO_SIGNAL")
    return reasons


def main() -> None:
    p = argparse.ArgumentParser(prog="qc_manifest")
    p.add_argument("--manifest", required=True)
    p.add_argument("--traces", default="data/processed/traces")
    p.add_argument("--out", required=True)
    p.add_argument("--report", default="")
    args = p.parse_args()

    manifest = pd.read_csv(args.manifest)
    qc_all = load_qc(Path(args.traces))

    qc_rows = []
    for _, row in manifest.iterrows():
        vid = str(row["video_id"])
        qc = qc_all.get(vid)
        reasons = exclusion_reasons(row, qc)
        qc_rows.append(
            {
                "video_id": vid,
                "face_valid_frac": float(qc.get("face_valid_frac", np.nan)) if qc else np.nan,
                "mean_snr": float(qc.get("mean_snr", np.nan)) if qc else np.nan,
                "cache_status": "cached" if qc else "missing",
                "exclusion": ";".join(reasons),
                "usable": len(reasons) == 0,
            }
        )
    qc_df = pd.DataFrame(qc_rows)
    out_df = manifest.merge(qc_df, on="video_id", how="left")
    out_df["usable"] = out_df["usable"].fillna(False).astype(bool)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_df.to_csv(out_path, index=False)

    cached = qc_df[qc_df["cache_status"] == "cached"]
    usable = out_df[out_df["usable"]]
    n = len(out_df)

    print(f"manifest rows      : {n}")
    print(f"cached             : {len(cached)}")
    print(f"missing cache      : {n - len(cached)}")
    print(f"usable             : {len(usable)}  ({len(usable) / n:.1%})")
    print(f"excluded           : {n - len(usable)}")
    if len(cached):
        print(f"mean face_valid_frac: {cached['face_valid_frac'].mean():.4f}")
        print(f"mean mean_snr       : {cached['mean_snr'].mean():.2f}")
    print(f"wrote {out_path}")

    if args.report:
        L = [
            f"# Trace-cache QC — {datetime.now():%Y-%m-%d %H:%M}",
            "",
            "## Setup",
            "",
            f"- manifest: `{args.manifest}`",
            f"- trace cache: `{args.traces}`",
            f"- method: pos (cache key includes ROI set + method + frame height)",
            "",
            "## Totals",
            "",
            f"- manifest rows: **{n}**",
            f"- cached: **{len(cached)}**",
            f"- missing cache: **{n - len(cached)}**",
            f"- **usable: {len(usable)}** ({len(usable) / n:.1%})",
            f"- excluded: **{n - len(usable)}**",
            "",
            "## Aggregate QC (cached videos)",
            "",
        ]
        if len(cached):
            L += [
                f"- mean `face_valid_frac`: **{cached['face_valid_frac'].mean():.4f}**",
                f"- median `face_valid_frac`: {cached['face_valid_frac'].median():.4f}",
                f"- min `face_valid_frac`: {cached['face_valid_frac'].min():.4f}",
                f"- mean `mean_snr`: **{cached['mean_snr'].mean():.2f}**",
                f"- median `mean_snr`: {cached['mean_snr'].median():.2f}",
                f"- min / max `mean_snr`: {cached['mean_snr'].min():.2f} / "
                f"{cached['mean_snr'].max():.2f}",
                "",
            ]
        excl = out_df[~out_df["usable"]]
        if len(excl):
            L += [
                "### Exclusions by reason",
                "",
                "| reason | n |",
                "|--------|---|",
            ]
            counts: dict[str, int] = {}
            for reasons in excl["exclusion"]:
                for r in reasons.split(";"):
                    if r:
                        counts[r] = counts.get(r, 0) + 1
            for reason, cnt in sorted(counts.items(), key=lambda kv: -kv[1]):
                L.append(f"| {reason} | {cnt} |")
            L += ["", "### Excluded videos", "", "| video_id | label | split | reason |", "|---|---|---|---|"]
            for _, r in excl.iterrows():
                L.append(
                    f"| {r['video_id']} | {r['label']} | {r['split']} | {r['exclusion']} |"
                )
            L.append("")
        by_label = usable.groupby("label").size()
        L += [
            "## Usable by label",
            "",
            "| label | n |",
            "|---|---|",
        ]
        for label, cnt in by_label.items():
            L.append(f"| {label} | {cnt} |")
        L += [
            "",
            "## Honesty checklist",
            "",
            "- [x] every cached video has QC (face_valid_frac, mean_snr)",
            "- [x] unusable videos are excluded with a recorded reason",
            "- [x] no silent drops",
            "- [ ] class balance re-checked after exclusions (see above)",
            "",
        ]
        rp = Path(args.report)
        rp.parent.mkdir(parents=True, exist_ok=True)
        rp.write_text("\n".join(L))
        print(f"wrote {rp}")


if __name__ == "__main__":
    main()
