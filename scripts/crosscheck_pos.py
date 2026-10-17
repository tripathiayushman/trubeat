"""Cross-check our POS implementation against the rPPG-Toolbox reference.

Reference: third_party/rppg-toolbox/unsupervised_methods/methods/POS_WANG.py
(Wang et al., 2017 — the same paper we implement in src/trubeat/signal.py).
Reference repo is a clean-room harness only — nothing is copied into src/.
Licence: Responsible AI Source Code v1.1 (see third_party/README.md).

Test: one synthetic 72 bpm pulse video → both implementations' BVP →
Pearson correlation of the two waveforms + each side's bpm readback.
Windowing differs (theirs: 1.6 s sliding overlap-add + 100-sample detrend +
1st-order 0.75–3 Hz butter; ours: global-conditioned s1 + α·s2 with 4th-order
0.7–3 Hz SOS), so we expect high but not perfect correlation on a pure tone.

Run: .venv/bin/python scripts/crosscheck_pos.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "tests"))
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT / "third_party" / "rppg-toolbox"))

import synth  # noqa: E402
from trubeat import hr, ingest, signal  # noqa: E402


def _whole_frame_traces(frames: np.ndarray) -> np.ndarray:
    """Frame-mean RGB as a single-ROI (T,1,3) trace."""
    means = frames.reshape(frames.shape[0], -1, 3).mean(axis=1)
    return means[:, None, :]


def toolbox_pos(frames: np.ndarray, fps: float) -> np.ndarray:
    """Wrap unsupervised_methods.methods.POS_WANG (reference, untouched)."""
    from unsupervised_methods.methods.POS_WANG import POS_WANG as _ref  # type: ignore
    # The reference takes RGB frames of any shape and averages per frame.
    bvp = _ref(frames, fps)
    return np.asarray(bvp).ravel()


def our_pos(frames: np.ndarray, fps: float) -> np.ndarray:
    traces = _whole_frame_traces(frames)
    ppg = signal.extract_ppg(traces, fps, method="pos")
    return ppg[:, 0]


def main() -> None:
    fps = 30.0
    bpm = 72.0
    path = Path("/tmp/opencode/pos_crosscheck/vid.mp4")
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        synth.write_pulse_video(str(path), fps=fps, duration_s=30.0, bpm=bpm)
    stream = ingest.open_video(str(path))
    frames = stream.frames
    print(f"video: {path} ({frames.shape[0]} frames @ {stream.fps} fps)")

    ref = toolbox_pos(frames, stream.fps)
    ours = our_pos(frames, stream.fps)
    n = min(len(ref), len(ours))
    r = float(np.corrcoef(ref[:n], ours[:n])[0, 1])

    gt_bpm = hr.estimate_hr(ours, stream.fps).bpm
    ref_bpm = hr.estimate_hr(ref, stream.fps,
                             band=(0.75, 3.0)).bpm  # reference's own band
    out = {
        "pearson_r": round(r, 4),
        "our_bpm": round(float(gt_bpm), 2),
        "ref_bpm": round(float(ref_bpm), 2),
        "target_bpm": bpm,
    }
    print(out)
    assert abs(gt_bpm - bpm) <= 4.0, f"our POS lost the pulse: {out}"
    assert abs(ref_bpm - bpm) <= 4.0, f"reference POS lost the pulse: {out}"
    assert r > 0.8, f"our POS diverged from the reference: r={out['pearson_r']}"
    print("POSCROSSCHECK_OK")


if __name__ == "__main__":
    main()
