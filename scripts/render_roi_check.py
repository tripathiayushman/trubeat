"""Render the Phase-1 ROI polygons on a real video frame (B4 visual glance).

Takes one video path, runs the real ingest → face → ROI chain up to the
first frame where the face is confidently tracked, and saves the frame with
the ROI polygons + landmark indices overlaid. Output is a local-side visual
aid only (reports/ is gitignored); nothing leaves the machine.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

import trubeat  # noqa: F401  (ensures package import errors surface early)
from trubeat import face, ingest, roi
from trubeat.errors import NoFace, TrueBeatError

COLORS = {  # BGR
    "forehead": (0, 0, 255),
    "cheek_l": (0, 170, 0),
    "cheek_r": (255, 0, 0),
}


def render_roi_check(video_path: str, out_path: str) -> dict:
    """Overwrite first-validated frame + ROI polygons. Returns QC info."""
    stream = ingest.open_video(video_path)
    landmarks, valid = face.track_landmarks(stream.frames, stream.fps)
    idx = np.flatnonzero(valid)
    if idx.size == 0:
        raise NoFace(f"no tracked face in any frame of {video_path}")
    i = int(idx[0])

    frame_bgr = cv2.cvtColor(stream.frames[i], cv2.COLOR_RGB2BGR)
    canvas = frame_bgr.copy()
    for name, indices in roi.ROI_DEFS_P1.items():
        pts = landmarks[i, indices]
        poly = np.round(pts).astype(np.int32).reshape((-1, 1, 2))
        overlay = canvas.copy()
        cv2.fillPoly(overlay, [poly], (90, 90, 90))
        cv2.addWeighted(overlay, 0.35, canvas, 0.65, 0, dst=canvas)
        color = COLORS.get(name, (255, 255, 255))
        cv2.polylines(canvas, [poly], True, color, 2)
        for j in indices:
            x, y = landmarks[i, j]
            cv2.circle(canvas, (int(x), int(y)), 3, color, -1)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(out_path, canvas)
    return {
        "frame": i,
        "face_valid_frac": round(float(np.mean(valid)), 3),
        "fps": float(stream.fps),
        "n_frames": int(stream.n_frames),
        "n_cached_frames": int(stream.frames.shape[0]),
        "out": out_path,
    }


def main() -> None:
    p = argparse.ArgumentParser(prog="render_roi_check")
    p.add_argument("video")
    p.add_argument("--out", default="reports/roi_check.png")
    args = p.parse_args()
    try:
        info = render_roi_check(args.video, args.out)
    except TrueBeatError as exc:
        print(f"error: {exc.code}: {exc}", file=sys.stderr)
        sys.exit(1)
    print(info)


if __name__ == "__main__":
    main()
