"""Multi-region pulse consistency analysis. FR-09."""

import numpy as np
from scipy.signal import coherence

_EPS = 1e-12

# Welch segment length for the coherence estimate. Must be well below the
# window length so more than one segment is averaged (a single segment
# makes the estimator identically 1.0 — a constant, useless feature).
COH_NPERSEG = 128


def _empty_coherence() -> dict:
    return {
        "coh_mean": 0.0,
        "coh_std": 0.0,
        "coh_min": 0.0,
        "coh_max": 0.0,
        "pairs": {},
    }


def coherence_features(ppg_win: np.ndarray, fps: float) -> dict:
    """Pairwise magnitude-squared coherence between ROI signals in a window.

    Args:
        ppg_win: float (W, R) — one window of per-ROI pulse signals
        fps: sampling rate in Hz
    Returns: dict with coherence mean/std/min/max over ROI pairs + per-pair values.
    On a real face the regions rise and fall together (high coherence);
    on a fake they are less consistent.

    Notes:
        - ``coh_mean`` etc. are broadband means: the magnitude-squared
          coherence (``scipy.signal.coherence``) averaged over all frequency
          bins, then aggregated over ROI pairs.
        - **The Welch segment length matters.** With ``nperseg == W`` there is
          a single segment and the estimator degenerates to exactly 1.0 for
          every pair (verified: 10 s windows read coh_mean = 1.0000 with zero
          variance on every FF++ video, real and fake alike — a constant
          feature that carries no information). We therefore use
          ``nperseg = min(COH_NPERSEG, W // 2)`` so at least two Welch
          segments are averaged and the estimate can actually vary.
        - Degenerate inputs (e.g. a constant signal, where coherence is
          undefined and scipy returns NaN) are mapped to 0.0 — there is no
          measurable coherence — rather than propagating NaN (AGENTS.md §5).
        - Fewer than 2 ROIs or fewer than 4 samples → all zeros, empty pairs.
        - Caveat: few segments still give a high-variance, upward-biased
          estimate; prefer longer windows when coherence must discriminate.
          On short clips (FF++ c23 median 16 s) coherence is a weak feature —
          measure it, do not assume it.
    """
    ppg_win = np.asarray(ppg_win, dtype=float)
    if ppg_win.ndim != 2:
        raise ValueError(f"ppg_win must be 2-D (W, R), got shape {ppg_win.shape}")
    n_samp, n_roi = ppg_win.shape
    if n_samp < 4 or n_roi < 2:
        return _empty_coherence()
    # At least two Welch segments, else the estimator is identically 1.0.
    nperseg = max(8, min(COH_NPERSEG, n_samp // 2))
    pairs: dict[tuple[int, int], float] = {}
    vals = []
    for i in range(n_roi):
        for j in range(i + 1, n_roi):
            _, coh = coherence(ppg_win[:, i], ppg_win[:, j], fs=fps, nperseg=nperseg)
            mean_coh = float(np.nan_to_num(np.mean(coh), nan=0.0))
            pairs[(i, j)] = mean_coh
            vals.append(mean_coh)
    vals = np.asarray(vals)
    return {
        "coh_mean": float(vals.mean()),
        "coh_std": float(vals.std()),
        "coh_min": float(vals.min()),
        "coh_max": float(vals.max()),
        "pairs": pairs,
    }


def lag0_correlation(ppg_win: np.ndarray) -> dict:
    """Cross-correlation at lag 0 for every ROI pair → mean/std/min.

    Args:
        ppg_win: float (W, R) — one window of per-ROI pulse signals
    Returns: dict with ``lag0_mean``, ``lag0_std``, ``lag0_min`` over the
        upper-triangle ROI pairs.

    Notes:
        - Pearson r computed manually as ``cov(i,j) / (std_i * std_j + eps)``
          with ``eps=1e-12``. A constant signal has std 0, which makes the
          textbook correlation undefined (0/0 → NaN); the epsilon guard maps
          it to 0.0 (no measurable linear relationship) instead of
          propagating NaN (AGENTS.md §5).
        - Fewer than 2 ROIs or fewer than 2 samples → all zeros.
    """
    ppg_win = np.asarray(ppg_win, dtype=float)
    if ppg_win.ndim != 2:
        raise ValueError(f"ppg_win must be 2-D (W, R), got shape {ppg_win.shape}")
    n_samp, n_roi = ppg_win.shape
    if n_samp < 2 or n_roi < 2:
        return {"lag0_mean": 0.0, "lag0_std": 0.0, "lag0_min": 0.0}
    centered = ppg_win - ppg_win.mean(axis=0, keepdims=True)
    std = centered.std(axis=0)
    cov = (centered.T @ centered) / (n_samp - 1)
    denom = np.outer(std, std) + _EPS
    corr = np.clip(cov / denom, -1.0, 1.0)
    iu = np.triu_indices(n_roi, k=1)
    vals = corr[iu]
    return {
        "lag0_mean": float(vals.mean()),
        "lag0_std": float(vals.std()),
        "lag0_min": float(vals.min()),
    }
