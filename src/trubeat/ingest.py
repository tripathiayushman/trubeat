"""Video ingest: decode + metadata. FR-01, FR-02."""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .errors import LowFps, ShortVideo, UnreadableVideo

MIN_FPS = 15.0
MIN_DURATION_S = 10.0


@dataclass
class VideoStream:
    frames: np.ndarray  # uint8 (T, H, W, 3), RGB
    fps: float
    n_frames: int
    width: int
    height: int
    duration_s: float
    path: str


def open_video(path: str) -> VideoStream:
    """Decode a video file and validate it for rPPG work.

    Reads the TRUE frame rate from the container (never assumes 30).
    Raises E_UNREADABLE / E_LOW_FPS / E_SHORT_VIDEO on bad inputs.

    Error mapping:
      - not a file / cannot open / no decodable frames / missing fps
        metadata -> UnreadableVideo (E_UNREADABLE)
      - 0 < fps < MIN_FPS -> LowFps (E_LOW_FPS)
      - duration < MIN_DURATION_S -> ShortVideo (E_SHORT_VIDEO)
    """
    p = Path(path)
    if not p.is_file():
        raise UnreadableVideo(f"not a file: {path}")
    cap = cv2.VideoCapture(str(p))
    try:
        if not cap.isOpened():
            raise UnreadableVideo(f"cannot open video: {path}")
        fps = float(cap.get(cv2.CAP_PROP_FPS))
        if not np.isfinite(fps) or fps <= 0:
            # Without frame-rate metadata no bpm math is possible.
            raise UnreadableVideo(f"missing frame-rate metadata: {path}")
        # Stream frames into ONE preallocated RGB buffer. list+stack+flip
        # peaked at ~3x the video size on 640x480x1800-frame raw AVIs
        # (~5 GB, OOM-killed rc=137 on a 7 GB laptop). Fallback keeps the
        # list path for containers that report no frame count.
        n_meta = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        first_ok, first = cap.read()
        if not first_ok:
            raise UnreadableVideo(f"no decodable frames: {path}")
        h, w = first.shape[0], first.shape[1]
        frames = None
        if n_meta > 0 and fps > 0:
            frames = np.empty((n_meta, h, w, 3), dtype=np.uint8)
            frames[0] = first[:, :, ::-1]
            i = 1
            while i < n_meta:
                ok, frame = cap.read()
                if not ok:
                    break
                frames[i] = frame[:, :, ::-1]
                i += 1
            n = i
            if n < n_meta:  # metadata overcounted — trim the buffer
                frames = np.ascontiguousarray(frames[:n])
        else:
            frames = None
        if frames is None:
            frames_bgr = [first]
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                frames_bgr.append(frame)
            bgr = np.stack(frames_bgr, axis=0)  # (T, H, W, 3) BGR uint8
            del frames_bgr
            frames = np.ascontiguousarray(bgr[:, :, :, ::-1])  # -> RGB
            n = int(frames.shape[0])
    finally:
        cap.release()
    if fps < MIN_FPS:
        raise LowFps(f"fps={fps:.2f} < MIN_FPS={MIN_FPS}")
    duration_s = n / fps
    if duration_s < MIN_DURATION_S:
        raise ShortVideo(f"duration={duration_s:.2f}s < MIN_DURATION_S={MIN_DURATION_S}s")
    return VideoStream(
        frames=frames,
        fps=fps,
        n_frames=n,
        width=int(w),
        height=int(h),
        duration_s=duration_s,
        path=str(p),
    )
