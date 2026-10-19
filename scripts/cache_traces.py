"""Cache per-video rPPG traces (docs/05 §6).

Pipeline: video → open_video → track_landmarks → extract_roi_means → (T,R,3)
trace → extract_ppg → (T,R) ppg → data/processed/traces/<video_id>.npz.

This is the expensive step (~minutes/video on CPU) — hence the cache.
Everything downstream (method/band/window experiments) re-runs from cache
in seconds. Cache key = sha256(video bytes + ROI defs + method); changing
the ROI set or method invalidates automatically. `--resume` skips videos
whose cache is fresh.

Sidecar <video_id>.json records QC: face_valid_frac, mean_snr, warnings.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from trubeat import face, ingest, roi, signal

CHUNK = 1 << 20


def hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_key(video_path: Path, roi_defs: dict, method: str,
              frame_height: int | None = None) -> str:
    h = hashlib.sha256()
    h.update(hash_file(video_path).encode())
    h.update(json.dumps(roi_defs, sort_keys=True).encode())
    h.update(method.encode())
    # Frame height changes the decoded pixels -> must invalidate the cache.
    h.update(f"fh={frame_height}".encode())
    return h.hexdigest()[:16]


def _mean_snr(ppg: np.ndarray, fps: float) -> float:
    """Mean over ROIs of peak/mean in-band power (0.7–14 Hz)."""
    n = ppg.shape[0]
    freqs = np.fft.rfftfreq(n, d=1.0 / fps)
    mask = (freqs >= 0.7) & (freqs <= 14.0)
    snrs = []
    for r in range(ppg.shape[1]):
        power = np.abs(np.fft.rfft(ppg[:, r] - np.nanmean(ppg[:, r]))) ** 2
        band = power[mask]
        if band.size and np.all(np.isfinite(band)):
            snrs.append(float(band.max() / (band.mean() + 1e-12)))
    return float(np.mean(snrs)) if snrs else 0.0


def process_one(video_path: Path, roi_defs: dict, method: str,
                frame_height: int | None = None) -> dict:
    """Full trace pipeline for one video. Returns cache payload + QC."""
    stream = ingest.open_video(str(video_path), frame_height=frame_height)
    landmarks, valid = face.track_landmarks(stream.frames, stream.fps)
    face_valid_frac = float(np.mean(valid))
    traces = roi.extract_roi_means(stream.frames, landmarks, valid, roi_defs)
    ppg = signal.extract_ppg(traces, stream.fps, method=method)
    return {
        "traces": traces,  # (T, R, 3) float64, NaN where face invalid
        "ppg": ppg,        # (T, R) float64
        "fps": stream.fps,
        "n_frames": stream.n_frames,
        "qc": {
            "face_valid_frac": round(face_valid_frac, 4),
            "mean_snr": round(_mean_snr(ppg, stream.fps), 3),
            "warnings": (
                ["W_UNSTABLE_TRACK"] if face_valid_frac < 0.7 else []
            ),
        },
    }


def main() -> None:
    p = argparse.ArgumentParser(prog="cache_traces")
    p.add_argument("--manifest", required=True)
    p.add_argument("--out-dir", default="data/processed/traces")
    p.add_argument("--method", default="pos", choices=["green", "chrom", "pos"])
    p.add_argument("--frame-height", type=int, default=ingest.DEFAULT_FRAME_HEIGHT,
                   help="downscale taller videos to this height (0 = native)")
    p.add_argument("--resume", action="store_true",
                   help="skip videos whose cache key is fresh")
    args = p.parse_args()

    manifest = pd.read_csv(args.manifest)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    roi_defs = roi.ROI_DEFS_P1

    done, skipped, failed = 0, 0, 0
    frame_height = args.frame_height if args.frame_height and args.frame_height > 0 else None
    for _, row in manifest.iterrows():
        video_path = Path(row["path"])
        vid = str(row["video_id"])
        key = cache_key(video_path, roi_defs, args.method, frame_height)
        npz_path = out_dir / f"{vid}.npz"
        json_path = out_dir / f"{vid}.json"
        if args.resume and npz_path.is_file() and json_path.is_file():
            try:
                if json.loads(json_path.read_text())["cache_key"] == key:
                    skipped += 1
                    continue
            except (json.JSONDecodeError, KeyError):
                pass
        try:
            payload = process_one(video_path, roi_defs, args.method, frame_height)
        except Exception as exc:  # noqa: BLE001 — per-video isolation
            print(f"FAILED {vid}: {exc}", file=sys.stderr)
            failed += 1
            continue
        np.savez_compressed(
            npz_path,
            traces=payload["traces"], ppg=payload["ppg"],
            fps=np.array(payload["fps"]), n_frames=np.array(payload["n_frames"]),
        )
        json_path.write_text(json.dumps({
            "video_id": vid, "cache_key": key, "method": args.method,
            "roi_defs": list(roi_defs), **payload["qc"],
        }, indent=1))
        done += 1
        print(f"cached {vid} "
              f"(valid={payload['qc']['face_valid_frac']:.2f}, "
              f"snr={payload['qc']['mean_snr']:.1f})")
    print(f"done={done} skipped={skipped} failed={failed}")


if __name__ == "__main__":
    main()
