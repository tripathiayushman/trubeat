import CodeBlock from '../components/CodeBlock.jsx'
import { GhIcon, REPO } from '../components/Nav.jsx'

export default function Github() {
  return (
    <>
      <div className="page-hero">
        <div className="wrap" style={{ position: 'relative' }}>
          <div className="kicker">Open source</div>
          <h1>Every number here<br /><span className="acc">traces to this repo</span></h1>
          <p>The code, the manifests, the risk register, the failed-gate reports — all of it is public, MIT licensed, and reproducible.</p>
        </div>
      </div>
      <section style={{ paddingTop: 10 }}>
        <div className="wrap">
          <div className="repo-card shine-border" data-reveal>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <GhIcon size={30} />
              <span className="path">tripathiayushman / <b>trubeat</b></span>
              <span className="chip g">Public</span>
              <span className="chip">MIT License</span>
            </div>
            <p style={{ color: 'var(--mut)', lineHeight: 1.7, marginTop: 18, maxWidth: 640, fontSize: 15.5 }}>
              Offline deepfake detection from the human pulse: rPPG signal extraction, inter-region consistency features, an audited FaceForensics++ evaluation, a Gradio web app, and a CLI. Includes the reports for both research gates — the failures included, on purpose.
            </p>
            <div className="chips">
              <span className="chip">Python 3.11 / 3.12</span><span className="chip">MediaPipe</span><span className="chip">OpenCV</span>
              <span className="chip">scikit-learn</span><span className="chip">Gradio</span><span className="chip">131 tests</span>
              <span className="chip g">CI green</span><span className="chip">DVC-tracked data</span>
            </div>
            <div style={{ display: 'flex', gap: 14, marginTop: 28, flexWrap: 'wrap' }}>
              <a className="btn btn-grn" href={REPO} target="_blank" rel="noreferrer"><GhIcon size={17} /> View the repository</a>
              <a className="btn btn-ghost" href={`${REPO}/blob/main/reports/g2_detector.md`} target="_blank" rel="noreferrer">Read the G2 report</a>
              <a className="btn btn-ghost" href={`${REPO}/issues`} target="_blank" rel="noreferrer">Open an issue</a>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, marginTop: 26 }} className="repo-split">
            <div data-reveal>
              <h3 style={{ fontFamily: 'var(--disp)', fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Clone &amp; run</h3>
              <CodeBlock title="get the code" lines={[
                { k: 'cmd', s: 'git clone https://github.com/tripathiayushman/trubeat' },
                { k: 'cmd', s: 'cd trubeat && pip install -e .' },
                { k: 'cmd', s: 'trubeat serve' },
                { k: 'out', s: '→ http://localhost:7860' }
              ]} />
            </div>
            <div className="docs-body" data-reveal>
              <h3 style={{ fontFamily: 'var(--disp)', fontSize: 20, fontWeight: 700, marginBottom: 12 }}>What’s inside</h3>
              <ul>
                <li><code>src/trubeat/</code> — ingest, face tracking, ROI traces, POS/CHROM pulse extraction, features, detector, CLI and the web app</li>
                <li><code>reports/g2_detector.md</code> — the central research document, machine-generated from the artifacts</li>
                <li><code>reports/HUMAN_GATES.md</code> — every human gate decision, including the G1 waiver and its conditions</li>
                <li><code>docs/</code> — design, data strategy, risk register (R-01 → R-17) and phase gates</li>
              </ul>
            </div>
          </div>

          <div style={{ marginTop: 54 }} data-reveal>
            <div className="sec-head" style={{ marginBottom: 26 }}>
              <div className="kicker">Contribute</div>
              <h2 style={{ fontSize: 'clamp(26px,3.4vw,38px)' }}>Fork it. <span className="acc">Fix it. Prove it.</span></h2>
              <p>The most wanted contribution: motion-robust trace conditioning — the open problem behind the G1 failure table. Whatever you bring, the bar is the project’s rule: measure honestly, and publish the failures too.</p>
            </div>
            <div style={{ maxWidth: 780 }}>
              <CodeBlock title="contribute" lines={[
                { k: 'cmt', s: '# fork on GitHub first, then:' },
                { k: 'cmd', s: 'git clone https://github.com/<your-username>/trubeat && cd trubeat' },
                { k: 'cmd', s: 'git checkout -b feat/my-change' },
                { k: 'cmd', s: 'python -m venv .venv && source .venv/bin/activate && pip install -e .' },
                { k: 'cmt', s: '# change something, then prove it' },
                { k: 'cmd', s: 'pytest -q && ruff check .' },
                { k: 'cmd', s: 'git push -u origin feat/my-change' },
                { k: 'out', s: '→ open a pull request against main' }
              ]} />
            </div>
            <div className="chips" style={{ marginTop: 20 }}>
              <span className="chip">regression test with every bug fix</span>
              <span className="chip">measured claims only</span>
              <span className="chip">per-family metrics, never pooled-only</span>
              <span className="chip g">inference stays offline</span>
            </div>
          </div>
          <style>{`@media(max-width:860px){.repo-split{grid-template-columns:1fr!important}}`}</style>
        </div>
      </section>
    </>
  )
}
