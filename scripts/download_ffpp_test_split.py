"""Targeted FF++ c23 downloader — fetch exactly the files we are missing.

The stock `faceforensics_download_v4.py` downloads "the first N videos" in
server filelist order, which is not how we need to grow the *test split*:
we need specific source videos from the official test split, plus a
balanced selection of their manipulated counterparts.

This script constructs the URLs directly (same layout as the stock
downloader, EU2 server):

    original :  {base}/original_sequences/youtube/c23/videos/{id}.mp4
    fake     :  {base}/manipulated_sequences/{method}/c23/videos/{target}_{source}.mp4

Usage:
    python scripts/download_ffpp_test_split.py --pairs 40 --fakes-per-method 25
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
import urllib.request
from pathlib import Path

BASE = "http://kaldir.vc.in.tum.de/faceforensics/v3/"
METHODS = ("Deepfakes", "Face2Face", "FaceSwap", "NeuralTextures")
RAW = Path("data/raw/ffpp")


def load_test_pairs(splits_dir: Path) -> list[tuple[str, str]]:
    pairs = json.loads((splits_dir / "test.json").read_text())
    out = []
    for p in pairs:
        a, b = (str(x) for x in p)
        out.append((a, b))
    return out


def download(url: str, dest: Path, timeout: int = 60) -> bool:
    """Download one file atomically. Returns True on success."""
    if dest.is_file() and dest.stat().st_size > 0:
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            data = r.read()
    except Exception as exc:  # noqa: BLE001 — one bad file must not stop the run
        print(f"  FAILED {url}: {exc}", flush=True)
        return False
    fh, tmp = tempfile.mkstemp(dir=str(dest.parent))
    with os.fdopen(fh, "wb") as f:
        f.write(data)
    os.rename(tmp, dest)
    return True


def main() -> None:
    p = argparse.ArgumentParser(prog="download_ffpp_test_split")
    p.add_argument("--pairs", type=int, default=40,
                   help="how many official test pairs to add")
    p.add_argument("--fakes-per-method", type=int, default=25,
                   help="how many manipulated videos per method to add")
    p.add_argument("--splits-dir", default=str(RAW / "splits"))
    p.add_argument("--out-root", default=str(RAW))
    p.add_argument("--quality", default="c23")
    p.add_argument("--sleep", type=float, default=0.0)
    p.add_argument("--skip-originals", action="store_true",
                   help="only top up the manipulated files")
    args = p.parse_args()

    pairs = load_test_pairs(Path(args.splits_dir))
    root = Path(args.out_root)
    orig_dir = root / "original_sequences" / "youtube" / args.quality / "videos"

    # Which ids do we already have?
    have_orig = {p.stem for p in orig_dir.glob("*.mp4")}

    # Take the first N pairs whose ids we are missing (deterministic order).
    if args.skip_originals:
        wanted_pairs = pairs[: args.pairs]
    else:
        wanted_pairs = [
            pr for pr in pairs
            if pr[0] not in have_orig or pr[1] not in have_orig
        ]
        wanted_pairs = wanted_pairs[: args.pairs]
    if not wanted_pairs:
        print("nothing to do: all official test pairs already present")
        return

    # 1) originals for both ids of each selected pair
    orig_files = []
    if not args.skip_originals:
        for a, b in wanted_pairs:
            for sid in (a, b):
                orig_files.append(
                    (f"{BASE}original_sequences/youtube/{args.quality}/videos/{sid}.mp4",
                     orig_dir / f"{sid}.mp4")
                )
    # 2) manipulated: for each pair, alternate direction so the target ids
    #    spread over the split, and rotate methods so every method gets the
    #    same number of files.
    fake_files = []
    per_method_count = {m: 0 for m in METHODS}
    method_idx = 0
    for a, b in wanted_pairs:
        if all(c >= args.fakes_per_method for c in per_method_count.values()):
            break
        # pick the method that is furthest behind
        method = min(METHODS, key=lambda m: per_method_count[m])
        # alternate which id of the pair is the target
        target, source = (a, b) if (method_idx % 2 == 0) else (b, a)
        method_idx += 1
        name = f"{target}_{source}"
        dest = (root / "manipulated_sequences" / method / args.quality / "videos"
                / f"{name}.mp4")
        if not dest.is_file():
            fake_files.append(
                (f"{BASE}manipulated_sequences/{method}/{args.quality}/videos/{name}.mp4",
                 dest)
            )
        per_method_count[method] += 1

    total = len(orig_files) + len(fake_files)
    print(f"selected {len(wanted_pairs)} pairs -> {total} files to fetch "
          f"({len(orig_files)} originals + {len(fake_files)} fakes)")
    t0 = time.time()
    ok = 0
    for i, (url, dest) in enumerate(orig_files + fake_files, 1):
        if download(url, dest):
            ok += 1
        if i % 10 == 0 or i == total:
            print(f"  {i}/{total} fetched ({ok} ok) "
                  f"{time.time() - t0:.0f}s", flush=True)
        if args.sleep:
            time.sleep(args.sleep)
    print(f"done: {ok}/{total} files present, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
