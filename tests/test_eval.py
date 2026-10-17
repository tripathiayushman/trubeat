"""Tests for trubeat.eval: manifest validation, HR/detector eval, reports."""

from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

from trubeat.eval import (
    DetectionReport,
    HRReport,
    _load_gt_hr,
    evaluate_detector,
    evaluate_hr,
    validate_manifest,
    write_report,
)
from trubeat.hr import HRResult
from trubeat.model import Prediction


def _manifest(rows):
    return pd.DataFrame(rows)


def test_validate_manifest_ok():
    m = _manifest(
        [
            {"path": "a.mp4", "label": "real", "split": "train", "split_group": "s1"},
            {"path": "b.mp4", "label": "fake", "split": "train", "split_group": "s2"},
            {"path": "c.mp4", "label": "real", "split": "test", "split_group": "s3"},
            {"path": "d.mp4", "label": "fake", "split": "val", "split_group": "s4"},
        ]
    )
    validate_manifest(m)  # must not raise


def test_validate_manifest_catches_leakage():
    m = _manifest(
        [
            {"path": "a.mp4", "label": "real", "split": "train", "split_group": "s1"},
            # s1 leaks into test:
            {"path": "a_fake.mp4", "label": "fake", "split": "test", "split_group": "s1"},
            {"path": "b.mp4", "label": "fake", "split": "train", "split_group": "s2"},
        ]
    )
    with pytest.raises(ValueError) as exc:
        validate_manifest(m)
    assert "s1" in str(exc.value)
    assert "leakage" in str(exc.value).lower()


def test_validate_manifest_rejects_bad_split_values():
    m = _manifest(
        [{"path": "a.mp4", "label": "real", "split": "holdout", "split_group": "s1"}]
    )
    with pytest.raises(ValueError):
        validate_manifest(m)


def test_validate_manifest_requires_split_column():
    m = _manifest([{"path": "a.mp4", "label": "real", "split_group": "s1"}])
    with pytest.raises(ValueError):
        validate_manifest(m)


def _mock_pipeline(hr_bpm=70.0):
    stream = MagicMock()
    stream.frames = np.zeros((300, 64, 64, 3), np.uint8)
    stream.fps = 30.0
    landmarks = np.zeros((300, 478, 2), np.float32)
    valid = np.ones(300, bool)
    hr_res = HRResult(
        bpm=hr_bpm, confidence=0.9, spectrum=np.array([1.0]), freqs=np.array([1.2])
    )
    return stream, landmarks, valid, hr_res


def test_evaluate_hr_metrics(monkeypatch):
    manifest = _manifest(
        [
            {"path": "s1.mp4", "subject_id": "s1"},
            {"path": "s2.mp4", "subject_id": "s2"},
        ]
    )
    monkeypatch.setattr("trubeat.eval._load_gt_hr", lambda row: 72.0)
    stream, landmarks, valid, hr_res = _mock_pipeline(hr_bpm=70.0)
    with patch("trubeat.eval.ingest") as m_ing, patch(
        "trubeat.eval.face"
    ) as m_face, patch("trubeat.eval.roi") as m_roi, patch(
        "trubeat.eval.signal"
    ) as m_sig, patch(
        "trubeat.eval.hr"
    ) as m_hr:
        m_ing.open_video.return_value = stream
        m_face.track_landmarks.return_value = (landmarks, valid)
        m_roi.extract_roi_means.return_value = np.zeros((300, 3, 3))
        m_sig.extract_ppg.return_value = np.zeros((300, 3))
        m_hr.estimate_hr.return_value = hr_res
        rep = evaluate_hr(manifest, {})
    assert isinstance(rep, HRReport)
    assert rep.mae == pytest.approx(2.0)  # |70 - 72|
    assert rep.rmse == pytest.approx(2.0)
    assert len(rep.per_subject) == 2
    assert list(rep.per_subject["subject_id"]) == ["s1", "s2"]
    assert rep.per_subject["abs_err"].tolist() == pytest.approx([2.0, 2.0])


def test_evaluate_hr_raises_noface_on_nan_bpm(monkeypatch):
    """Never return a silent NaN metric: a row whose face was never tracked
    (all-NaN ppg → NaN bpm) must raise E_NO_FACE, not poison MAE."""
    from trubeat.errors import NoFace

    manifest = _manifest(
        [{"path": "s1.mp4", "subject_id": "s1"}]
    )
    monkeypatch.setattr("trubeat.eval._load_gt_hr", lambda row: 72.0)
    nan_res = HRResult(
        bpm=float("nan"), confidence=0.0,
        spectrum=np.array([]), freqs=np.array([]),
    )
    with patch("trubeat.eval.ingest") as m_ing, patch(
        "trubeat.eval.face"
    ) as m_face, patch("trubeat.eval.roi") as m_roi, patch(
        "trubeat.eval.signal"
    ) as m_sig, patch("trubeat.eval.hr") as m_hr:
        m_ing.open_video.return_value = MagicMock(fps=30.0)
        m_face.track_landmarks.return_value = (
            np.zeros((300, 478, 2)), np.zeros(300, dtype=bool),
        )
        m_roi.extract_roi_means.return_value = np.full((300, 3, 3), np.nan)
        m_sig.extract_ppg.return_value = np.full((300, 3), np.nan)
        m_hr.estimate_hr.return_value = nan_res
        with pytest.raises(NoFace):
            evaluate_hr(manifest, {})


def test_load_gt_hr_ubfc_format(tmp_path):
    gt = tmp_path / "ground_truth.txt"
    gt.write_text(
        "0.1 0.2 0.3 0.4\n"  # PPG waveform
        "70.0 74.0 72.0 74.0\n"  # per-frame HR
        "0.0 0.033 0.066 0.1\n"  # timestamps
    )
    row = pd.Series({"path": str(tmp_path / "vid.avi")})
    assert _load_gt_hr(row) == pytest.approx(72.5)


def _det_manifest():
    return _manifest(
        [
            {"path": "real1.mp4", "label": "real", "split": "test", "split_group": "g1"},
            {"path": "real2.mp4", "label": "real", "split": "test", "split_group": "g2"},
            {"path": "fake1.mp4", "label": "fake", "split": "test", "split_group": "g3"},
            {"path": "fake2.mp4", "label": "fake", "split": "test", "split_group": "g4"},
        ]
    )


def _perfect_predict(path, model, config):
    label = "real" if "real" in path else "fake"
    return Prediction(label=label, confidence=1.0, n_windows=4, votes=[label] * 4)


def test_evaluate_detector_perfect():
    with patch("trubeat.eval.predict_video", side_effect=_perfect_predict):
        rep = evaluate_detector(_det_manifest(), MagicMock(), {})
    assert isinstance(rep, DetectionReport)
    assert rep.accuracy == pytest.approx(1.0)
    assert rep.auc == pytest.approx(1.0)
    assert rep.precision == pytest.approx(1.0)
    assert rep.recall == pytest.approx(1.0)
    assert rep.fpr_on_real == pytest.approx(0.0)  # no real video flagged
    assert rep.confusion == {"tp": 2, "tn": 2, "fp": 0, "fn": 0}
    assert rep.n == 4
    lo, hi = rep.ci["accuracy"]
    assert lo <= 1.0 <= hi


def test_evaluate_detector_counts_false_positives():
    def mixed_predict(path, model, config):
        # real1 wrongly flagged fake; everything else right
        label = "fake" if path in ("real1.mp4", "fake1.mp4", "fake2.mp4") else "real"
        return Prediction(label=label, confidence=0.75, n_windows=4, votes=[label] * 4)

    with patch("trubeat.eval.predict_video", side_effect=mixed_predict):
        rep = evaluate_detector(_det_manifest(), MagicMock(), {})
    assert rep.accuracy == pytest.approx(0.75)
    assert rep.fpr_on_real == pytest.approx(0.5)  # 1 of 2 real videos flagged
    assert rep.confusion["fp"] == 1


def test_evaluate_detector_rejects_leaky_manifest():
    m = _manifest(
        [
            {"path": "a.mp4", "label": "real", "split": "train", "split_group": "s1"},
            {"path": "b.mp4", "label": "fake", "split": "test", "split_group": "s1"},
        ]
    )
    with patch("trubeat.eval.predict_video") as mp:
        with pytest.raises(ValueError):
            evaluate_detector(m, MagicMock(), {})
        mp.assert_not_called()  # fails before any prediction


def test_write_report_detector(tmp_path):
    rep = DetectionReport(
        accuracy=1.0,
        auc=1.0,
        precision=1.0,
        recall=1.0,
        fpr_on_real=0.0,
        confusion={"tp": 2, "tn": 2, "fp": 0, "fn": 0},
        ci={"accuracy": (1.0, 1.0), "auc": (1.0, 1.0)},
        n=4,
    )
    config = {
        "dataset": "ffpp_c23",
        "split_protocol": "GroupKFold on split_group",
        "method": "pos",
        "seed": 7,
    }
    out = tmp_path / "report.md"
    write_report(rep, config, str(out))
    text = out.read_text()
    assert "# Run report" in text
    assert "## Setup" in text
    assert "## Detection" in text
    assert "## Cross-dataset" in text
    assert "## Compression" in text
    assert "## Honesty checklist" in text
    assert "False-positive rate on real videos" in text
    assert "ffpp_c23" in text


def test_write_report_hr(tmp_path):
    rep = HRReport(
        mae=2.0,
        rmse=2.5,
        pearson_r=0.95,
        per_subject=pd.DataFrame(
            {"subject_id": ["s1"], "est_bpm": [70.0], "gt_bpm": [72.0], "abs_err": [2.0]}
        ),
    )
    out = tmp_path / "hr_report.md"
    write_report(rep, {"dataset": "ubfc"}, str(out))
    text = out.read_text()
    assert "## Heart-rate" in text
    assert "MAE" in text
    assert "## Honesty checklist" in text
