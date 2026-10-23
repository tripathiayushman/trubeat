"""Tests for ingest.open_video — all synthetic, no real data."""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth

from trubeat.errors import LowFps, ShortVideo, UnreadableVideo
from trubeat.ingest import VideoStream, _choose_fps, open_video


def test_open_valid_video(tmp_path):
    p = synth.write_pulse_video(tmp_path / "v.mp4", fps=30.0, duration_s=10.0)
    vs = open_video(str(p))
    assert isinstance(vs, VideoStream)
    assert vs.frames.shape == (300, 240, 320, 3)
    assert vs.frames.dtype == np.uint8
    assert vs.fps == pytest.approx(30.0, abs=0.5)
    assert vs.n_frames == 300
    assert vs.width == 320 and vs.height == 240
    assert vs.duration_s == pytest.approx(10.0, abs=0.2)


def test_frames_are_rgb_not_bgr(tmp_path):
    # synth writes BGR with R=base+10, B=base-20; after BGR->RGB,
    # channel 0 (R) must be brighter than channel 2 (B).
    p = synth.write_pulse_video(tmp_path / "v.mp4")
    vs = open_video(str(p))
    assert vs.frames[..., 0].mean() > vs.frames[..., 2].mean() + 10.0


def test_corrupt_bytes_raise_unreadable(tmp_path):
    p = synth.write_corrupt_video(tmp_path / "bad.mp4")
    with pytest.raises(UnreadableVideo):
        open_video(str(p))


def test_missing_file_raises_unreadable(tmp_path):
    with pytest.raises(UnreadableVideo):
        open_video(str(tmp_path / "does_not_exist.mp4"))


def test_short_video_raises(tmp_path):
    p = synth.write_pulse_video(tmp_path / "short.mp4", fps=30.0, duration_s=3.0)
    with pytest.raises(ShortVideo):
        open_video(str(p))


def test_low_fps_raises(tmp_path):
    p = synth.write_pulse_video(tmp_path / "slow.mp4", fps=10.0, duration_s=10.0)
    with pytest.raises(LowFps):
        open_video(str(p))


def test_tall_video_is_downscaled(tmp_path):
    # A 1080p clip decoded at native size is 5.8 GB for ~900 frames and
    # OOM-kills the process on a small machine. open_video must cap the
    # decoded frame height (aspect preserved, never upscaled).
    cv2 = pytest.importorskip("cv2")
    p = tmp_path / "tall.mp4"
    w, h, n = 320, 1080, 330
    writer = cv2.VideoWriter(str(p), cv2.VideoWriter_fourcc(*"mp4v"), 30.0, (w, h))
    for i in range(n):
        writer.write(np.full((h, w, 3), i % 255, dtype=np.uint8))
    writer.release()

    vs = open_video(str(p))
    assert vs.frames.shape[1] == 480, "frame height not capped"
    assert vs.frames.shape[2] == pytest.approx(w * 480 / h, abs=2)
    # Aspect ratio preserved (within rounding).
    assert vs.frames.shape[2] / vs.frames.shape[1] == pytest.approx(w / h, rel=0.02)


def test_downscale_never_upscales(tmp_path):
    # A 240p clip must stay 240p — capping height must not blow it up.
    p = synth.write_pulse_video(tmp_path / "small.mp4")
    vs = open_video(str(p))
    assert vs.frames.shape[1] == 240
    assert vs.frames.shape[2] == 320


def test_native_resolution_when_frame_height_none(tmp_path):
    cv2 = pytest.importorskip("cv2")
    p = tmp_path / "tall.mp4"
    w, h, n = 160, 720, 330
    writer = cv2.VideoWriter(str(p), cv2.VideoWriter_fourcc(*"mp4v"), 30.0, (w, h))
    for i in range(n):
        writer.write(np.full((h, w, 3), 128, dtype=np.uint8))
    writer.release()

    vs = open_video(str(p), frame_height=None)
    assert vs.frames.shape[1] == h
    assert vs.frames.shape[2] == w


def test_oversized_decode_raises_instead_of_oom(tmp_path):
    # A declared frame count that would exceed the byte budget must fail
    # loudly (E_UNREADABLE) rather than let the kernel OOM-kill us.
    cv2 = pytest.importorskip("cv2")
    p = tmp_path / "big.mp4"
    w, h, n = 320, 240, 330
    writer = cv2.VideoWriter(str(p), cv2.VideoWriter_fourcc(*"mp4v"), 30.0, (w, h))
    for i in range(n):
        writer.write(np.zeros((h, w, 3), dtype=np.uint8))
    writer.release()

    import trubeat.ingest as ingest_mod

    original = ingest_mod.MAX_DECODED_BYTES
    ingest_mod.MAX_DECODED_BYTES = 1024  # force the budget to be exceeded
    try:
        with pytest.raises(UnreadableVideo):
            open_video(str(p), frame_height=None)
    finally:
        ingest_mod.MAX_DECODED_BYTES = original


# --------------------------------------------------- _choose_fps unit tests


def test_choose_fps_keeps_metadata_when_it_agrees():
    # Sane container: metadata 30, timestamps ~30 -> trust metadata.
    # 300 frames spanning 0..9900 ms: (300 - 1) / 9.9 s = 30.2 fps.
    assert _choose_fps(30.0, 300, 0.0, 9900.0) == 30.0


def test_choose_fps_wins_when_metadata_is_1000():
    # A real tab capture: metadata 1000, timestamps ~29 fps -> timestamps.
    # 571 frames spanning 0..19875 ms: 570 / 19.875 s = 28.68 fps.
    chosen = _choose_fps(1000.0, 571, 0.0, 19875.0)
    assert chosen == pytest.approx(28.68, abs=0.01)


def test_choose_fps_wins_on_disagreement_beyond_tolerance():
    # Metadata 25 vs timestamps 40 (> 20% apart): the decider is sane.
    # 201 frames spanning 0..5000 ms -> 200 / 5 s = 40 fps.
    assert _choose_fps(25.0, 201, 0.0, 5000.0) == pytest.approx(40.0, abs=0.01)


def test_choose_fps_falls_back_without_timestamps():
    # Timestamps absent/zero (single frame, or all-zero PTS): metadata.
    assert _choose_fps(30.0, 1, 0.0, 0.0) == 30.0
    assert _choose_fps(30.0, 480, 0.0, 0.0) == 30.0
    assert _choose_fps(30.0, 300, None, None) == 30.0
    assert _choose_fps(30.0, 300, 1200.0, 1200.0) == 30.0
