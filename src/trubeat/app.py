"""TrueBeat web app — one-click analysis over the existing pipeline.

This module has two clearly separated halves:

* **Analysis** (:func:`analyze_video`, :func:`verdict_for`) — pure Python,
  no UI dependency. It runs exactly the pipeline the CLI runs
  (ingest → face → ROI → signal → features → predict) and turns the result
  into a three-state verdict with its evidence. A future browser extension
  can call :func:`analyze_video` over HTTP (Gradio's built-in API exposes
  it) without touching the UI code.

* **Interface** (:func:`build_demo`, :func:`main`) — Gradio wiring, imported
  lazily so that importing this module (and running its tests) does not
  require Gradio to be installed.

The verdict logic and every threshold it uses live in
:class:`VerdictThresholds` — one place, unit-tested.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from . import face, features, hr, ingest, roi, signal
from .errors import TrueBeatError

# Where the trained G2 detector is looked up (see scripts/train_g2.py).
# Search order:
#   1. repo checkout paths — lets a locally retrained bundle override the
#      pinned one by dropping `models/detector.joblib` at the repo root;
#   2. the packaged copy — so a pip-installed tool (e.g. a Hugging Face
#      Space) runs the same detector without any checkout beside it.
MODEL_SEARCH_PATHS = [
    Path("models/detector.joblib"),
    Path("data/models/detector.joblib"),
    Path(__file__).parent / "models" / "detector.joblib",
]
# None means "search MODEL_SEARCH_PATHS in order".
DEFAULT_MODEL_PATH = None

# Always-visible honesty caveat (G2's measured operating envelope).
CAVEAT = (
    "Detects face-swap-style fakes (research AUC 0.73 on the Deepfakes "
    "family). Cannot detect reenactment fakes (Face2Face, NeuralTextures) "
    "— those keep the original pulse. Details: reports/g2_detector.md."
)

# Analysis is capped so a long upload cannot run for an hour.
MAX_ANALYSIS_SECONDS = 120.0


@dataclass(frozen=True)
class VerdictThresholds:
    """Every threshold the three-state verdict uses, in one place.

    The QC gates come from the project's own rules (docs/04 §8):
    ``E_SHORT_VIDEO`` at 10 s and ``W_UNSTABLE_TRACK`` below 70% face
    tracking. The signal gates are calibrated against measurements:

    * ``min_snr`` — the cached-trace SNR (peak/mean in-band power). Videos
      with no measurable pulse read ~0; videos with a pulse read 25-75
      (FF++ usable median ~33, UBFC 48-75). 10 sits an order of magnitude
      above noise and far below any real pulse.
    * ``max_agreement_bpm`` — the spread of the per-ROI heart rates of one
      face. When the pulse is visible the regions agree closely (UBFC
      subject1: 0.03 bpm); when one region locks onto a different peak the
      spread jumps (subject16: 21.4 bpm). 5 bpm separates "all regions
      agree" from "they do not".
    """

    min_duration_s: float = 10.0
    min_face_valid_frac: float = 0.70
    min_snr: float = 10.0
    max_agreement_bpm: float = 5.0
    # Operating threshold of the real/fake decision, taken from the G2 run
    # (tuned on the validation split, never on test).
    detector_threshold: float = 0.0


# The default thresholds, with the G2 threshold filled in from the model
# bundle when one is available.
DEFAULT_THRESHOLDS = VerdictThresholds()


@dataclass
class PulseAnalysis:
    """Everything the verdict and the UI need, from one video."""

    verdict: str  # "real" | "fake" | "inconclusive"
    headline: str  # one-line, human-readable verdict
    detail: str  # why
    per_roi_hr: list[float] = field(default_factory=list)
    roi_names: list[str] = field(default_factory=list)
    agreement_bpm: float | None = None
    face_valid_frac: float = 0.0
    mean_snr: float = 0.0
    duration_s: float = 0.0
    n_frames: int = 0
    detector_score: float | None = None  # mean decision value (positive = real)
    detector_available: bool = False
    degraded: bool = False  # no detector model -> pulse/HR analyzer only
    warnings: list[str] = field(default_factory=list)
    roi_waveforms: list[list[float]] = field(default_factory=list)  # 3 x T
    waveform_names: list[str] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(asdict(self), default=float)


def _roi_names(config: dict) -> list[str]:
    names = config.get("rois") or list(roi.ROI_DEFS_P1)
    return [str(n) for n in names]


def load_detector(model_path: Path | str | None = DEFAULT_MODEL_PATH):
    """Load the trained G2 detector bundle, or None if it is not available.

    The app degrades gracefully: without a detector it still measures the
    pulse (heart rate, inter-region agreement, QC) and says so.
    """
    if model_path is not None:
        candidates = [Path(model_path)]
    else:
        candidates = list(MODEL_SEARCH_PATHS)
    for path in candidates:
        if not path.is_file():
            continue
        try:
            import joblib

            bundle = joblib.load(path)
        except Exception as exc:  # noqa: BLE001 — a broken bundle must not break the app
            print(f"warning: could not load detector {path}: {exc}")
            continue
        if isinstance(bundle, dict) and "model" in bundle:
            bundle.setdefault("_path", str(path))
            return bundle
        return {"model": bundle, "config": {}, "threshold": 0.0, "_path": str(path)}
    return None


def analyze_video(
    video_path: str | Path,
    config: dict | None = None,
    model_path: Path | str | None = DEFAULT_MODEL_PATH,
    thresholds: VerdictThresholds | None = None,
    max_seconds: float = MAX_ANALYSIS_SECONDS,
) -> PulseAnalysis:
    """Run the full pipeline on one video and return the analysis.

    Uses exactly the same modules the CLI uses: ``ingest.open_video`` →
    ``face.track_landmarks`` → ``roi.extract_roi_means`` →
    ``signal.extract_ppg`` → ``features.window_features`` → the G2 detector.

    Never raises for bad input: a video that cannot be analysed comes back
    as an ``inconclusive`` analysis with the reason in ``detail``.
    """
    config = dict(config or {})
    thr = thresholds or DEFAULT_THRESHOLDS
    path = Path(video_path)

    # ---- ingest (errors become an inconclusive verdict, never a crash) ----
    try:
        stream = ingest.open_video(
            str(path),
            frame_height=config.get("frame_height", ingest.DEFAULT_FRAME_HEIGHT),
        )
    except TrueBeatError as exc:
        a = PulseAnalysis(
            verdict="inconclusive",
            headline="Inconclusive — could not read the video",
            detail=f"{exc.code}: {exc}",
        )
        a.warnings.append(f"{exc.code}")
        return a
    except Exception as exc:  # noqa: BLE001 — the app must not crash
        a = PulseAnalysis(
            verdict="inconclusive",
            headline="Inconclusive — could not read the video",
            detail=f"unreadable video: {exc}",
        )
        a.warnings.append("E_UNREADABLE")
        return a

    duration = float(stream.duration_s)
    if duration > max_seconds:
        # Analyse the first `max_seconds` of the clip (frames are decoded
        # from the container, so we simply use the leading window).
        keep = int(max_seconds * stream.fps)
        frames = stream.frames[:keep]
        fps = stream.fps
    else:
        frames = stream.frames
        fps = stream.fps

    # ---- the detector bundle decides the rPPG method and window ---------
    # (the bundle was trained with a specific method; using the config's
    # method instead would silently feed the model the wrong features).
    bundle = load_detector(model_path)
    if bundle is not None:
        method = str(bundle.get("method") or config.get("method", "green"))
        win_s = float(bundle.get("window_s", config.get("window_s", 10.0)))
    else:
        method = str(config.get("method", "green"))
        win_s = float(config.get("window_s", 10.0))

    # ---- face → ROI → signal -------------------------------------------
    landmarks, valid = face.track_landmarks(frames, fps)
    face_valid_frac = float(np.mean(valid)) if len(valid) else 0.0
    traces = roi.extract_roi_means(
        frames, landmarks, valid, config.get("roi_defs", roi.ROI_DEFS_P1)
    )
    ppg = signal.extract_ppg(traces, fps, method=method)
    names = _roi_names(config)

    # ---- QC + per-region heart rate ------------------------------------
    per_roi_hr: list[float] = []
    for r in range(ppg.shape[1]):
        res = hr.estimate_hr(ppg[:, r], fps, band=tuple(config.get("band", (0.7, 3.0))))
        per_roi_hr.append(float(res.bpm) if np.isfinite(res.bpm) else float("nan"))
    finite = [b for b in per_roi_hr if np.isfinite(b)]
    agreement = float(np.std(finite)) if len(finite) > 1 else None
    mean_snr = _mean_snr(ppg, fps)

    # ---- detector (optional) -------------------------------------------
    detector_score: float | None = None
    degraded = bundle is None
    if bundle is not None:
        try:
            feat = features.window_features(
                ppg, fps,
                win_s=win_s,
                overlap=float(config.get("overlap", 0.5)),
            )
            cols = bundle.get("feature_columns") or list(features.FEATURE_COLUMNS)
            if len(feat) and all(c in feat.columns for c in cols):
                det = bundle["model"]
                dec = np.asarray(det.decision_function(feat[cols]), dtype=float).ravel()
                detector_score = float(np.mean(dec)) if dec.size else None
                thr = VerdictThresholds(
                    min_duration_s=thr.min_duration_s,
                    min_face_valid_frac=thr.min_face_valid_frac,
                    min_snr=thr.min_snr,
                    max_agreement_bpm=thr.max_agreement_bpm,
                    detector_threshold=float(bundle.get("threshold", thr.detector_threshold)),
                )
        except Exception as exc:  # noqa: BLE001 — never crash the app
            degraded = True
            detector_score = None
            bundle = None
            config.setdefault("_detector_error", str(exc))

    analysis = PulseAnalysis(
        verdict="inconclusive",
        headline="Inconclusive",
        detail="",
        per_roi_hr=per_roi_hr,
        roi_names=names[: len(per_roi_hr)],
        agreement_bpm=agreement,
        face_valid_frac=face_valid_frac,
        mean_snr=mean_snr,
        duration_s=duration,
        n_frames=int(frames.shape[0]),
        detector_score=detector_score,
        detector_available=detector_score is not None,
        degraded=degraded,
        roi_waveforms=_waveforms(ppg),
        waveform_names=names[: ppg.shape[1]],
    )
    if duration > max_seconds:
        analysis.warnings.append(
            f"W_TRUNCATED: analysed the first {max_seconds:.0f}s of a "
            f"{duration:.0f}s clip"
        )
    verdict_for(analysis, thr)
    return analysis


def _mean_snr(ppg: np.ndarray, fps: float) -> float:
    """Mean over ROIs of peak/mean in-band power (0.7-14 Hz) — as the cache records it."""
    n = ppg.shape[0]
    freqs = np.fft.rfftfreq(n, d=1.0 / fps)
    mask = (freqs >= 0.7) & (freqs <= 14.0)
    snrs = []
    for r in range(ppg.shape[1]):
        power = np.abs(np.fft.rfft(ppg[:, r] - np.nanmean(ppg[:, r]))) ** 2
        band = power[mask]
        if band.size and np.all(np.isfinite(band)):
            snrs.append(float(band.max() / (band.mean() + 1e-12)))
    return float(np.mean(snrs)) if snrs else 0.0


def _waveforms(ppg: np.ndarray, max_points: int = 1500) -> list[list[float]]:
    """Down-sampled ROI waveforms for plotting (NaNs replaced by 0)."""
    out = []
    for r in range(ppg.shape[1]):
        col = np.nan_to_num(ppg[:, r], nan=0.0, posinf=0.0, neginf=0.0)
        if col.size > max_points:
            idx = np.linspace(0, col.size - 1, max_points).astype(int)
            col = col[idx]
        out.append([float(v) for v in col])
    return out


def verdict_for(analysis: PulseAnalysis, thresholds: VerdictThresholds | None = None) -> PulseAnalysis:
    """Assign the three-state verdict, in place. Returns the analysis.

    States:
      * ``real``        — "Pulse consistent — likely real"
      * ``fake``        — "Pulse inconsistent — pixel-replacement pattern detected"
      * ``inconclusive``— "Inconclusive — couldn't read a reliable pulse"

    The QC gates come first: without a readable pulse there is nothing to
    conclude, whatever the detector says.
    """
    thr = thresholds or DEFAULT_THRESHOLDS
    a = analysis

    # ---- QC gates -------------------------------------------------------
    reasons: list[str] = []
    if a.duration_s < thr.min_duration_s:
        reasons.append(
            f"clip is {a.duration_s:.1f}s — shorter than the {thr.min_duration_s:.0f}s "
            "minimum needed to resolve a heart rate"
        )
    if a.face_valid_frac <= 0.0:
        reasons.append("no face was tracked in any frame")
    elif a.face_valid_frac < thr.min_face_valid_frac:
        reasons.append(
            f"face tracked in only {a.face_valid_frac:.0%} of frames "
            f"(need {thr.min_face_valid_frac:.0%})"
        )
    if a.mean_snr < thr.min_snr:
        reasons.append(
            f"no measurable pulse in the face regions (SNR {a.mean_snr:.1f}, "
            f"need {thr.min_snr:.0f})"
        )
    if a.agreement_bpm is None:
        reasons.append("could not estimate a heart rate in enough regions")

    if reasons:
        a.verdict = "inconclusive"
        a.headline = "Inconclusive — couldn't read a reliable pulse"
        a.detail = "; ".join(reasons) + "."
        for r in reasons:
            if r not in a.warnings:
                a.warnings.append(f"W_QC: {r}")
        return a

    # ---- the pulse is readable: use the detector ------------------------
    if a.detector_score is None:
        a.verdict = "inconclusive"
        a.headline = "Inconclusive — no detector model available"
        a.detail = (
            "The pulse was measured, but the detector model is not installed, "
            "so no real/fake decision can be made. Drop a trained bundle at "
            "data/models/detector.joblib (or models/detector.joblib) for the "
            "full verdict."
        )
        a.warnings.append("W_NO_DETECTOR")
        return a

    says_real = a.detector_score >= thr.detector_threshold
    consistent = (
        a.agreement_bpm is not None and a.agreement_bpm <= thr.max_agreement_bpm
    )
    spread = f"{a.agreement_bpm:.1f} bpm" if a.agreement_bpm is not None else "n/a"

    if says_real:
        a.verdict = "real"
        if consistent:
            a.headline = "Pulse consistent — likely real"
            a.detail = (
                f"The face regions agree on one pulse (spread {spread}) and the "
                f"detector's score ({a.detector_score:+.2f}) sits on the real "
                f"side of the validated boundary ({thr.detector_threshold:+.2f})."
            )
        else:
            # Honest wording: the detector says real, but the evidence does
            # not show a consistent pulse. Do not claim agreement that the
            # measurement contradicts.
            a.headline = "Likely real — but the face regions disagree on the pulse"
            a.detail = (
                f"The detector's score ({a.detector_score:+.2f}) is on the real "
                f"side of the validated boundary ({thr.detector_threshold:+.2f}), "
                f"but the regions do not agree on one pulse (spread {spread} > "
                f"{thr.max_agreement_bpm:.0f} bpm), so the pulse evidence "
                "itself is weak here. Treat this as a low-confidence 'real'."
            )
    else:
        a.verdict = "fake"
        if not consistent:
            a.headline = "Pulse inconsistent — pixel-replacement pattern detected"
            a.detail = (
                "The face regions do not agree on one pulse "
                f"(spread {spread}) — consistent with a Deepfakes-family pixel "
                "replacement, which replaces the pulse inside the face — and "
                f"the detector's score ({a.detector_score:+.2f}) is on the fake "
                f"side of the validated boundary ({thr.detector_threshold:+.2f})."
            )
        else:
            # The detector says fake although the regions agree: report the
            # detector's call without inventing a pulse-inconsistency story.
            a.headline = "Likely fake — detected without a pulse-inconsistency signature"
            a.detail = (
                f"The detector's score ({a.detector_score:+.2f}) is on the fake "
                f"side of the validated boundary ({thr.detector_threshold:+.2f}), "
                f"although the regions do agree on one pulse (spread {spread}), "
                "so this is not the Deepfakes-style signature — it may be "
                "another manipulation family, which this detector cannot "
                "distinguish (see the caveat)."
            )
    return a


# ---------------------------------------------------------------------------
# Interface (Gradio) — imported lazily so the analysis half stays usable
# without Gradio installed.
# ---------------------------------------------------------------------------


# Web look: TrueBeat website v4 (trubeat.vercel.app). Black ink page, dark
# panels, paper text, safety orange accent, sharp corners, hard offset
# shadows. Fonts are a local stack only: the UI must make zero network
# requests, so no webfont links ever ship with the app.
UI_CSS = """
.gradio-container{background:#0D0D0D !important;color:#F4F0E8;
  font-family:'Archivo','Arial Black',system-ui,sans-serif !important}
.gradio-container .prose, .gradio-container .prose p{color:#F4F0E8}
.gradio-container h1, .gradio-container h2, .gradio-container h3{color:#F4F0E8}
#tb-head h1{text-transform:uppercase;letter-spacing:.01em;font-weight:900}
[data-testid="block-label"]{background:#FF4D00 !important;color:#0D0D0D !important;
  font-weight:800;text-transform:uppercase;letter-spacing:.07em;font-size:11px;
  border-radius:0 !important}
#tb-video{border:2px solid rgba(244,240,232,.85) !important;border-radius:0 !important;
  background:#141414 !important}
#tb-video .upload-container{background:#141414 !important;border-radius:0 !important;
  transition:transform .15s, box-shadow .15s}
#tb-video .upload-container:hover{box-shadow:4px 4px 0 rgba(255,77,0,.5)}
#tb-video [data-testid="upload-text"]{color:#F4F0E8}
#tb-analyse{background:#FF4D00 !important;color:#0D0D0D !important;font-weight:800;
  text-transform:uppercase;letter-spacing:.04em;border:2px solid #FF4D00 !important;
  border-radius:0 !important;box-shadow:5px 5px 0 rgba(244,240,232,.85) !important;
  transition:transform .15s, box-shadow .15s}
#tb-analyse:hover{transform:translate(-2px,-2px);
  box-shadow:7px 7px 0 rgba(244,240,232,.85) !important}
#tb-evidence table{border-collapse:collapse;width:100%}
#tb-evidence th, #tb-evidence td{border:1px solid rgba(244,240,232,.32);
  padding:6px 10px;text-align:left;color:#F4F0E8}
#tb-evidence th{background:#141414;text-transform:uppercase;font-weight:800;
  letter-spacing:.05em;font-size:.85em}
#tb-evidence tr:nth-child(even) td{background:rgba(244,240,232,.03)}
#tb-caveat{background:#141414;border:2px solid #FF4D00;border-radius:0;
  padding:12px 14px;color:#F4F0E8}
#tb-caveat strong{color:#FF4D00}
#tb-verdict{font-size:1.05em}
a{color:#F4F0E8 !important}
.progress-bar{background-color:#FF4D00 !important}
"""


def _ui_theme():
    """The v4 web look as token overrides on the bare Base theme."""
    import gradio as gr

    fonts = gr.themes.utils.fonts
    return gr.themes.Base(
        # radius_none: sharp corners everywhere (no Soft theme, no rounding)
        radius_size=gr.themes.sizes.radius_none,
        # Font wrapper = bare font-family name, no webfont, zero requests.
        # (Plain strings work at the constructor but break blocks.launch's
        # theme comparison, which expects font objects.)
        font=[
            fonts.Font("Archivo"),
            fonts.Font("Arial Black"),
            fonts.Font("system-ui"),
            fonts.Font("sans-serif"),
        ],
        font_mono=[
            fonts.Font("ui-monospace"),
            fonts.Font("Consolas"),
            fonts.Font("monospace"),
        ],
    ).set(
        body_background_fill="#0D0D0D",
        body_background_fill_dark="#0D0D0D",
        background_fill_primary="#0D0D0D",
        background_fill_secondary="#141414",
        panel_background_fill="#141414",
        panel_background_fill_dark="#141414",
        block_background_fill="#141414",
        block_background_fill_dark="#141414",
        input_background_fill="#1A1A1A",
        input_background_fill_dark="#1A1A1A",
        body_text_color="#F4F0E8",
        body_text_color_dark="#F4F0E8",
        body_text_color_subdued="#A89F8F",
        block_title_text_color="#F4F0E8",
        block_label_background_fill="#FF4D00",
        block_label_text_color="#0D0D0D",
        block_border_color="rgba(244,240,232,.32)",
        input_border_color="rgba(244,240,232,.32)",
        border_color_accent="#FF4D00",
        border_color_accent_subdued="rgba(255,77,0,.5)",
        button_primary_background_fill="#FF4D00",
        button_primary_background_fill_dark="#FF4D00",
        button_primary_background_fill_hover="#FF4D00",
        button_primary_text_color="#0D0D0D",
        button_primary_border_color="#FF4D00",
        button_secondary_background_fill="#141414",
        button_secondary_text_color="#F4F0E8",
        link_text_color="#F4F0E8",
        loader_color="#FF4D00",
        error_background_fill="#1A1A1A",
        error_text_color="#F4F0E8",
        # none of gradio's soft shadows: shadows here are hard offsets (CSS)
        shadow_inset="none",
        shadow_drop="none",
        shadow_drop_lg="none",
        shadow_spread="0",
    )


def build_demo(
    config: dict | None = None,
    model_path: Path | str | None = DEFAULT_MODEL_PATH,
    thresholds: VerdictThresholds | None = None,
):
    """Build the Gradio interface. Requires `gradio` to be installed."""
    import gradio as gr

    cfg = dict(config or {})

    def run(video_path, progress=None):
        if progress is None:
            progress = gr.Progress()
        if not video_path:
            return ("Upload a video first.", "", "", None, CAVEAT)
        progress(0.1, desc="Decoding video…")
        analysis = analyze_video(
            video_path, cfg, model_path=model_path, thresholds=thresholds
        )
        progress(1.0, desc="Done")
        evidence = _evidence_text(analysis)
        return (analysis.headline, analysis.detail, evidence, _plot(analysis), CAVEAT)

    # Note (gradio 6+): theme/CSS moved from the Blocks constructor to
    # demo.launch(); they are applied in main() from _ui_theme()/UI_CSS.
    with gr.Blocks(title="TrueBeat: rPPG deepfake check") as demo:
        gr.Markdown(
            "# TrueBeat: rPPG deepfake check\n"
            "Upload a short video of a face (10–120 s works best). "
            "Analysis takes roughly **20 seconds per minute of video** on a "
            "CPU: a 60 s clip is about a minute of waiting.",
            elem_id="tb-head",
        )
        with gr.Row():
            with gr.Column():
                video = gr.Video(
                    label="Video (10–120 s, visible face)",
                    sources=["upload"],
                    elem_id="tb-video",
                )
                btn = gr.Button("Analyse", variant="primary", elem_id="tb-analyse")
            with gr.Column():
                verdict = gr.Markdown(elem_id="tb-verdict")
                detail = gr.Markdown(elem_id="tb-detail")
                evidence = gr.Markdown(elem_id="tb-evidence")
        plot = gr.Plot(label="Per-region pulse waveforms", elem_id="tb-plot")
        caveat = gr.Markdown(
            f"**Caveat: always applies:** {CAVEAT}", elem_id="tb-caveat"
        )
        # One loader, one place: the Plot panel is the output the user
        # watches. Without this Gradio renders the progress overlay on every
        # output (a duplicate sat over the caveat). Outputs stay unchanged.
        btn.click(
            run,
            inputs=[video],
            outputs=[verdict, detail, evidence, plot, caveat],
            show_progress_on=[plot],
        )

        # Thin, machine-readable endpoint for the browser extension
        # (Phase 4b). It only *packages* what analyze_video already
        # computed — no new pipeline, no new thresholds, no recalibration.
        # Wired through a hidden button so the input type is the same
        # FileData the upload flow sends.
        def analyze_json(video_path):
            a = analyze_video(
                video_path, cfg, model_path=model_path, thresholds=thresholds
            )
            finite_hr = [b for b in a.per_roi_hr if np.isfinite(b)]
            return json.dumps(
                {
                    "verdict": a.verdict,
                    "headline": a.headline,
                    "detail": a.detail,
                    "score": a.detector_score,
                    "hr_bpm": float(np.mean(finite_hr)) if finite_hr else None,
                    "region_agreement_bpm": a.agreement_bpm,
                    "snr": a.mean_snr,
                    "face_valid_frac": a.face_valid_frac,
                    "duration_s": a.duration_s,
                    "per_roi_hr": {
                        n: (float(b) if np.isfinite(b) else None)
                        for n, b in zip(a.roi_names, a.per_roi_hr)
                    },
                    "qc": {
                        "ok": a.verdict != "inconclusive",
                        "face_valid_frac": a.face_valid_frac,
                        "snr": a.mean_snr,
                        "duration_s": a.duration_s,
                        "degraded": a.degraded,
                        "warnings": a.warnings,
                    },
                    "caveat": CAVEAT,
                }
            )

        api_btn = gr.Button(visible=False)
        api_out = gr.Textbox(label="result", visible=False)
        api_btn.click(
            analyze_json,
            inputs=[video],
            outputs=[api_out],
            api_name="analyze_video",
            api_description=(
                "Analyse a video of a face; returns JSON with the verdict, "
                "the evidence numbers and the standing caveat."
            ),
        )
    return demo


def _evidence_text(a: PulseAnalysis) -> str:
    hr_text = ", ".join(
        f"{n}: {b:.1f} bpm"
        for n, b in zip(a.roi_names, a.per_roi_hr)
        if np.isfinite(b)
    ) or "n/a"
    agree_text = (
        f"{a.agreement_bpm:.1f} bpm spread" if a.agreement_bpm is not None else "n/a"
    )
    rows = [
        "| evidence | value |",
        "|---------|-------|",
        f"| per-region heart rate | {hr_text} |",
        f"| inter-region agreement | {agree_text} |",
        f"| face_valid_frac | {a.face_valid_frac:.2f} |",
        f"| in-band SNR | {a.mean_snr:.1f} |",
        f"| clip length | {a.duration_s:.1f} s |",
    ]
    if a.detector_score is not None:
        rows.append(f"| detector score | {a.detector_score:+.3f} |")
    else:
        rows.append("| detector score | n/a (no model — degraded mode) |")
    if a.warnings:
        rows.append(f"| warnings | {'; '.join(a.warnings)} |")
    return "\n".join(rows)


def _plot(a: PulseAnalysis):
    """Small matplotlib plot of the per-ROI pulse waveforms."""
    if not a.roi_waveforms:
        return None
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(8, 2.6), dpi=110)
    fig.patch.set_facecolor("#0D0D0D")
    ax.set_facecolor("#0D0D0D")
    # website palette across the three ROIs: orange, paper, muted warm grey
    line_colors = ("#FF4D00", "#F4F0E8", "#A89F8F")
    for i, (name, wave) in enumerate(zip(a.waveform_names, a.roi_waveforms)):
        ax.plot(wave, linewidth=0.7, label=name, color=line_colors[i % 3])
    ax.set_xlabel("frame")
    ax.set_ylabel("pulse")
    ax.set_title("Per-region pulse waveforms (conditioned, 0.7-3 Hz band)")
    ax.tick_params(colors="#F4F0E8", labelcolor="#F4F0E8")
    for spine in ax.spines.values():
        spine.set_color("#A89F8F")
    legend = ax.legend(loc="upper right", fontsize=8, frameon=False)
    for text in legend.get_texts():
        text.set_color("#F4F0E8")
    fig.tight_layout()
    return fig


def main(argv: list[str] | None = None) -> int:
    """`trubeat serve` entry point."""
    import argparse

    p = argparse.ArgumentParser(prog="trubeat serve")
    p.add_argument("--port", type=int, default=7860)
    p.add_argument("--share", action="store_true",
                   help="create a temporary public Gradio link (uploads leave "
                        "this machine — use only for demos)")
    p.add_argument("--config", default=None)
    p.add_argument("--model", default=None,
                   help="detector bundle path (default: search models/, "
                        "data/models/, then the packaged copy)")
    args = p.parse_args(argv)

    try:
        import yaml
    except ImportError:  # pragma: no cover — pyyaml is a hard dependency
        yaml = None

    config: dict = {}
    if args.config and yaml is not None:
        with open(args.config) as f:
            config = yaml.safe_load(f) or {}
        if isinstance(config.get("band"), list):
            config["band"] = tuple(config["band"])

    # availability probe (gradio itself is only imported inside launch paths)
    import importlib.util

    if importlib.util.find_spec("gradio") is None:
        print(
            "Gradio is not installed. Install the optional extra:\n"
            "    uv pip install 'trubeat[serving]'\n"
            "or:  uv pip install gradio"
        )
        return 1

    demo = build_demo(config, model_path=args.model)
    if args.share:
        print("WARNING: --share exposes this app publicly. Uploaded videos "
              "leave this machine. Use it for demos only.")
    demo.launch(
        server_name="0.0.0.0",
        server_port=args.port,
        share=args.share,
        # the v4 web look (theme + CSS moved from Blocks to launch in gradio 6)
        theme=_ui_theme(),
        css=UI_CSS,
    )
    return 0
