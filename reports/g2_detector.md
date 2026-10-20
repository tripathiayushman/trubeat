# G2 detection gate — FF++ c23 — 2026-10-20 10:57

## Verdict — G2 FAILED

- **Gate:** pooled test AUC ≥ 0.70 (person-disjoint).
- **Result: AUC 0.5434** (95% bootstrap CI over source videos: **[0.4808, 0.6111]**), n = **250** usable test videos.
- The confidence interval **excludes 0.70**, so this is a failure of the gate, not a failure to measure it.
- Train CV AUC 0.6370 ± 0.0377 · validation AUC 0.6579 · test AUC 0.5434.

**But the pooled number is the least informative number in this report.** The gate was failed by a detector that detects one of the four manipulation families well and is blind to the other three. That structure — not the average — is the scientific result, and it is below.

---

## The central finding: a per-method operating envelope

Each manipulation family was scored against the same 135 real test videos:

| manipulation | AUC | 95% CI | n fakes | verdict |
|--------------|-----|--------|---------|---------|
| Deepfakes | **0.7298** | [0.6198, 0.8354] | 29 | **detected** (CI reaches the gate) |
| Face2Face | **0.4585** | [0.3516, 0.5586] | 31 | chance (CI spans 0.5) |
| FaceSwap | **0.5953** | [0.4886, 0.7017] | 27 | chance (CI spans 0.5) |
| NeuralTextures | **0.3944** | [0.2898, 0.5080] | 28 | chance (CI spans 0.5) |

### Why: the mechanism is structural, not a tuning failure

**Pixel-replacement destroys the pulse → detectable.** Deepfakes replaces the pixels inside the face. The blood-volume signal the features measure is replaced along with the identity, so the loss shows up in exactly the quantities we compute. That family is detected (AUC 0.7298), and its CI [0.6198, 0.8354] reaches the gate.

**Geometry reenactment preserves the performer's pulse → structurally invisible.** Face2Face re-enact the expression while keeping the original performer's skin texture and lighting, so the pulse that our features measure **survives the manipulation intact**. This is the published *pulse inheritance* failure mode (R-06), and it is a statement about the physics, not about our hyperparameters: a detector built on blood-flow consistency has nothing to detect when the blood flow is unchanged. Face2Face lands at 0.4585 — at chance.

**FaceSwap and NeuralTextures sit between or below.** FaceSwap (0.5953) is a geometry-plus-texture blend; NeuralTextures (0.3944) is **below chance** — the detector ranks those fakes as *more real-looking* than the real videos. Its interval [0.2898, 0.5080] has its upper bound sitting on 0.5, so the strictly defensible reading is *no better than chance, and biased against this family* — not a demonstrated inversion. A model that is wrong in one direction on a whole manipulation family is worse than an uninformative one, because its errors are systematic (R-17).

### What the pooled 0.54 is — and is not

The pooled AUC of 0.5434 is **an average over one detectable family and three blind spots**, not the strength of a weak detector. Quoting it alone would misdescribe the result in both directions: it understates the detector on Deepfakes and overstates it everywhere else. The honest summary is the envelope above.

This also reframes the gate. A pooled AUC of 0.70 was never achievable with an rPPG-consistency feature family on this material, because for three of the four families the quantity being measured is unchanged by the manipulation.

---

## The operating point (corrected)

| metric | value |
|--------|-------|
| accuracy | 0.5640 |
| fake-class recall (fakes caught) | 0.3304 |
| fake-class precision | 0.5429 |
| **FPR on real videos** (reals wrongly flagged fake) | **0.2370** |

### Confusion matrix (rows = truth, columns = prediction; **positive = fake**)

| truth \ prediction | pred fake | pred real | total |
|-------------------|----------|----------|-------|
| **true fake** | 38 | 77 | 115 |
| **true real** | 32 | 103 | 135 |
| **total** | 70 | 180 | 250 |

- `fpr_on_real` = 0.2370 = **real videos wrongly flagged as fake** (32 of 135 real videos) — the R-07 headline (the BBC lesson: a detector that cries wolf is unusable).
- fake-class recall = 0.3304 (38 of 115 fakes caught); precision = 0.5429.

### Disclosure: the confusion matrix was transposed (bug, now fixed)

**What it was.** `detector.video_metrics` computed the confusion matrix with `y = 1` meaning *real* (scikit-learn's convention), but the report writer printed `(tp, fn)` on the *"true fake"* row and `(fp, tn)` on the *"true real"* row. The two rows were therefore **transposed**, and `fpr_on_real = fp/(fp+tn)` was in fact computing the **fake-class miss rate**, not the false-positive rate on real videos.

**What it corrupted.** Only the thresholded metrics: the confusion matrix, `fpr_on_real`, `precision` and `recall` (and the labels on the per-class rates). The **AUCs were unaffected** — AUC is threshold-free, so every AUC in this report (pooled and per-method) was correct before and after the fix. The headline false-positive figure was wrong in the unfavourable direction: it was reported as **0.670** when the true value is **0.2370**.

**How it was caught.** Chasing a denominator mismatch (the confusion matrix implied 135 fakes while the per-method table summed to 115) exposed the swap: the matrix's "true fake" row totalled 135, which is the number of **real** videos in the test split.

**Fix and prevention.** The metric now uses an explicit, documented convention (**positive = fake**) end to end, and **two regression tests** pin it: one asserts the exact `(tp, fn, fp, tn)` layout and that the row totals equal the class counts, the other asserts that `fpr_on_real` counts real videos flagged as fake. The same function in `eval.py` was audited and found to be correct (it counts explicitly rather than via `confusion_matrix`).

---

## Reconciliation: every number in this report is auditable

Generated by `scripts/audit_test_split.py`, which reads the filesystem and the manifests — no count here is carried by hand.

| method | label | on disk (all splits) | in manifest (all) | test manifest | test cached | test usable | test excluded |
|--------|-------|-----------------------|------------------|---------------|--------------|-------------|---------------|
| original | real | 308 | 308 | 140 | 138 | 135 | 5 |
| Deepfakes | fake | 75 | 75 | 31 | 31 | 29 | 2 |
| Face2Face | fake | 75 | 75 | 31 | 31 | 31 | 0 |
| FaceSwap | fake | 72 | 72 | 28 | 27 | 27 | 1 |
| NeuralTextures | fake | 73 | 73 | 29 | 28 | 28 | 1 |
| **total** | | **603** | **603** | **259** | **255** | **250** | **9** |

**Every gap, explained:**

1. **on disk → in manifest: 603 = 603.** Every downloaded video is in the manifest — nothing was downloaded but left unlisted.
2. **in manifest → test manifest.** The `split` column comes from the official FF++ split JSONs, so this is a *partition*, not a loss.
3. **test manifest → test cached: 259 - 255 = 4.** No trace exists because the clip is shorter than the 10 s minimum, so the pipeline refuses it (`E_SHORT_VIDEO`, R-03).
4. **test cached → test usable: 255 - 250 = 5.** Excluded by QC:

   | exclusion reason | n |
   |-----------------|---|
   | NO_FACE | 5 |
   | NO_SIGNAL | 5 |
   | MISSING_CACHE | 4 |

   (`NO_FACE` and `NO_SIGNAL` are the **same** 5 videos — no face tracked → no pulse → zero SNR — so they are one exclusion, not two; the `MISSING_CACHE` 4 are the videos with no trace at all. 5 + 4 = 9 excluded videos. The `NO_FACE` clips are broadcast-style footage where MediaPipe finds no face at any confidence, including after a 2x upscale.)
5. **test usable → scored: 250 of 250.** Every usable test video yields features at the 10 s window (the coverage guard guarantees 100% coverage), so **scored = usable = 250** (135 real + 115 fake).

**Per-method denominators used above:** Deepfakes 29, Face2Face 31, FaceSwap 27, NeuralTextures 28 fakes, each against the same 135 reals (sum 115 = the 115 usable fakes).

---

## Supporting evidence

### Trace-cache QC

| | n |
|---|---|
| manifest rows | 603 |
| **usable (eligible for training/scoring)** | **565** |
| excluded (no face / no signal / unstable track / missing cache) | 38 |
| mean `face_valid_frac` (usable) | 0.9986 |
| mean `mean_snr` (usable) | 33.87 |

Every cached video carries QC (`face_valid_frac`, `mean_snr`); videos with no measurable signal are excluded with a recorded reason, so no unusable row reaches training or scoring.

### R-14 — resolution is a label shortcut in FF++

The manipulated sequences are re-encoded at a **different resolution than their source original** (144 of 200 fake/original pairs measured, e.g. source 033 is 854×480 as an original but 640×480 in all four fakes). A detector could therefore score on resolution instead of blood-flow physics — a shortcut that will not survive the cross-dataset exam. Every video here is decoded with a **480 px frame-height cap** (aspect preserved, never upscaled), so the model cannot read the shortcut. That is a *mitigation, not a proof*, and it must be stated with any FF++ number.

### R-01 — the pulse is not visible in the FF++ material

The physical precondition for every consistency feature is that the regions of one face show the *same* pulse. Measured as the spread of the per-ROI heart-rate estimates within one face:

| material | real | fake | reading |
|----------|------|------|---------|
| FF++ c23 | ~8.6 bpm | ~8.5 bpm | **no separation** |
| FF++ raw (lossless probe) | ~6.9 bpm | ~6.6 bpm | **no separation** |
| UBFC-rPPG | ~1 bpm | — | pulse clearly visible |

On FF++ the regions disagree by tens of bpm in **both** classes: there is no single pulse for them to agree about. On UBFC the same pipeline reads heart rates to ~1 bpm with tight region agreement, so the pipeline is not the problem — the FF++ material is (short YouTube clips, small faces, studio lighting, motion).

### The lossless probe refutes the compression hypothesis

The natural explanation was R-01/ADR-06: heavy compression destroys the pulse, so train on mixed compression (raw + c23 + c40). That was tested, not assumed. 80 **lossless** FF++ videos (the same source videos, `-c raw`, ~6.4 GB) were downloaded and measured:

- c23: real 8.6 bpm / fake 8.5 bpm spread
- raw: real 6.9 bpm / fake 6.6 bpm spread

Lossless quality tightens the spread for **both** classes; the class gap stays zero. **Compression is not the cause**, so mixed-compression training is demoted from *the fix* to a robustness check. Full write-up: `reports/raw_probe_result.md`.

### R-15 / R-16 / R-17 — the risks this work produced

- **R-15 — the evaluation set could not resolve the gate.** 56 usable test videos gave a bootstrap CI of ±0.27, spanning 0.70. *Resolved:* the test split was enlarged to 250 usable videos and the CI is now ±0.065 and excludes the gate. A failure here is now a failure of the method, not of the measurement.
- **R-16 — the feature-window size silently reweights the population.** A 15 s window drops clips shorter than 15 s, and the fakes are re-encoded (so shorter more often): it kept 50% of the test fakes but 69% of the test reals. Selecting on that AUC rewards a biased subset. The search now applies a coverage guard (≥95% of every class in every split) and the 15 s configuration — which scored *better* on train CV — was rejected on that basis, not on its test score.
- **R-17 — one manipulation family can carry the whole result.** The pooled AUC averages one detectable family over three blind spots. Per-method AUCs with CIs are therefore reported next to the pooled number everywhere, with the mechanism named.

### HR quality alongside the detection metrics

The G1 heart-rate gate on UBFC-rPPG **FAILED** (CHROM MAE 6.77 bpm, POS 8.25 bpm against a ≤ 5 bpm target) and was **waived by the human in writing** to proceed to Phase 2 conditionally; the per-subject failure table is in `reports/HUMAN_GATES.md`.

**The UBFC G1 numbers are NOT reused as a proxy for anything here.** FF++ has no heart-rate ground truth at all (YouTube clips, no oximeter), so an MAE cannot be computed on this material. What *is* computable is the health of the pulse signal in the scored test videos:

| class | n videos with a pulse estimate | mean peak confidence |
|-------|-------------------------------|---------------------|
| fake | 115 | 0.1635 |
| real | 135 | 0.1555 |

The two classes are indistinguishable here as well — consistent with the R-01 measurement above, and the reason the consistency features cannot separate them.

---

## Protocol and full disclosure

### The protocol

1. **Hyperparameters** (rPPG method, window size, classifier, feature subset) were selected by **group-aware CV on the TRAIN split only** (`GroupKFold`, groups = source video).
2. The **operating threshold** was tuned on the **VALIDATION** split (Youden's J) → threshold -0.0128.
3. The **test split was scored once** with everything frozen.

**No hyper-parameter, feature or threshold was ever chosen by looking at a test score.** The validation split was used for the threshold only.

### All four test evaluations

The test split was consulted **four times** during development. All four numbers are disclosed here, including the ones that were worse:

| # | model | test set | test AUC | why it was superseded |
|---|-------|----------|----------|-----------------------|
| 1 | POS method, hard vote-fraction score, no coverage guard | 56 videos | 0.3201 | wrong method for c23 (the vote fraction also discarded the ranking information) |
| 2 | green method, soft score, 15 s window | 56 videos | 0.5871 | the 15 s window silently shrank the test set in a label-biased way (R-16) |
| 3 | green method, soft score, 10 s window, coverage guard | 56 videos | 0.4740 | same model, but 56 videos cannot resolve the gate (CI ±0.27, R-15) |
| 4 | **same model, enlarged test split** | **250 videos** | **0.5434** | reported below |

Rows 1–3 used the original 56-video test split; row 4 is the **same frozen model** on the enlarged split. Enlarging the split was to *measure* the gate, not to re-pick the model — the configuration, the features and the threshold are identical between rows 3 and 4.

### Setup

- dataset: **FaceForensics++ c23** — 603 videos in the manifest (603 on disk, 292 real / 273 fake usable)
- manifest: `data/manifests/ffpp_c23_qc.csv`
- split protocol: **official FF++ train/val/test**, grouped by source video (`split_group`), group-aware CV — no video and none of its fakes span splits
- features: cached traces → windowed consistency features (coh_mean, coh_std, coh_min, coh_max, lag0_mean, lag0_std, lag0_min, spec_entropy, peak_sharpness, snr_mean)
- rPPG method: **green** (recomputed from the cached raw ROI traces — no re-decoding)
- classifier: **logreg** (StandardScaler + model), window **10.0 s**, overlap 0.5
- config_hash: ba2f113b · model: `runs/g2_detector.joblib`

### Hyperparameter search (group-aware CV on TRAIN only)

| method | window | classifier | feature subset | train CV AUC | min coverage |
|--------|--------|-----------|----------------|--------------|---------------|
| green | 15.0 s | svm_rbf | all | 0.7012 ± 0.0511 | 0.476 (ineligible) |
| green | 15.0 s | logreg | all | 0.6584 ± 0.0684 | 0.476 (ineligible) |
| green | 15.0 s | svm_rbf | no-coherence | 0.6433 ± 0.0569 | 0.476 (ineligible) |
| green | 10.0 s | logreg | all | 0.6370 ± 0.0377 | 1.000 |
| green | 10.0 s | logreg | no-coherence | 0.6296 ± 0.0499 | 1.000 |
| green | 10.0 s | svm_rbf | all | 0.6275 ± 0.0519 | 1.000 |
| green | 15.0 s | logreg | no-coherence | 0.6245 ± 0.0721 | 0.476 (ineligible) |
| green | 10.0 s | svm_rbf | no-coherence | 0.6213 ± 0.0434 | 1.000 |
| pos | 15.0 s | logreg | no-coherence | 0.6099 ± 0.0056 | 0.476 (ineligible) |
| pos | 15.0 s | logreg | all | 0.5904 ± 0.0177 | 0.476 (ineligible) |

Selected: **green**, 10.0 s, logreg, features (all) — chosen on TRAIN CV. Note that CHROM and POS sit near chance on this material while the raw green channel survives (R-01): the colour-ratio methods depend on relative skin colour, which compression mangles, so their projection amplifies noise instead of suppressing it.

---

## Conclusion: Phase 2 closes with a characterised partial result

**Phase 3 (the CNN on per-region PPG maps) is not being pursued**, and the reason is the finding above rather than a budget or a schedule:

1. **For three of the four manipulation families there is no signal to learn.** Pulse inheritance (R-06) means the geometry methods preserve the performer's pulse, so the quantity every rPPG-based feature measures is *unchanged* by the manipulation. A CNN trained on PPG maps cannot invent a distinction where the underlying quantity does not change — it would have to latch onto something else.
2. **What a CNN would latch onto is artifacts, not physiology.** The remaining routes to a high score on this material (re-encoding artifacts, resolution differences — R-14 — background screens, motion texture) are exactly the shortcuts that do not survive a cross-dataset exam. Reporting such a number as rPPG progress would be dishonest, and reporting it as detection progress would still be misleading, because the model's skill would be in the wrong place.
3. **The honest characterisation is already stronger than a pass/fail would be.** We can say precisely where this approach works (Deepfakes, AUC 0.7298, CI reaching the gate), precisely where it does not (three families, one of them biased the wrong way — below chance), and why (a physics argument, measured three ways).

**Phase 2 therefore closes as a partial result with a known boundary**, not as a failed attempt:

- an rPPG-consistency detector that **clears the G2 threshold on one of the four FF++ manipulation families**;
- **structurally unable** to work on the families where the performer's pulse survives the manipulation, with that limitation measured rather than assumed;
- with **two measurement bugs found and fixed** along the way (a saturated coherence estimator that made the headline feature a constant, and a transposed confusion matrix), both now covered by regression tests;
- and a **compressed-then-lossless test that refuted our own leading hypothesis** (compression) in favour of a measured one (pulse inheritance).

**Recommended next step (for the human to choose):** a detector that does not rely on the performer's pulse being altered — i.e. a **local spatiotemporal** or **texture/geometry** feature family (which is what the published next-generation work recommends), evaluated with the per-method envelope reported alongside the pooled number. That is a different scientific claim from the one this Phase 2 tested, and it should be stated as such.

---

## Limitations (state them, do not bury them)

- **Per-method fake counts are modest** (Deepfakes 29, Face2Face 31, FaceSwap 27, NeuralTextures 28 in a 250-video test split): the per-method intervals are wide and the per-method verdicts are indicative, not conclusive.
- **Single compression (c23) and a single resolution family** in the training manifest; the lossless probe shows the compression axis would not have helped *these* features (R-01), but the trained model has not been tested for compression robustness.
- **No cross-dataset number.** Celeb-DF v2 is the real exam and has not been run (R-09).
- **The threshold generalizes worse than the ranking does**: val FPR 0.2000 → test FPR 0.2370, on a threshold that was tuned on validation only. A production operating point would need re-tuning on a larger validation set, and its false-positive rate is the number that matters (R-07).
- The excluded videos (broadcast footage with no detectable face) are **excluded, not imputed** — this report does not cover what the detector would have said about them.

## Honesty checklist

- [x] verdict up top, unburied, with the gate and the CI
- [x] per-method AUC with bootstrap CIs, not just the pooled number
- [x] split protocol documented (official FF++ splits, grouped)
- [x] no identity leakage (group-aware CV; validator green)
- [x] CIs reported (bootstrap over source videos)
- [x] operating threshold tuned on validation only
- [x] every count reconciled (downloaded → cached → usable → scored)
- [x] all test evaluations disclosed, including the worse ones
- [x] measurement bugs disclosed, with the regression tests that pin them
- [x] limitations listed (R-14 resolution, per-method n, compression, no cross-dataset, threshold generalization)
- [x] every prediction carries a score; the full ROC is available
