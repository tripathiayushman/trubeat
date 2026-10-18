"""Tests for trubeat.hr: FFT heart-rate estimation."""

import numpy as np
import pytest
from synth import pulse_wave, write_pulse_video
from test_signal import _rgb_traces

from trubeat.hr import HRResult, estimate_hr
from trubeat.signal import condition, extract_ppg

FPS = 30.0


@pytest.mark.parametrize("bpm", [60.0, 72.0, 120.0])
def test_estimate_hr_exact_bins(bpm):
    # 30 s window: these bpms land exactly on FFT bins.
    s = pulse_wave(int(30 * FPS), FPS, bpm)
    res = estimate_hr(s, FPS)
    assert isinstance(res, HRResult)
    assert abs(res.bpm - bpm) <= 1.0
    assert res.confidence > 0.9  # pure tone: nearly all power in one bin


def test_estimate_hr_sub_bin_parabolic():
    # 75 bpm = 1.25 Hz falls between 0.1 Hz bins of a 10 s window;
    # parabolic interpolation must still land within ±1 bpm.
    s = pulse_wave(int(10 * FPS), FPS, 75.0)
    res = estimate_hr(s, FPS)
    assert abs(res.bpm - 75.0) <= 1.0


def test_estimate_hr_tolerates_nan_gap():
    s = pulse_wave(int(30 * FPS), FPS, 72.0)
    s[400:430] = np.nan
    res = estimate_hr(s, FPS)
    assert abs(res.bpm - 72.0) <= 1.0


def test_estimate_hr_all_nan():
    res = estimate_hr(np.full(900, np.nan), FPS)
    assert np.isnan(res.bpm)
    assert res.confidence == 0.0


def test_estimate_hr_rejects_non_1d():
    with pytest.raises(ValueError):
        estimate_hr(np.zeros((100, 2)), FPS)


@pytest.mark.parametrize("method", ["chrom", "pos"])
def test_chrom_pos_ramp_bpm_recovered(method):
    # End-to-end on arrays: single-channel illumination ramp must not
    # move the recovered heart rate.
    traces, _ = _rgb_traces(900, FPS, 72.0, r_ramp=40.0)
    ppg = extract_ppg(traces, FPS, method=method)
    res = estimate_hr(ppg[:, 0], FPS)
    assert abs(res.bpm - 72.0) <= 1.0, f"{method}: {res.bpm:.2f} bpm"


@pytest.mark.parametrize("method", ["green", "pos"])
def test_video_level_bpm_coherent(tmp_path, method):
    cv2 = pytest.importorskip("cv2")
    path = tmp_path / "coherent.mp4"
    write_pulse_video(path, fps=30.0, duration_s=10.0, bpm=72.0)

    cap = cv2.VideoCapture(str(path))
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS))
        assert fps > 0, "could not read fps from synthetic video"
        bgr_means = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            bgr_means.append(frame.mean(axis=(0, 1)))
    finally:
        cap.release()
    bgr = np.asarray(bgr_means)
    assert bgr.shape[0] >= 150, f"only decoded {bgr.shape[0]} frames"

    # BGR (cv2) -> RGB traces, whole frame as one ROI.
    traces = np.empty((bgr.shape[0], 1, 3))
    traces[:, 0, 0] = bgr[:, 2]  # R
    traces[:, 0, 1] = bgr[:, 1]  # G
    traces[:, 0, 2] = bgr[:, 0]  # B

    ppg = extract_ppg(traces, fps, method=method)
    sig = ppg[:, 0]
    if method == "green":
        sig = condition(sig, fps)  # green comes back raw; condition it
    res = estimate_hr(sig, fps)
    # mp4v is lossy: allow ±4 bpm at video level.
    assert abs(res.bpm - 72.0) <= 4.0, f"{method}: {res.bpm:.2f} bpm"


def test_estimate_hr_harmonic_picker_no_halving():
    """
    Regression test for harmonic-picker: a signal with a true peak at f
    and a sub-harmonic artifact at f/2 (power > 25% of fundamental)
    must NOT be halved. Previously the picker preferred f/2 when
    fundamental was merely > 25% of harmonic power; now it only prefers
    f/2 when fundamental DOMINATES (power > harmonic).
    """
    # Build a synthetic signal: fundamental at 1.67 Hz (100 bpm) with
    # a sub-harmonic at 0.83 Hz (50 bpm) at 40% power.
    FPS = 30.0
    T = 30 * FPS  # 30 s
    t = np.arange(T) / FPS
    f0 = 1.6667  # 100 bpm
    f1 = f0 / 2  # 50 bpm
    s = np.sin(2 * np.pi * f0 * t) + 0.4 * np.sin(2 * np.pi * f1 * t)
    res = estimate_hr(s, FPS, band=(0.7, 3.0))
    # Must pick the true fundamental (~100 bpm), not the sub-harmonic (~50 bpm)
    assert abs(res.bpm - 100.0) <= 1.0, f"harmonic halving: got {res.bpm:.1f} bpm"
    assert res.confidence > 0.2
