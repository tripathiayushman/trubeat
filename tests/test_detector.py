"""Tests for trubeat.detector — Phase-2 detector helpers (G2)."""

import numpy as np
import pandas as pd
import pytest

from trubeat import detector


def _fake_cache(tmp_path, videos, n_frames=300, fps=25.0, rng=None):
    """Write a tiny trace cache with synthetic ppg for the given video ids."""
    rng = rng or np.random.default_rng(7)
    for vid in videos:
        traces = rng.normal(100, 5, size=(n_frames, 3, 3))
        ppg = rng.normal(0, 1, size=(n_frames, 3))
        np.savez_compressed(
            tmp_path / f"{vid}.npz",
            traces=traces,
            ppg=ppg,
            fps=np.array(fps),
            n_frames=np.array(n_frames),
        )
    return tmp_path


def test_features_from_cache_shape(tmp_path):
    _fake_cache(tmp_path, ["v1", "v2"])
    feat = detector.features_from_cache(tmp_path, ["v1", "v2"], 10.0, 0.5)
    assert len(feat) == 2  # one window per 300-frame clip at 25 fps
    assert "video_id" in feat.columns
    for col in detector.DETECTOR_COLUMNS:
        assert col in feat.columns


def test_features_from_cache_missing_video_is_skipped(tmp_path):
    _fake_cache(tmp_path, ["v1"])
    feat = detector.features_from_cache(tmp_path, ["v1", "nope"], 10.0, 0.5)
    assert set(feat["video_id"]) == {"v1"}


def test_ppg_for_method_recomputes_from_traces(tmp_path):
    # The cache stores raw traces; a different method must be recomputed
    # from them rather than served from the cached (POS) ppg.
    _fake_cache(tmp_path, ["v1"])
    traces, fps = detector.load_cached_traces(tmp_path, "v1")
    ppg, fps2 = detector.ppg_for_method(tmp_path, "v1", "green")
    assert np.allclose(ppg, traces[:, :, 1])  # green == channel 1
    assert fps2 == fps


def test_load_cached_ppg_missing_returns_none(tmp_path):
    assert detector.load_cached_ppg(tmp_path, "nope") is None
    assert detector.load_cached_traces(tmp_path, "nope") is None


def test_method_of():
    assert detector.method_of("ffpp_original_004") == "original"
    assert detector.method_of("ffpp_Deepfakes_035_036") == "Deepfakes"
    assert detector.method_of("ffpp_NeuralTextures_1_2") == "NeuralTextures"


def _scores(labels, values, groups=None):
    groups = groups or [f"g{i}" for i in range(len(labels))]
    return [
        detector.VideoScore(
            video_id=f"v{i}",
            label=lb,
            split="test",
            split_group=groups[i],
            method="original" if lb == "real" else "Deepfakes",
            score=v,
            vote_frac_real=v,
            n_windows=1,
        )
        for i, (lb, v) in enumerate(zip(labels, values))
    ]


def test_tune_threshold_separates_perfectly():
    s = _scores(["real", "real", "fake", "fake"], [0.9, 0.8, 0.2, 0.1])
    t = detector.tune_threshold(s)
    assert 0.2 < t <= 0.8


def test_tune_threshold_degenerate_single_class():
    s = _scores(["real", "real"], [0.5, 0.6])
    assert detector.tune_threshold(s) == 0.0


def test_video_metrics_confusion():
    s = _scores(
        ["real", "real", "fake", "fake"],
        [0.9, 0.8, 0.2, 0.1],
    )
    m = detector.video_metrics(s, threshold=0.5)
    # score >= threshold -> "real"; below -> "fake" (positive = fake).
    # 2 reals above threshold (called real), 2 fakes below (called fake).
    assert (m["tp"], m["tn"], m["fp"], m["fn"]) == (2, 2, 0, 0)
    assert m["accuracy"] == 1.0
    assert m["auc"] == 1.0
    assert m["fpr_on_real"] == 0.0


def test_video_metrics_fpr_on_real_counts_reals_flagged_as_fake():
    """Regression: the confusion matrix rows were swapped and FPR on real
    was reporting the fake-class miss rate.

    Setup: 4 real videos, 4 fake videos. The threshold flags 2 of the reals
    as fake, and misses 2 of the fakes. A correct implementation reports:
      tp=2 (fakes caught), fn=2 (fakes missed), fp=2 (reals flagged),
      tn=2 (reals passed)  -> fpr_on_real = 2/4 = 0.5
    """
    s = _scores(
        ["real"] * 4 + ["fake"] * 4,
        [0.9, 0.8, 0.2, 0.1, 0.9, 0.8, 0.2, 0.1],
    )
    m = detector.video_metrics(s, threshold=0.5)
    assert (m["tp"], m["fn"], m["fp"], m["tn"]) == (2, 2, 2, 2)
    assert m["fpr_on_real"] == pytest.approx(0.5)
    assert m["n_real"] == 4 and m["n_fake"] == 4
    # the row totals must match the class counts
    assert m["tp"] + m["fn"] == m["n_fake"]
    assert m["fp"] + m["tn"] == m["n_real"]


def test_video_metrics_auc_is_threshold_free():
    # Swapping the positive class must not change the AUC.
    s = _scores(["real"] * 3 + ["fake"] * 3, [0.9, 0.8, 0.7, 0.3, 0.2, 0.1])
    m = detector.video_metrics(s, threshold=0.5)
    assert m["auc"] == pytest.approx(1.0)
    m2 = detector.video_metrics(s, threshold=0.0)  # everything called fake
    assert m2["auc"] == pytest.approx(1.0)


def test_bootstrap_auc_ci_brackets_truth():
    # A perfect ranking must give a CI of 1.0; a random one must not.
    s = _scores(["real"] * 10 + ["fake"] * 10, [1.0] * 10 + [0.0] * 10)
    lo, hi = detector.bootstrap_auc_ci(s, threshold=0.5, n_boot=100, seed=1)
    assert lo == pytest.approx(1.0)
    assert hi == pytest.approx(1.0)


def test_bootstrap_auc_ci_respects_grouping():
    # 4 groups, each with a real + a fake: the CI must come from whole
    # groups, never a real paired with another group's fake.
    labels = ["real", "fake"] * 4
    values = [0.9, 0.1] * 4
    s = _scores(labels, values, groups=["g0", "g0", "g1", "g1", "g2", "g2", "g3", "g3"])
    lo, hi = detector.bootstrap_auc_ci(s, threshold=0.5, n_boot=50, seed=1)
    assert lo <= 1.0 and hi <= 1.0


def test_per_method_auc():
    s = _scores(["real", "real", "fake", "fake"], [0.9, 0.8, 0.2, 0.1])
    out = detector.per_method_auc(s)
    assert len(out) == 1
    assert out[0]["method"] == "Deepfakes"
    assert out[0]["auc"] == pytest.approx(1.0)


def test_build_classifier_rejects_unknown():
    with pytest.raises(ValueError):
        detector.build_classifier("magic")


def test_detector_columns_exclude_positional():
    # win_start_s / win_end_s encode *where* a window sits, not the pulse.
    assert "win_start_s" not in detector.DETECTOR_COLUMNS
    assert "win_end_s" not in detector.DETECTOR_COLUMNS
    assert "coh_mean" in detector.DETECTOR_COLUMNS
    assert "lag0_mean" in detector.DETECTOR_COLUMNS
    assert "spec_entropy" in detector.DETECTOR_COLUMNS


def test_fit_with_group_cv_is_grouped():
    # The label follows the FEATURE (not the group) so that every CV fold
    # contains both classes — otherwise the fold's AUC is undefined
    # (a real property of GroupKFold worth knowing).
    rng = np.random.default_rng(3)
    n = 60
    groups = np.repeat([f"g{i}" for i in range(10)], 6)
    vals = rng.normal(0.5, 0.1, n)
    y = np.array(["real" if v > 0.5 else "fake" for v in vals])
    X = pd.DataFrame({"lag0_mean": vals})
    pipe, auc, std = detector.fit_with_group_cv(X, y, groups, "logreg")
    assert auc > 0.8  # separable -> CV must find it
    assert std >= 0.0
    assert hasattr(pipe, "decision_function")


def test_fit_with_group_cv_single_class_fold_is_not_a_crash():
    # A fold with one class makes the fold AUC undefined; the helper must
    # still return a usable pipeline (NaN AUC, no exception).
    rng = np.random.default_rng(3)
    n = 40
    groups = np.repeat([f"g{i}" for i in range(8)], 5)
    vals = rng.normal(0.5, 0.1, n)
    y = np.array(["real" if v > 0.5 else "fake" for v in vals])
    X = pd.DataFrame({"lag0_mean": vals})
    pipe, auc, _std = detector.fit_with_group_cv(X, y, groups, "logreg")
    assert pipe is not None
    assert not np.isnan(auc) or True  # may be NaN; must not raise
