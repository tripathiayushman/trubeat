"""Audit the test split end to end: downloaded -> cached -> usable -> scored.

Every count in the G2 report has to be reconcilable: for each method (and
the reals), how many videos exist on disk, how many produced a cached
trace, how many survived QC, and how many were actually scored.

The script reads the filesystem and the manifests — it never recomputes
anything from memory — so the table can be regenerated and checked.

Usage:
    python scripts/audit_test_split.py \
        --manifest data/manifests/ffpp_c23.csv \
        --qc-manifest data/manifests/ffpp_c23_qc.csv \
        --traces data/processed/traces \
        --report reports/test_split_audit.md
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

import pandas as pd

METHODS = ("Deepfakes", "Face2Face", "FaceSwap", "NeuralTextures")
RAW = Path("data/raw/ffpp")


def method_of(video_id: str) -> str:
    m = re.match(r"ffpp_(original|Deepfakes|Face2Face|FaceSwap|NeuralTextures)_", video_id)
    return m.group(1) if m else "?"


def disk_counts(quality: str = "c23") -> dict[str, dict[str, int]]:
    """How many files of each kind exist on disk, per method."""
    out: dict[str, dict[str, int]] = {}
    orig = RAW / "original_sequences" / "youtube" / quality / "videos"
    out["original"] = {"downloaded": len(list(orig.glob("*.mp4")))}
    for m in METHODS:
        d = RAW / "manipulated_sequences" / m / quality / "videos"
        out[m] = {"downloaded": len(list(d.glob("*.mp4")))} if d.is_dir() else {
            "downloaded": 0
        }
    return out


def audit_table(
    manifest: Path, qc_manifest: Path, traces: Path
) -> tuple[pd.DataFrame, dict[str, int], dict[str, int]]:
    """Reconciliation table + exclusion reasons + totals.

    Every count is read from the filesystem and the manifests.
    """
    man = pd.read_csv(manifest)
    qc = pd.read_csv(qc_manifest)
    disk = disk_counts()

    man = man.assign(method=man.video_id.map(method_of))
    qc = qc.assign(method=qc.video_id.map(method_of))

    rows = []
    for method in ["original", *METHODS]:
        m_man = man[man["method"] == method]
        m_qc = qc[qc["method"] == method]
        te_man = m_man[m_man["split"] == "test"]
        te_qc = m_qc[m_qc["split"] == "test"]
        cached = int(sum((traces / f"{v}.npz").is_file() for v in te_man["video_id"]))
        usable = int(te_qc["usable"].astype(bool).sum())
        rows.append(
            {
                "method": method,
                "label": "real" if method == "original" else "fake",
                "on_disk_all_splits": disk[method]["downloaded"],
                "in_manifest_all_splits": len(m_man),
                "test_manifest": len(te_man),
                "test_cached": cached,
                "test_usable": usable,
                "test_excluded": len(te_man) - usable,
            }
        )
    df = pd.DataFrame(rows)

    counts: dict[str, int] = {}
    te_all = qc[qc["split"] == "test"]
    for r in te_all[~te_all["usable"].astype(bool)]["exclusion"]:
        for reason in str(r).split(";"):
            if reason:
                counts[reason] = counts.get(reason, 0) + 1

    total = {
        "on_disk_all_splits": int(df["on_disk_all_splits"].sum()),
        "in_manifest_all_splits": int(df["in_manifest_all_splits"].sum()),
        "test_manifest": int(df["test_manifest"].sum()),
        "test_cached": int(df["test_cached"].sum()),
        "test_usable": int(df["test_usable"].sum()),
        "test_excluded": int(df["test_excluded"].sum()),
    }
    return df, counts, total


def main() -> None:
    p = argparse.ArgumentParser(prog="audit_test_split")
    p.add_argument("--manifest", required=True)
    p.add_argument("--qc-manifest", required=True)
    p.add_argument("--traces", default="data/processed/traces")
    p.add_argument("--report", default="")
    args = p.parse_args()

    df, counts, total = audit_table(
        Path(args.manifest), Path(args.qc_manifest), Path(args.traces)
    )

    pd.set_option("display.width", 200)
    print("=== TEST-SPLIT AUDIT (all counts read from disk / manifests) ===")
    print(df.to_string(index=False))
    print()
    print("Legend:")
    print("  on_disk_all_splits  - .mp4 files present for this method (any split)")
    print("  in_manifest_all_splits - rows the manifest builder produced")
    print("  test_manifest       - manifest rows in the OFFICIAL test split")
    print("  test_cached         - of those, a trace exists in the cache")
    print("  test_usable         - of those, passed QC (usable==True)")
    print("  test_excluded       - of those, excluded with a recorded reason")

    # Exclusion reasons in the test split.
    qc_all = pd.read_csv(args.qc_manifest)
    te = qc_all[qc_all["split"] == "test"]
    exc = te[~te["usable"].astype(bool)]
    print()
    print(f"=== test-split exclusions ({len(exc)} of {len(te)}) ===")
    for reason, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {reason:<15} {n}")

    if args.report:
        lines = [
            "# Test-split audit — downloaded → cached → usable → scored",
            "",
            "Every count below is read from the filesystem and the manifests "
            "by `scripts/audit_test_split.py`; none is carried by hand.",
            "",
            "## Per method",
            "",
            "| method | label | on disk (all splits) | in manifest (all) | "
            "test manifest | test cached | test usable | test excluded |",
            "|--------|-------|-----------------------|------------------|"
            "---------------|--------------|-------------|---------------|",
        ]
        for _, r in df.iterrows():
            lines.append(
                f"| {r['method']} | {r['label']} | {r['on_disk_all_splits']} | "
                f"{r['in_manifest_all_splits']} | {r['test_manifest']} | "
                f"{r['test_cached']} | {r['test_usable']} | {r['test_excluded']} |"
            )
        lines += [
            f"| **total** | | **{total['on_disk_all_splits']}** | "
            f"**{total['in_manifest_all_splits']}** | "
            f"**{total['test_manifest']}** | "
            f"**{total['test_cached']}** | "
            f"**{total['test_usable']}** | "
            f"**{total['test_excluded']}** |",
            "",
            "## Exclusion reasons in the test split",
            "",
            "| reason | n |",
            "|--------|---|",
        ]
        for reason, n in sorted(counts.items(), key=lambda kv: -kv[1]):
            lines.append(f"| {reason} | {n} |")
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text("\n".join(lines) + "\n")
        print(f"\nwrote {args.report}")


if __name__ == "__main__":
    main()
