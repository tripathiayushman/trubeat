"""Tests for trubeat.app — the web app's analysis + verdict logic.

The verdict logic is pure (no Gradio), so it is tested directly. The
integration test runs the real pipeline on a synthetic video; it skips
when the MediaPipe face model is not available (CI).
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth

from trubeat import app as app_mod
from trubeat.app import PulseAnalysis, VerdictThresholds, verdict_for

THR = VerdictThresholds(
    min_duration_s=10.0,
    min_face_valid_frac=0.70,
    min_snr=10.0,
    max_agreement_bpm=5.0,
    detector_threshold=0.0,
)


def _analysis(**kw) -> PulseAnalysis:
    """A healthy analysis; override fields per test."""
    base = {
        "verdict": "inconclusive",
        "headline": "",
        "detail": "",
        "per_roi_hr": [70.0, 70.2, 69.8],
        "roi_names": ["forehead", "cheek_l", "cheek_r"],
        "agreement_bpm": 0.2,
        "face_valid_frac": 1.0,
        "mean_snr": 40.0,
        "duration_s": 30.0,
        "n_frames": 900,
        "detector_score": 1.0,
        "detector_available": True,
        "degraded": False,
    }
    base.update(kw)
    return PulseAnalysis(**base)


# ---------------------------------------------------------------- verdict ---


def test_verdict_real_when_pulse_consistent_and_score_above():
    a = verdict_for(_analysis(detector_score=1.0), THR)
    assert a.verdict == "real"
    assert a.headline.startswith("Pulse consistent")
    assert "likely real" in a.headline


def test_verdict_real_but_regions_disagree_does_not_claim_agreement():
    # The headline must not claim the regions agree when the measurement
    # says otherwise — that would be a false statement in the UI.
    a = verdict_for(
        _analysis(detector_score=1.0, agreement_bpm=THR.max_agreement_bpm + 5.0),
        THR,
    )
    assert a.verdict == "real"
    assert "Pulse consistent" not in a.headline
    assert "disagree" in a.headline


def test_verdict_fake_without_inconsistency_does_not_claim_the_signature():
    # Detector says fake but the regions agree: report the call without
    # inventing a pulse-inconsistency story.
    a = verdict_for(
        _analysis(detector_score=-1.0, agreement_bpm=0.5), THR
    )
    assert a.verdict == "fake"
    assert "pixel-replacement pattern detected" not in a.headline
    assert "another manipulation family" in a.detail


def test_verdict_fake_when_score_below_threshold():
    a = verdict_for(
        _analysis(detector_score=-1.0, agreement_bpm=THR.max_agreement_bpm + 5.0),
        THR,
    )
    assert a.verdict == "fake"
    assert a.headline.startswith("Pulse inconsistent")
    assert "pixel-replacement" in a.headline


def test_verdict_boundary_score_exactly_at_threshold_is_real():
    # score >= threshold -> real (the boundary belongs to the real side).
    a = verdict_for(_analysis(detector_score=THR.detector_threshold), THR)
    assert a.verdict == "real"


def test_verdict_boundary_score_just_below_threshold_is_fake():
    a = verdict_for(_analysis(detector_score=THR.detector_threshold - 1e-9), THR)
    assert a.verdict == "fake"


def test_verdict_boundary_agreement_exactly_at_max_is_consistent():
    a = verdict_for(
        _analysis(agreement_bpm=THR.max_agreement_bpm, detector_score=1.0), THR
    )
    assert a.verdict == "real"


def test_verdict_boundary_agreement_just_over_max_is_fake_not_inconclusive():
    # A readable pulse with disagreeing regions is a *fake* verdict, not an
    # inconclusive one: the QC passed, so we do have something to say.
    a = verdict_for(
        _analysis(agreement_bpm=THR.max_agreement_bpm + 0.1, detector_score=-1.0),
        THR,
    )
    assert a.verdict == "fake"
    assert "do not agree on one pulse" in a.detail


def test_verdict_boundary_face_valid_frac_exactly_at_min_is_ok():
    a = verdict_for(
        _analysis(face_valid_frac=THR.min_face_valid_frac, detector_score=1.0), THR
    )
    assert a.verdict == "real"


def test_verdict_boundary_face_valid_frac_just_below_min_is_inconclusive():
    a = verdict_for(
        _analysis(face_valid_frac=THR.min_face_valid_frac - 0.01), THR
    )
    assert a.verdict == "inconclusive"
    assert "face tracked in only" in a.detail


def test_verdict_boundary_snr_exactly_at_min_is_ok():
    a = verdict_for(_analysis(mean_snr=THR.min_snr, detector_score=1.0), THR)
    assert a.verdict == "real"


def test_verdict_boundary_snr_just_below_min_is_inconclusive():
    a = verdict_for(_analysis(mean_snr=THR.min_snr - 0.01), THR)
    assert a.verdict == "inconclusive"
    assert "no measurable pulse" in a.detail


def test_verdict_boundary_duration_exactly_at_min_is_ok():
    a = verdict_for(
        _analysis(duration_s=THR.min_duration_s, detector_score=1.0), THR
    )
    assert a.verdict == "real"


def test_verdict_boundary_duration_just_below_min_is_inconclusive():
    a = verdict_for(_analysis(duration_s=THR.min_duration_s - 0.1), THR)
    assert a.verdict == "inconclusive"
    assert "shorter than" in a.detail


def test_verdict_no_face_is_inconclusive():
    a = verdict_for(_analysis(face_valid_frac=0.0), THR)
    assert a.verdict == "inconclusive"
    assert "no face was tracked" in a.detail


def test_verdict_no_agreement_estimate_is_inconclusive():
    a = verdict_for(_analysis(agreement_bpm=None), THR)
    assert a.verdict == "inconclusive"
    assert "heart rate in enough regions" in a.detail


def test_verdict_qc_gates_beat_the_detector():
    # Even a decisive detector score must not override a failed QC gate.
    a = verdict_for(
        _analysis(mean_snr=0.0, detector_score=-99.0), THR
    )
    assert a.verdict == "inconclusive"


def test_verdict_degraded_mode_without_detector():
    # No model: the pulse is still measured, but no real/fake claim is made.
    a = verdict_for(
        _analysis(detector_score=None, detector_available=False, degraded=True), THR
    )
    assert a.verdict == "inconclusive"
    assert "no detector model" in a.headline
    assert "W_NO_DETECTOR" in a.warnings


def test_verdict_inconclusive_lists_a_warning_per_reason():
    a = verdict_for(
        _analysis(duration_s=5.0, face_valid_frac=0.1, mean_snr=0.0), THR
    )
    assert a.verdict == "inconclusive"
    assert len([w for w in a.warnings if w.startswith("W_QC")]) >= 3


def test_caveat_states_the_measured_envelope():
    assert "0.73" in app_mod.CAVEAT
    assert "Deepfakes" in app_mod.CAVEAT
    assert "Face2Face" in app_mod.CAVEAT
    assert "NeuralTextures" in app_mod.CAVEAT
    assert "reports/g2_detector.md" in app_mod.CAVEAT


def test_thresholds_live_in_one_place():
    # Every threshold the verdict uses is a field of VerdictThresholds.
    fields = {f for f in VerdictThresholds.__dataclass_fields__}
    assert {
        "min_duration_s",
        "min_face_valid_frac",
        "min_snr",
        "max_agreement_bpm",
        "detector_threshold",
    } <= fields


def test_load_detector_returns_none_when_missing(tmp_path):
    assert app_mod.load_detector(tmp_path / "nope.joblib") is None


def test_load_detector_reads_a_bundle(tmp_path):
    import joblib

    p = tmp_path / "m.joblib"
    joblib.dump({"model": object(), "threshold": -0.5}, p)
    bundle = app_mod.load_detector(p)
    assert bundle is not None
    assert bundle["threshold"] == -0.5


# ------------------------------------------------------------ integration ---


def _has_face_model() -> bool:
    from trubeat import face as face_mod

    try:
        return face_mod.resolve_model_path().is_file()
    except RuntimeError:
        return False


needs_model = pytest.mark.skipif(
    not _has_face_model(), reason="face_landmarker.task not downloaded"
)


@needs_model
def test_integration_synthetic_video_runs_the_pipeline(tmp_path):
    """A synthetic pulse video has no face: the pipeline must run end to
    end and return an inconclusive verdict with the reason, not crash."""
    p = synth.write_pulse_video(tmp_path / "v.mp4", fps=30.0, duration_s=12.0)
    a = app_mod.analyze_video(p, config={"method": "green"})
    assert a.verdict == "inconclusive"
    assert "no face was tracked" in a.detail
    assert a.duration_s == pytest.approx(12.0, abs=0.5)
    assert a.face_valid_frac == 0.0
    assert a.detector_available is True  # the model exists
    assert len(a.roi_waveforms) == 3  # the plot data was produced anyway
    assert "W_QC" in " ".join(a.warnings)


@needs_model
def test_integration_short_video_is_inconclusive(tmp_path):
    p = synth.write_pulse_video(tmp_path / "short.mp4", fps=30.0, duration_s=4.0)
    a = app_mod.analyze_video(p, config={"method": "green"})
    assert a.verdict == "inconclusive"


def test_integration_missing_file_is_inconclusive_not_a_crash(tmp_path):
    a = app_mod.analyze_video(tmp_path / "does_not_exist.mp4")
    assert a.verdict == "inconclusive"
    assert "E_UNREADABLE" in a.warnings


def test_cli_exposes_serve():
    # The subparser exists (its presence is what the user-facing command needs).
    from trubeat import cli

    src = Path(cli.__file__).read_text()
    assert '"serve"' in src
    assert '"--share"' in src
