---
title: trubeat
emoji: 💓
colorFrom: green
colorTo: red
sdk: gradio
sdk_version: 6.30.0
app_file: app.py
pinned: false
license: mit
short_description: rPPG deepfake check — pulse-consistency test with honest limits
---

TrueBeat — deepfake detection from the human pulse (rPPG). This Space runs
the same Gradio app the tool's `trubeat serve` builds: upload a short video
of a face (10–120 s) and it measures the per-region pulse, checks that the
face's blood-flow signal is consistent, and answers with one of three
verdicts — pulse-consistent, pixel-replacement pattern, or inconclusive —
with the evidence numbers and the always-on caveat.

> **Deploy note (2026-10):** Hugging Face no longer hosts Gradio/Docker
> Spaces on the free `cpu-basic` tier for free accounts — `gradio deploy`
> answers `402 Payment Required` at create. This deploy therefore needs a
> PRO subscription (or another container host); nothing here is
> pay-per-analysis, and as configured the Space WOULD be public `cpu-basic`.
> The deployed environment is proven locally: `pip install
> -r requirements.txt` in a fresh 3.11 env reproduces the calibrated
> numbers bit-for-bit.

**Honest limits:** it detects the face-swap family (research AUC 0.73 on
Deepfakes). Reenactment fakes (Face2Face, NeuralTextures) keep the original
pulse and are out of scope — see the survey-free breakdown in the tool
repo's `reports/g2_detector.md`.

**Privacy:** uploads are analysed in this Space's container, kept in
ephemeral storage (HF Spaces wipe non-persistent storage on restart), and
are never used for training. For anything sensitive run the tool locally:
`pip install -e ".[serving]" && trubeat serve`.

Tool source: <https://github.com/tripathiayushman/trubeat>
