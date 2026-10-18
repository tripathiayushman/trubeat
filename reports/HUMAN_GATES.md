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

## Reference
- Full gate definitions: `docs/08_acceptance_test_plan.md`
- Data strategy + anti-leakage rules: `docs/05_data_strategy.md`
- Current phase status: ask the agent
