# AGENTS.md — TrueBeat agent operating manual

You are the coding agent building TrueBeat. This file is your law. The build
spec lives in `docs/`; this file tells you *how* to work.

## 1. What TrueBeat is

A from-scratch rebuild of FakeCatcher (Ciftci, Demir & Yin, 2020): read the
human pulse from ordinary video via remote photoplethysmography (rPPG), check
that facial blood-flow signals are consistent across face regions, and flag
videos that fail. Python, laptop-first, free tooling only.

## 2. First-read order (every session)

1. `docs/00_index.md` — the doc map.
2. The doc relevant to your current task (architecture → `docs/04`, plan → `docs/07`).
3. `docs/10_agent_execution_plan.md` — the ordered task backlog. Work top-down.

If this file and `docs/` ever conflict on *what* to build, `docs/` wins.
If they conflict on *how* to work, this file wins.

## 3. Autonomy

You have full access: install packages (uv/pip), run code and tests, create /
edit / delete files in this repo, clone public repos, use the network for
public resources, commit locally on your branch.

Never without explicit human approval: create accounts, submit forms, upload
or share data (especially faces/videos) to any external service, spend money,
push to `main`, delete `data/raw`.

## 4. Build order (the law)

Phase 0 → 1 → 2 → 3 → 4, in `docs/07` order. Never start a phase until its
gate is met or the human waives it in writing. The backlog in `docs/10`
is the task list — take the topmost unfinished item, finish it, commit, repeat.

## 5. Coding rules

- Typed Python. One module per pipeline stage (`src/trubeat/`). The interfaces
  in `docs/04` §4 are frozen — change one only with a doc edit and a note in
  the commit message.
- Config-driven: bands, windows, ROI sets, methods live in `configs/*.yaml`.
  No magic numbers in code. Every run records its config hash.
- Errors: use the taxonomy in `src/trubeat/errors.py`. Never return silent NaN —
  raise `E_*`, or append to `warnings` and continue for `W_*`.
- Tests for every module. Synthetic-signal property tests FIRST
  (e.g. 72 bpm sine in → 72 ± frequency resolution out), real data second.
- Trace extraction is the expensive step: cache by content hash
  (video bytes + ROI def + method) under `data/processed/traces/`, never
  recompute silently.

## 6. Honesty rules (non-negotiable)

- Every prediction carries confidence + warnings. Every evaluation carries
  dataset + split protocol + grouping key.
- Report metrics with bootstrap confidence intervals. Show the full ROC;
  never a single cherry-picked accuracy.
- Never quote "96%" as our number. Never claim a metric without naming the
  dataset and split next to it.
- The manifest validator (`eval.validate_manifest`) runs before every training
  job and fails the run on identity leakage. No exceptions.

## 7. Data rules

- `data/raw/`, `data/processed/`, `runs/`, `reports/` are gitignored and stay
  that way. Raw face videos are never committed, never uploaded.
- Faces are biometric data. Local-only by default; the inference path makes
  zero network calls.

## 8. Git hygiene

- One commit per finished backlog item. Conventional messages:
  `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- 2026-10-18 (human-approved): push directly to `origin/main` (= upstream
  `tripathiayushman/trubeat`). No fork round-trip, no PRs for routine work.
  Conventional, small, honest commits — one per finished task. Phase-gate
  reports still go through human review (§9) before the next phase starts.

## 9. Human gates (only the human does these — prepare each as a single action)

1. Creating the Python env and installing deps.
2. Submitting dataset access forms (FF++, Celeb-DF).
3. Downloading datasets into `data/raw/`.
4. Glancing at `reports/roi_placement.png` to confirm ROI polygons.
5. Reviewing phase-gate reports and pasting results back.

Everything else is yours. The initial direction: do every task that needs no
human, in backlog order, until you hit a gate — then present the gate checklist
and stop.

## 10. When blocked

Write `reports/BLOCKERS.md` (what / what you tried / what's needed to unblock),
commit it, and continue with the next independent backlog item. Never spin on
a blocked task. Never fake a result to clear a gate.
