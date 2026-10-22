
```
████████╗██████╗ ██╗   ██╗███████╗██████╗ ███████╗ █████╗ ████████╗
╚══██╔══╝██╔══██╗██║   ██║██╔════╝██╔══██╗██╔════╝██╔══██╗╚══██╔══╝
   ██║   ██████╔╝██║   ██║█████╗  ██████╔╝█████╗  ███████║   ██║   
   ██║   ██╔══██╗██║   ██║██╔══╝  ██╔══██╗██╔══╝  ██╔══██║   ██║   
   ██║   ██║  ██║╚██████╔╝███████╗██████╔╝███████╗██║  ██║   ██║   
   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═════╝ ╚══════╝╚═╝  ╚═╝   ╚═╝  
  
```

A from-scratch rebuild of **FakeCatcher** (Ciftci, Demir & Yin, 2020): read the
human pulse from ordinary video via remote photoplethysmography (rPPG), check
that facial blood-flow signals are consistent across face regions, and flag
videos that fail.

> A detectable pulse is **not** proof a video is real — modern deepfakes inherit
> the driver's pulse. TrueBeat targets *local spatiotemporal consistency* of
> blood flow, the signal the 2025 literature says survives. See `docs/`.

## Docs (read first)

The full pre-implementation pack lives in [`docs/`](docs/00_index.md):
project charter, system requirements, tech stack, architecture, data strategy,
risk register, implementation plan, acceptance tests, and the
[agent execution plan](docs/10_agent_execution_plan.md).

**Agents start here:** [`AGENTS.md`](AGENTS.md) is the operating manual
(OpenCode reads it natively), then `docs/09` is the task backlog.

## Quick start (Phase 0)

```bash
uv venv --python 3.11 && source .venv/bin/activate   # 3.12 also fine
uv pip install -e .
pytest                    # smoke tests must stay green
```

Then follow the Phase 0 checklist in `docs/07_implementation_plan.md`:
submit the FF++ / Celeb-DF access forms, download UBFC-rPPG.

## Run the app (Phase 4a)

A one-click web interface over the *same* pipeline the CLI runs
(ingest → face → ROI → signal → features → predict).

```bash
uv pip install -e ".[serving]"      # pulls gradio (optional extra)
trubeat serve                       # http://127.0.0.1:7860
trubeat serve --port 8080           # different port
trubeat serve --share               # temporary public link (see the warning below)
```

Upload a video of a face (**10–120 s works best**; analysis is capped at the
first 120 s and the app says so when it truncates). Expect roughly **20
seconds of processing per minute of video** on a CPU — a 60 s clip takes about
a minute.

You get a three-state verdict with its evidence (per-region heart rate,
inter-region agreement, `face_valid_frac`, SNR, and a plot of the three ROI
waveforms):

| verdict | meaning |
|---------|---------|
| **Pulse consistent — likely real** | the face regions agree on one pulse and the detector scores the clip on the real side |
| **Pulse inconsistent — pixel-replacement pattern detected** | the regions disagree and the detector scores the clip on the fake side — the Deepfakes-family signature |
| **Inconclusive** | the QC gates refused the clip (< 10 s, no face, unstable tracking, no measurable pulse), or no detector model is installed |

**The caveat is always shown, because it is the honest result:**

> Detects face-swap-style fakes (research AUC 0.73 on the Deepfakes family).
> Cannot detect reenactment fakes (Face2Face, NeuralTextures) — those keep the
> original pulse. Details: `reports/g2_detector.md`.

**Degraded mode.** The G2 detector bundle is committed inside the package
(`src/trubeat/models/detector.joblib`) and ships in the wheel, so the app
finds it from any working directory. A locally retrained bundle can override
it by being placed at `models/detector.joblib` or `data/models/detector.joblib`
in the repo root. With no bundle found at all, the app still works as a
**pulse / heart-rate analyzer** (it reports the per-region heart rate, the
agreement and the QC) and says that no real/fake decision can be made.

**Privacy.** The local app is **fully private** — videos are analysed on this
machine and never leave it. `--share` publishes a temporary Gradio link:
**uploads to a shared instance leave the machine**, so use it for demos only,
never for real faces.

**Free hosting.** The app is a plain Gradio app, so it also runs on
**Hugging Face Spaces** (free CPU tier) for a public demo — with the same
caveat that anything uploaded to a hosted instance leaves your machine.
Deploy by adding a `spaces.yaml` (or `app.py` entrypoint) that calls
`trubeat.app.build_demo()`.

**Extension hook.** The analysis is a pure function, separate from the UI:

```python
from trubeat.app import analyze_video
analysis = analyze_video("clip.mp4")   # -> PulseAnalysis (verdict + evidence)
```

`analyze_video` is what the UI calls and what a future browser extension
should call — Gradio's built-in API already exposes the same function over
HTTP, so an extension can POST a video without a second implementation.

## Browser extension (Phase 4b)

A Chrome extension (Manifest V3, vanilla JS, no build step) in
[`extension/`](extension/README.md): one click checks the video playing in
the current tab and overlays the verdict on the page.

```bash
# load it: chrome://extensions → Developer mode → Load unpacked → extension/
```

Prefer a download? Grab the packaged zip from the releases page — the
stable link, always the latest build:

<https://github.com/tripathiayushman/trubeat/releases/latest/download/trubeat-extension.zip>

It captures ~20 s of the tab, uploads it to **your** backend, and renders
the three-state verdict with the evidence numbers. It never computes a
verdict itself and never recalibrates a threshold — it calls the same
`analyze_video()` the web app uses, over the Gradio API. No telemetry, no
storage, no network traffic to anything but the backend URL you set.

## Website

The website (marketing pages, documentation, research summary and the
"try it online" demo page) lives in its own repo,
[tripathiayushman/trubeat-website](https://github.com/tripathiayushman/trubeat-website)
and is served at <https://trubeat.vercel.app>. Nothing about the tool
changed with the split: this repo is the product; the website is its
front door.

## Layout

```
src/trubeat/   # one module per pipeline stage (interfaces: docs/04 §4)
configs/       # p1_hr / p2_detector / p3_cnn — every run is config-driven
data/          # DVC-tracked; raw faces NEVER committed (see .gitignore)
docs/          # the full pre-implementation pack (00–09)
tests/         # smoke + golden-set regression + synthetic-signal property tests
third_party/   # reference clones only (rPPG-Toolbox) — never dependencies
```

## Status

Phase 1 (heart rate) and Phase 2 (classical detector) are implemented and
**both gates failed honestly** — see
[`reports/g2_detector.md`](reports/g2_detector.md) for the central write-up
(the Phase-2 result: an rPPG-consistency detector that clears the threshold
on the Deepfakes family and is structurally blind to the reenactment
families, because pulse inheritance leaves the performer's pulse intact).

Phase 4a: the Gradio web app (`trubeat serve`) is in place over the same
pipeline. Phase 3 (CNN on PPG maps) is **not pursued** — the reason is
recorded in `docs/07`.

Human gates (env, dataset forms/downloads, ROI glance, gate reviews) are
collected in `reports/HUMAN_GATES.md`.

## License

MIT — see [LICENSE](LICENSE).

## Contact

Ayushman Tripathi — atr.ayushmantripathi@gmail.com
