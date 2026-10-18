"""Build dataset manifests for TrueBeat (docs/05 §4).

UBFC-rPPG layout (established):
    data/raw/ubfc_rppg/subject01/vid.avi
    data/raw/ubfc_rppg/subject01/ground_truth.txt   (3 lines: PPG, HR, timestamps)

FaceForensics++ layout (official download script):
    data/raw/ffpp/original_sequences/youtube/<c23>/videos/<id>.mp4
    data/raw/ffpp/manipulated_sequences/<Method>/<c23>/videos/<target>_<source>.mp4
    data/raw/ffpp/splits/{train,val,test}.json     (official 720/140/140 split)

Manifest schema (docs/05 §4): video_id, subject_id, source_video_id, label,
split_group, dataset, quality, fps, duration_s, path, split (+ gt_path for UBFC).

split_group: UBFC → subject_id; FF++ → *target* sequence id (the original video
that was manipulated — "<target>_<source>" per the FF++ dataset README), which
keeps each real video and its fakes on the same side of the split.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import cv2

FFPP_METHODS = ["Deepfakes", "Face2Face", "FaceSwap", "NeuralTextures"]
MANIFEST_COLUMNS = [
    "video_id", "subject_id", "source_video_id", "label", "split_group",
    "dataset", "quality", "fps", "duration_s", "path", "split", "gt_path",
]


def _video_meta(path: Path) -> tuple[float, float]:
    """(fps, duration_s) from container metadata — no full decode."""
    cap = cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened():
            raise ValueError(f"cannot open {path}")
        fps = float(cap.get(cv2.CAP_PROP_FPS))
        n = float(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if not fps or fps <= 0:
            raise ValueError(f"missing fps metadata: {path}")
        return fps, n / fps
    finally:
        cap.release()


def _find_video(subject_dir: Path) -> Path | None:
    for ext in ("vid.avi", "vid.mp4", "*.avi", "*.mp4"):
        hits = sorted(subject_dir.glob(ext))
        if hits:
            return hits[0]
    return None


def build_ubfc_manifest(raw_dir: Path, out_path: Path) -> int:
    """Scan data/raw/ubfc_rppg → manifests/ubfc.csv. Returns row count."""
    raw_dir, out_path = Path(raw_dir), Path(out_path)
    rows = []
    for subject_dir in sorted(raw_dir.glob("subject*")):
        if not subject_dir.is_dir():
            continue
        subject_id = subject_dir.name
        video = _find_video(subject_dir)
        if video is None:
            print(f"warning: no video in {subject_dir}, skipped", file=sys.stderr)
            continue
        gt = subject_dir / "ground_truth.txt"
        try:
            fps, duration_s = _video_meta(video)
        except ValueError as exc:
            print(f"warning: {exc}, skipped", file=sys.stderr)
            continue
        rows.append({
            "video_id": f"ubfc_{subject_id}",
            "subject_id": subject_id,
            "source_video_id": subject_id,
            "label": "real",
            "split_group": subject_id,
            "dataset": "ubfc",
            "quality": "raw",
            "fps": round(fps, 3),
            "duration_s": round(duration_s, 2),
            "path": str(video.resolve()),
            "split": "test",  # UBFC is the G1 HR-eval set, not training data
            "gt_path": str(gt.resolve()) if gt.is_file() else "",
        })
    _write(rows, out_path)
    return len(rows)


def _load_ffpp_splits(splits_dir: Path) -> dict[str, set[str]]:
    """{split: set of id keys}. Tries several layouts; fails loudly otherwise."""
    splits_dir = Path(splits_dir)
    candidates = [splits_dir]
    if (splits_dir / "splits").is_dir():
        candidates.append(splits_dir / "splits")
    found: dict[str, set[str]] = {}
    for cand in candidates:
        for split in ("train", "val", "test"):
            f = cand / f"{split}.json"
            if f.is_file():
                entries = json.loads(f.read_text())
                keys: set[str] = set()
                for e in entries:
                    if isinstance(e, str):
                        keys.add(e)
                        if "_" in e:  # "<target>_<source>" → also index by target
                            keys.add(e.split("_")[0])
                    elif isinstance(e, (list, tuple)) and e:
                        for x in e:
                            keys.add(str(x))
                        keys.add("_".join(str(x) for x in e))
                found[split] = keys
        if found:
            return found
    tried = [str(c / "{train,val,test}.json") for c in candidates]
    raise FileNotFoundError(
        "FF++ official split JSONs not found. Tried:\n  " + "\n  ".join(tried) +
        "\nThey ship with the official download script (splits/train.json etc.)."
    )


def _ffpp_split_for(stem: str, is_fake: bool, splits: dict[str, set[str]]) -> str:
    key = stem.split("_")[0] if is_fake else stem  # target id for fakes
    for split, keys in splits.items():
        if key in keys or stem in keys:
            return split
    raise ValueError(
        f"video '{stem}' not in any official split — check splits JSONs"
    )


def build_ffpp_manifest(raw_dir: Path, out_path: Path, quality: str = "c23") -> int:
    """Scan data/raw/ffpp → manifests/ffpp_<quality>.csv. Returns row count."""
    raw_dir, out_path = Path(raw_dir), Path(out_path)
    splits = _load_ffpp_splits(raw_dir)
    rows = []

    def add(video: Path, label: str, method: str, target: str):
        try:
            fps, duration_s = _video_meta(video)
        except ValueError as exc:
            print(f"warning: {exc}, skipped", file=sys.stderr)
            return
        stem = video.stem
        rows.append({
            "video_id": f"ffpp_{method}_{stem}",
            "subject_id": target,
            "source_video_id": target,
            "label": label,
            "split_group": target,  # real + its fakes stay on one side
            "dataset": "ffpp",
            "quality": quality,
            "fps": round(fps, 3),
            "duration_s": round(duration_s, 2),
            "path": str(video.resolve()),
            "split": _ffpp_split_for(stem, label == "fake", splits),
            "gt_path": "",
        })

    orig_dir = raw_dir / "original_sequences" / "youtube" / quality / "videos"
    if not orig_dir.is_dir():
        raise FileNotFoundError(f"originals not found: {orig_dir}")
    for video in sorted(orig_dir.glob("*.mp4")):
        add(video, "real", "original", video.stem)

    for method in FFPP_METHODS:
        mdir = raw_dir / "manipulated_sequences" / method / quality / "videos"
        if not mdir.is_dir():
            print(f"warning: {mdir} missing, skipped", file=sys.stderr)
            continue
        for video in sorted(mdir.glob("*.mp4")):
            add(video, "fake", method, video.stem.split("_")[0])

    _write(rows, out_path)
    return len(rows)


def _write(rows: list[dict], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=MANIFEST_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows → {out_path}")


def main() -> None:
    p = argparse.ArgumentParser(prog="build_manifest")
    p.add_argument("--dataset", required=True, choices=["ubfc", "ffpp"])
    p.add_argument("--raw", required=True, help="data/raw/<dataset> dir")
    p.add_argument("--out", required=True, help="output manifest CSV")
    p.add_argument("--quality", default="c23", help="FF++ compression (default c23)")
    args = p.parse_args()
    if args.dataset == "ubfc":
        n = build_ubfc_manifest(Path(args.raw), Path(args.out))
    else:
        n = build_ffpp_manifest(Path(args.raw), Path(args.out), args.quality)
    if n == 0:
        sys.exit("no videos found — check --raw")


if __name__ == "__main__":
    main()
