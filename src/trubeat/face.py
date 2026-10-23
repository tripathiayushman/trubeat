"""Face + landmark tracking via MediaPipe Face Landmarker. FR-03."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

N_LANDMARKS = 478

_BUNDLE_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)


def resolve_model_path() -> Path:
    """Locate the Face Landmarker .task bundle.

    Resolution order: the ``TRUBEAT_FACE_MODEL`` env override, the
    repo-root ``data/models/`` copy (repo checkouts: the symlink there
    already points at the packaged copy), then the copy **packaged inside
    the wheel** (``site-packages/trubeat/models/``), so a pip-installed
    tool finds it without any checkout beside it. TrueBeat is local-first:
    the hosted demo is paused, the app runs on the user's own machine. The caller raises the download-instructions error
    when the returned path is missing.
    """
    env = os.environ.get("TRUBEAT_FACE_MODEL")
    if env:
        return Path(env)
    readers = Path(__file__).resolve()
    repo_data = readers.parents[2] / "data" / "models" / "face_landmarker.task"
    if repo_data.is_file():
        return repo_data
    return readers.parent / "models" / "face_landmarker.task"


def _load_landmarker(model_path: Path):
    """Create the FaceLandmarker (VIDEO mode). Import is lazy so the module
    imports fine without mediapipe installed; the error surfaces only on call.
    """
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision
    except ImportError as exc:
        raise RuntimeError(
            "mediapipe is required for face tracking: "
            "pip install mediapipe==0.10.21"
        ) from exc
    base = mp_python.BaseOptions(model_asset_path=str(model_path))
    options = mp_vision.FaceLandmarkerOptions(
        base_options=base,
        running_mode=mp_vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return mp_vision.FaceLandmarker.create_from_options(options), mp


def track_landmarks(frames: np.ndarray, fps: float) -> tuple[np.ndarray, np.ndarray]:
    """Run Face Landmarker on every frame.

    Args:
        frames: uint8 (T, H, W, 3) RGB.
        fps: true frame rate (drives per-frame timestamps).

    Returns:
        landmarks: float32 (T, 478, 2) in pixel coords (NaN where invalid)
        valid: bool (T,) — face confidently tracked in this frame
    Re-detects when tracking is lost; caller warns if valid.mean() < 0.7.
    """
    if frames.dtype != np.uint8:
        raise ValueError(f"frames must be uint8 RGB, got {frames.dtype}")
    model_path = resolve_model_path()
    if not model_path.is_file():
        raise RuntimeError(
            f"Face Landmarker model not found: {model_path}\n"
            f"Download it with:\n"
            f"  mkdir -p {model_path.parent} && \\\n"
            f"    curl -L -o {model_path} {_BUNDLE_URL}\n"
            f"or point TRUBEAT_FACE_MODEL at a .task file you already have."
        )
    landmarker, mp = _load_landmarker(model_path)
    t, h, w = int(frames.shape[0]), int(frames.shape[1]), int(frames.shape[2])
    landmarks = np.full((t, N_LANDMARKS, 2), np.nan, dtype=np.float32)
    valid = np.zeros(t, dtype=bool)
    try:
        last_ts = -1
        for i in range(t):
            # VIDEO mode demands strictly increasing timestamps.
            ts_ms = max(round(i * 1000.0 / fps), last_ts + 1)
            last_ts = ts_ms
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frames[i])
            result = landmarker.detect_for_video(mp_image, ts_ms)
            if not result.face_landmarks:
                continue
            pts = result.face_landmarks[0]
            if len(pts) != N_LANDMARKS:
                continue
            landmarks[i] = np.array(
                [(p.x * w, p.y * h) for p in pts], dtype=np.float32
            )
            valid[i] = True
    finally:
        landmarker.close()
    return landmarks, valid
