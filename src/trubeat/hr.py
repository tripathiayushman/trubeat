"""Heart-rate estimation from the pulse waveform. FR-08."""

from dataclasses import dataclass, field

import numpy as np
from scipy.signal import detrend


@dataclass
class HRResult:
    bpm: float
    confidence: float  # peak in-band power / total in-band power
    spectrum: np.ndarray = field(repr=False)  # in-band power spectrum
    freqs: np.ndarray = field(repr=False)  # in-band frequencies (Hz)


def _interp_nans(x: np.ndarray) -> np.ndarray:
    """Linearly interpolate NaN gaps so a few dropped frames can't poison
    the spectrum. Leading/trailing NaNs take the nearest valid value."""
    x = x.copy()
    nans = np.isnan(x)
    if np.any(nans) and not np.all(nans):
        idx = np.arange(x.shape[0])
        x[nans] = np.interp(idx[nans], idx[~nans], x[~nans])
    return x


def estimate_hr(
    ppg: np.ndarray, fps: float, band: tuple[float, float] = (0.7, 3.0)
) -> HRResult:
    """FFT peak-pick inside the pulse band → bpm, with harmonic awareness.

    The spectrum's strongest in-band bin is refined with parabolic
    interpolation for sub-bin accuracy; bpm = peak_freq_hz * 60.
    Confidence is the peak bin's power over the total in-band power
    (1.0 for a pure tone, near 0 for noise).

    If the top peak is at f and a sub-harmonic (f/2, f/3) is also a
    significant in-band peak, prefer the sub-harmonic — this prevents
    POS/CHROM from locking onto the 2nd harmonic when the fundamental
    is weak but present (known failure mode on low-SNR forehead traces).

    A 10 s window at 30 fps gives 0.1 Hz bins (6 bpm steps); prefer 30 s
    windows (2 bpm steps) when reporting HR. If no frequency bin falls in
    the band, bpm is NaN with 0 confidence.
    """
    x = np.asarray(ppg, dtype=float)
    if x.ndim != 1:
        raise ValueError(f"estimate_hr expects a 1-D PPG signal, got shape {x.shape}")
    if x.shape[0] < 4:
        raise ValueError("estimate_hr needs at least 4 samples")
    x = _interp_nans(x)
    if not np.all(np.isfinite(x)):
        # Degenerate input (e.g. no valid frames at all): NaN bpm, 0 confidence.
        return HRResult(bpm=float("nan"), confidence=0.0,
                        spectrum=np.array([]), freqs=np.array([]))
    x = detrend(x, type="linear")

    n = x.shape[0]
    power = np.abs(np.fft.rfft(x)) ** 2
    freqs = np.fft.rfftfreq(n, d=1.0 / fps)
    lo, hi = float(band[0]), float(band[1])
    mask = (freqs >= lo) & (freqs <= hi)
    f, p = freqs[mask], power[mask]
    if p.size == 0 or not np.all(np.isfinite(p)):
        return HRResult(bpm=float("nan"), confidence=0.0, spectrum=p, freqs=f)

    # Candidate peaks: all local maxima above 10% of global max
    from scipy.signal import find_peaks
    peaks, _ = find_peaks(p, height=np.max(p) * 0.1, distance=max(2, int(0.1 / df)) if (df := (f[1] - f[0] if f.size > 1 else 0)) > 0 else 2)
    if peaks.size == 0:
        # Fallback to single-bin argmax
        k = int(np.argmax(p))
        f_peak = float(f[k])
    else:
        # Rank candidates by power; check if top peak is a harmonic of a lower candidate
        peak_freqs = f[peaks]
        peak_powers = p[peaks]
        order = np.argsort(peak_powers)[::-1]  # strongest first
        f_peak = None
        for idx in order:
            fk = peak_freqs[idx]
            pk = peak_powers[idx]
            # Is fk a harmonic (2x or 3x) of a lower-frequency in-band candidate?
            harmonic_of = None
            for jdx in order:
                if jdx == idx:
                    continue
                fj = peak_freqs[jdx]
                # Check 2x and 3x harmonic relationship (tolerance: 1 bin)
                if abs(fk - 2 * fj) <= df * 1.5 or abs(fk - 3 * fj) <= df * 1.5:
                    harmonic_of = fj
                    break
            if harmonic_of is None:
                f_peak = float(fk)
                break
            # fk is a harmonic; if the fundamental is strong enough, prefer it
            if peak_powers[np.where(peaks == np.where(f == harmonic_of)[0][0])[0][0]] >= pk * 0.25:
                f_peak = float(harmonic_of)
                break
        if f_peak is None:
            f_peak = float(peak_freqs[order[0]])  # give up, take strongest

    # Parabolic refinement around the chosen peak
    k = int(np.argmin(np.abs(f - f_peak)))
    if 0 < k < p.size - 1:
        y0, y1, y2 = p[k - 1], p[k], p[k + 1]
        denom = y0 - 2.0 * y1 + y2
        delta = 0.5 * (y0 - y2) / denom if denom != 0.0 else 0.0
        delta = max(-1.0, min(1.0, delta))
    else:
        delta = 0.0
    df = float(f[1] - f[0]) if f.size > 1 else 0.0
    f_peak = float(f_peak + delta * df)

    total = float(np.sum(p))
    confidence = float(p[k] / total) if total > 0.0 else 0.0
    return HRResult(bpm=f_peak * 60.0, confidence=confidence, spectrum=p, freqs=f)
