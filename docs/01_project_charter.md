# 01 — Project Charter: TrueBeat

## Vision

Build a working deepfake detector that reads the human pulse from ordinary video
(remote photoplethysmography, rPPG) and flags videos whose facial blood-flow
signals are spatially or temporally inconsistent — a from-scratch rebuild of the
FakeCatcher approach (Ciftci, Demir & Yin, 2020; productized by Intel, 2022).

## Objectives

- **O1 — Heart-rate reader (Phase 1).** Estimate beats-per-minute from a 10–30 s
  face video with mean absolute error ≤ 5 bpm against pulse-oximeter ground truth.
- **O2 — Fake detector (Phase 2).** Classify real vs. manipulated video from
  multi-region pulse consistency, scoring above chance on people the model never saw.
- **O3 — Generalization (Phase 3).** Scale to the FakeCatcher design (32 face
  regions, PPG maps, CNN classifier) and publish honest cross-dataset numbers —
  including a stress test against deepfakes that inherit the source video's pulse.
- **O4 — Usable tool (Phase 4).** One-command local inference (CLI + API + demo UI)
  that never uploads face data anywhere.

## Scope

**In scope**
- Video ingest and frame handling; face detection + landmark tracking.
- rPPG signal extraction (classical methods first: green-mean, CHROM, POS).
- Heart-rate estimation and validation against ground truth.
- Multi-region consistency features; classical classifier (logistic regression / SVM).
- CNN classifier on PPG maps (Phase 3); evaluation harness; local API + demo (Phase 4).

**Out of scope**
- Real-time streaming detection (the Intel product did this on Xeon servers with
  72 concurrent streams — not a laptop-weekend target).
- Mobile apps, browser extensions, or any auto-moderation deployment.
- Adversarial hardening against attackers who deliberately spoof pulse signals.
- Forensic or legal certification of results. The detector is one signal among
  many; any real-world flagging requires human review.

## Success criteria (phase gates)

| Gate | Criterion |
|------|-----------|
| G1 | HR MAE ≤ 5 bpm on UBFC-rPPG (still, well-lit clips) |
| G2 | Detector AUC ≥ 0.70 on a person-disjoint FaceForensics++ split (0.50+ is the honest minimum for "it learned something") |
| G3 | Full cross-dataset report: trained on FF++, tested on an unseen dataset + self-made deepfakes, with split protocol documented |
| G4 | `trubeat predict video.mp4` returns a label, confidence, and per-window votes, entirely offline |

## Constraints

- Solo builder, laptop CPU for Phases 1–2 (GPU optional, Phase 3).
- Free / open-source tooling only.
- Datasets obtained via academic request forms; budget time for approvals.
- Disk: ~120 GB free (UBFC-rPPG uncompressed ≈ 60 GB + FF++ c23 ≈ 40 GB + mirrors/double-staging during download + feature caches).
- Time: the brief's own estimate — a weekend for the heart-rate reader, a few
  evenings per later phase, 1–2 weeks for the CNN scale-up.

## Assumptions

- Input videos contain a mostly-frontal, visible face for at least 10 seconds.
- Frame rate is always read from the file, never assumed (every bpm number
  depends on it).
- A detectable pulse is **not** proof a video is real. The 2025 Frontiers in
  Imaging study (Seibold et al.) showed high-quality deepfakes inherit the
  driver's pulse with only ~2–3 bpm deviation. The durable signal is *local
  spatiotemporal consistency* of blood flow, not the global heart rate.

## Stakeholders

- **Builder / owner:** Shivam. No external users until Phase 4.
- **Data subjects:** dataset participants (license terms apply — see Data Strategy).
- No personal data leaves the machine without an explicit action by the owner.
