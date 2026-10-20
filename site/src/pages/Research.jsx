import { REPO } from '../components/Nav.jsx'

export default function Research() {
  return (
    <>
      <div className="page-hero">
        <div className="aurora"><i /><i /><i /></div>
        <div className="wrap" style={{ position: 'relative' }}>
          <div className="kicker">Research</div>
          <h1>Two gates failed.<br />Both taught us the truth.</h1>
          <p>TrueBeat’s research program is complete. Its central result is not a passing score — it is a measured map of exactly where pulse-based detection works, where it cannot, and why.</p>
        </div>
      </div>
      <section style={{ paddingTop: 10 }}>
        <div className="wrap docs-body readable" style={{ maxWidth: 900 }}>
          <h2 style={{ marginTop: 0 }}>The idea</h2>
          <p>A real face pulses: every heartbeat changes the blood volume in the skin, and every region of the face shares that one rhythm. A face-swap pastes foreign pixels into the face — pixels with no pulse, or the wrong one. So the check is not “is there a pulse?” (modern fakes can inherit one) but <b style={{ color: 'var(--txt)' }}>“do all regions pulse as one?”</b> — local, spatiotemporal blood-flow consistency.</p>

          <h2>Gate G1 — heart-rate baseline (UBFC-rPPG)</h2>
          <p>Before detecting anything, the pipeline had to prove it could read a pulse at all. On the UBFC-rPPG lab dataset the regions agree to ~1 bpm — the instrument works. Against ground truth, the gate of ≤ 5 bpm MAE was <b style={{ color: 'var(--amb)' }}>failed honestly</b>: POS 8.25 bpm, CHROM 6.77 bpm, with a per-subject failure table tracing the misses to motion-corrupted recordings. The gate was waived by the project owner with conditions, and the motion problem was carried into Phase 2 as tracked work.</p>

          <h2>Gate G2 — deepfake detection (FaceForensics++)</h2>
          <p>On 250 audited test videos the pooled detector scored <b style={{ color: 'var(--txt)' }}>AUC 0.543 (95% CI 0.481–0.611)</b> against a gate of 0.70 — a decisive failure, measured tightly enough that the confidence interval excludes the gate entirely. But pooled was the wrong lens:</p>
          <div className="table-card" style={{ margin: '20px 0' }}>
            <table>
              <thead><tr><th>Manipulation</th><th>Type</th><th>AUC</th><th>95% CI</th><th>Verdict</th></tr></thead>
              <tbody>
                <tr><td>Deepfakes</td><td>Pixel replacement</td><td className="num" style={{ color: 'var(--grn)' }}>0.730</td><td className="num">[0.620, 0.835]</td><td>Detected</td></tr>
                <tr><td>FaceSwap</td><td>Pixel replacement</td><td className="num">0.595</td><td className="num">[0.489, 0.702]</td><td>Weak</td></tr>
                <tr><td>Face2Face</td><td>Reenactment</td><td className="num">0.459</td><td className="num">[0.352, 0.559]</td><td>Blind</td></tr>
                <tr><td>NeuralTextures</td><td>Reenactment</td><td className="num">0.394</td><td className="num">[0.290, 0.508]</td><td>No better than chance</td></tr>
              </tbody>
            </table>
          </div>
          <p>The mechanism reads cleanly. Face-swaps replace the pixels inside the face, so the pulse goes with them — and the loss lands in exactly the features we compute. Reenactment methods re-perform the expression while <b style={{ color: 'var(--txt)' }}>preserving the original performer’s pulse</b> (pulse inheritance), which a blood-flow-consistency detector structurally cannot see. One detectable family, three principled blind spots.</p>

          <h2>The compression hypothesis — tested and refuted</h2>
          <p>The obvious suspect was compression: regions disagree by ~8.6 bpm on c23 video versus ~1 bpm in the lab. So we downloaded 80 lossless videos of the same sources and measured again: <b style={{ color: 'var(--txt)' }}>6.9 bpm (real) vs 6.6 bpm (fake)</b>. Lossless tightens both classes equally; the gap stays zero. Compression is not the cause — the source footage itself carries no class-separating pulse consistency. A Phase-3 CNN was therefore not pursued: with no signal to find, it could only have learned dataset artifacts and called them detection.</p>

          <h2>Methodology notes — the bugs are part of the record</h2>
          <ul>
            <li><b>A label shortcut, caught pre-training (R-14):</b> 144 of 200 fake/original pairs ship at different resolutions. A naive model could have “detected” resolution instead of blood flow. All processing normalizes decode height, and no native-resolution number is ever presented as a physics result.</li>
            <li><b>A dead headline feature:</b> the coherence estimator once used the whole window as one Welch segment, making coherence identically 1.0 on every video — a constant posing as FakeCatcher’s key feature. Found, fixed, regression-tested.</li>
            <li><b>A transposed confusion matrix</b> in an early report swapped the classes (the AUCs were never affected). It was caught by auditing denominators until every count reconciled — 603 downloaded = 603 in manifest = every test video accounted for.</li>
            <li><b>Full disclosure:</b> the test split was consulted three times during development; all four numbers are printed in the report with the reason each was superseded. No parameter was ever chosen by a test score.</li>
          </ul>

          <div className="callout green"><b>The takeaway.</b> Pulse-consistency detection has a real, principled operating envelope: it catches manipulations that replace facial pixels and is blind to manipulations that inherit a living pulse. That envelope — predicted by theory, confirmed by measurement — is the contribution. The full report is <a href={`${REPO}/blob/main/reports/g2_detector.md`} target="_blank" rel="noreferrer" style={{ color: 'var(--grn)' }}>reports/g2_detector.md</a> in the repository, and it is machine-generated from the artifacts so its numbers cannot drift.</div>
        </div>
      </section>
    </>
  )
}
