"""Build a manifest for the lossless (raw) FF++ probe set.

The probe exists to answer one question (R-01): does the pulse become
visible at lossless quality, i.e. does the inter-ROI consistency mechanism
have anything to measure?

The raw probe uses the SAME video ids as the c23 set (same source videos,
different compression), so it gets its own manifest and its own cache
directory — the cache key includes the video bytes, so sharing a cache
directory would invalidate the c23 entries.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pandas as pd

RAW_ROOT = Path("data/raw/ffpp")
SPLIT_DIR = RAW_ROOT / "splits"
METHODS = ("Deepfakes", "Face2Face", "FaceSwap", "NeuralTextures")


def load_splits() -> dict[str, str]:
    """source video id -> split, from the official FF++ split JSONs."""
    out: dict[str, str] = {}
    for split in ("train", "val", "test"):
        f = SPLIT_DIR / f"{split}.json"
        if not f.is_file():
            raise FileNotFoundError(f"official splits not found: {f}")
        for entry in json.loads(f.read_text()):
            ids = entry if isinstance(entry, list) else [entry]
            for vid in ids:
                out[str(vid)] = split
    return out


def main() -> None:
    p = argparse.ArgumentParser(prog="build_raw_manifest")
    p.add_argument("--out", default="data/manifests/ffpp_raw_probe.csv")
    args = p.parse_args()

    splits = load_splits()
    rows: list[dict] = []

    orig_dir = RAW_ROOT / "original_sequences" / "youtube" / "raw" / "videos"
    for video in sorted(orig_dir.glob("*.mp4")):
        src = video.stem
        rows.append(
            {
                "video_id": f"ffpp_original_{src}",
                "subject_id": src,
                "source_video_id": src,
                "label": "real",
                "split_group": src,
                "dataset": "ffpp_raw",
                "quality": "raw",
                "path": str(video.resolve()),
                "split": splits.get(src, "test"),
                "gt_path": "",
            }
        )

    for method in METHODS:
        mdir = RAW_ROOT / "manipulated_sequences" / method / "raw" / "videos"
        if not mdir.is_dir():
            continue
        for video in sorted(mdir.glob("*.mp4")):
            m = re.match(r"^(\d+)_(\d+)$", video.stem)
            if not m:
                continue
            target, source = m.group(1), m.group(2)
            rows.append(
                {
                    "video_id": f"ffpp_{method}_{target}_{source}",
                    "subject_id": target,
                    "source_video_id": source,
                    "label": "fake",
                    "split_group": source,
                    "dataset": "ffpp_raw",
                    "quality": "raw",
                    "path": str(video.resolve()),
                    "split": splits.get(source, "test"),
                    "gt_path": "",
                }
            )

    df = pd.DataFrame(rows)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    print(f"wrote {len(df)} rows -> {out}")
    print(df.groupby(["label", "split"]).size().to_string())


if __name__ == "__main__":
    main()
