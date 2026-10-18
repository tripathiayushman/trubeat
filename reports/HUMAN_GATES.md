# TrueBeat — Human Gates Checklist

One-action items. Everything else is agent work (see `docs/10_agent_execution_plan.md`).
Do an item, tell the agent "done", it continues.

## B1 — Environment sanity (5 min, once)
```bash
cd ~/workspace/trubeat   # or your clone
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest tests/ -q   # expect: all pass
```

## B2 — Dataset access forms (15 min, once)
UBFC-rPPG and FaceForensics++ both need request forms. Exact links + what to
click are in `docs/09_data_access_starter.md`. Nothing to download yet — just
submit the forms and wait for the links.

## B3 — UBFC download (~30 min when the link arrives)
Follow `docs/09_data_access_starter.md` "tonight's checklist":
`data/raw/ubfc/` ← 42 `subjectXX/` dirs. Then tell the agent — it runs the
G1 heart-rate gate (target: MAE ≤ 5 bpm).

## B4 — ROI placement glance (2 min) — **PASSED 2026-10-18**
Open `reports/roi_check_subject01.png`, `reports/roi_check_subject15.png`,
`reports/roi_check_subject38.png` (generated locally, gitignored). Forehead +
both cheeks anatomically correct on all three real subjects; bangs (subject1)
and glasses (subject15) noted as dataset characteristics, not bugs.

## B5 — FaceForensics++ c23 file list (10 min, when access arrives)
Download only the `c23` list from the official script (see `docs/09`). Tell
the agent the path — it builds the manifest and runs the G2 gate
(target: person-disjoint AUC ≥ 0.70).

## B6 — Gate reviews (5 min each)
The agent will hand you `reports/hr_gate_ubfc.md` (G1) and
`reports/detection_gate_ffpp.md` (G2) with honest pass/fail numbers.
Approve → it proceeds. Fail → it diagnoses in the open, no silent tuning.

## B6 — G1 WAIVER 2026-10-18
**Gate G1 (UBFC-rPPG HR MAE ≤ 5 bpm): FAILED — waived to Phase 2 conditionally**

| Method | MAE (bpm) | RMSE | Pearson r | Gate |
|--------|-----------|------|-----------|------|
| POS (fixed) | 8.250 | 15.365 | 0.600 | ❌ |
| CHROM (fixed) | 6.770 | 13.450 | 0.694 | ❌ |

**Per-subject failures (>8 bpm err on both POS & CHROM):**
- subject11: 127 vs 96 (31) — all ROIs locked to 2× harmonic
- subject14: 70 vs 80 (10) — forehead/cheeks agree on wrong peak
- subject18: 124 vs 104 (20) — all ROIs corrupted
- subject20: 126/131 vs 60 (66/71) — all ROIs corrupted, severe artifact
- subject24: 108/89 vs 85 (23/4) — CHROM fixed, POS still wrong
- subject30: 102 vs 93 (9) — mild
- subject32: 101/96 vs 107 (7/11) — mild POS, CHROM worse
- subject35: 116 vs 102 (14) — all ROIs wrong
- subject36: 93/121 vs 119 (26/2) — POS bad, CHROM good
- subject38: 111 vs 110 (1) — FIXED by multi-ROI (was 62)
- subject41: 54/99 vs 101 (46/2) — POS regression (halved correct peak), CHROM good

**Root cause:** Motion/lighting artifacts corrupt all ROIs on ~5 subjects; trace conditioning (detrend + 4th-order Butterworth) insufficient. Phase 2 work item: motion-robust preprocessing (optical-flow stabilization, adaptive band selection, or POS on denoised traces).

**Condition for Phase 2:** All Phase-2 reports carry HR quality (MAE/CI) next to detection metrics; no G1 metric is reused as a proxy. FF++ approval still required (B2).

## Reference
- Full gate definitions: `docs/08_acceptance_test_plan.md`
- Data strategy + anti-leakage rules: `docs/05_data_strategy.md`
- Current phase status: ask the agent
