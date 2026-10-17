# third_party — reference clones (NOT dependencies)

## rppg-toolbox/ (ubicomplab, NeurIPS 2023)

**License: Responsible AI Source Code License v1.1 (licenses.ai) — NOT
permissive (not MIT/Apache).** Use as a *reference harness only*: run it to
validate our pipeline's numbers (POS/CHROM baselines, pretrained checkpoints).
**Do not copy its code into `src/trubeat/`.** Any vendored snippet needs
explicit human approval first.

Rule of thumb: read it, learn from it, benchmark against it — keep our
implementation clean-room.

**Cloned 2026-10-18** (shallow, HEAD at clone time; re-clone rather than
embedding its history). Runtime for its unsupervised baselines needs
`scikit-image` — pinned `<0.23` via the `toolbox_ref` extra in
`pyproject.toml` so it cannot drag numpy>=2 into the environment.

Cross-check performed (`scripts/crosscheck_pos.py`): our
`signal._pos_one` vs reference `unsupervised_methods/methods/POS_WANG.py`
on a synthetic 72 bpm pulse video: **Pearson r = 0.9814**, both estimate
72.0 bpm. Windowing differs by design (theirs: 1.6 s overlap-add windows,
100-sample detrend, 1st-order 0.75–3 Hz butter; ours: global-conditioned
POS, 4th-order 0.7–3 Hz SOS), hence <1.0 correlation on a pure tone.
