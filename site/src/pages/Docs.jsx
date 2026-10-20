import CodeBlock from '../components/CodeBlock.jsx'
import { REPO } from '../components/Nav.jsx'

const SIDE = [
  ['#install', 'Install'], ['#quickstart', 'Quickstart'], ['#online', 'Use it online'],
  ['#deploy', 'Deploy the hosted demo'], ['#commands', 'Commands'], ['#verdicts', 'The three verdicts'],
  ['#thresholds', 'Thresholds'], ['#videos', 'What videos work'], ['#extension', 'Browser extension'],
  ['#contribute', 'Contribute'], ['#privacy', 'Privacy'], ['#faq', 'FAQ']
]

export default function Docs({ go }) {
  return (
    <>
      <div className="page-hero">
        <div className="wrap" style={{ position: 'relative' }}>
          <div className="kicker">Documentation</div>
          <h1>Run TrueBeat <span className="acc">anywhere</span></h1>
          <p>One pipeline, four ways in: the online demo, your own hosted copy, the local app and CLI, and — soon — a browser extension. Everything below is free.</p>
        </div>
      </div>
      <section style={{ paddingTop: 20 }}>
        <div className="wrap docs-grid">
          <aside className="docs-side">
            {SIDE.map(([h, l]) => <a key={h} href={h} onClick={(e) => { e.preventDefault(); document.querySelector(h)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>{l}</a>)}
          </aside>
          <div className="docs-body readable">
            <h2 id="install">Install</h2>
            <p>TrueBeat needs <b>Python 3.11 or 3.12</b> (MediaPipe does not yet support 3.13+) and about 2 GB of disk for dependencies. No GPU required — the whole pipeline is CPU.</p>
            <CodeBlock title="install" lines={[
              { k: 'cmd', s: 'git clone https://github.com/tripathiayushman/trubeat && cd trubeat' },
              { k: 'cmd', s: 'python -m venv .venv && source .venv/bin/activate' },
              { k: 'cmd', s: 'pip install -e .' },
              { k: 'cmt', s: '# the face-landmarker model (3.6 MB) downloads on first use into data/models/' }
            ]} />
            <div className="callout green"><b>Dependency pins matter.</b> numpy is held below 2.0 and OpenCV at 4.9 — the repository’s lockstep pins exist because unconstrained installs break MediaPipe. Don’t “fix” them by upgrading.</div>

            <h2 id="quickstart">Quickstart</h2>
            <p>The web app is the fastest way in. It runs the identical pipeline as the CLI — verified score-for-score against the research evaluation path.</p>
            <CodeBlock title="web app" lines={[
              { k: 'cmd', s: 'trubeat serve' },
              { k: 'out', s: '→ http://localhost:7860 · drop in a video, get a verdict + the evidence' },
              { k: 'cmd', s: 'trubeat serve --share' },
              { k: 'out', s: '→ temporary public link for a demo (the video still processes on your machine)' }
            ]} />

            <h2 id="online">Use it online</h2>
            <p>This website’s <a href="#/demo" onClick={(e) => { e.preventDefault(); go('demo') }} style={{ color: 'var(--grn)' }}>Live Demo</a> page runs the same Gradio app in your browser — upload a video, get the three-state verdict with waveforms, heart rates and quality scores attached. One honest difference from running it yourself: on the hosted demo your video is processed on the hosting provider’s machine. For anything sensitive, run it locally — it’s the same tool.</p>

            <h2 id="deploy">Deploy the hosted demo</h2>
            <p>The demo backend is the repo’s Gradio app, hosted free on Hugging Face Spaces. From a clone of the repository:</p>
            <CodeBlock title="deploy to Hugging Face Spaces (free)" lines={[
              { k: 'cmd', s: 'cd trubeat && pip install gradio' },
              { k: 'cmd', s: 'gradio deploy' },
              { k: 'out', s: '→ log in to Hugging Face, point it at the app (src/trubeat/app.py),' },
              { k: 'out', s: '  and it creates a free Space under your account' }
            ]} />
            <p>That’s the whole backend. The Space URL is the only thing the website needs — it drops into one line of the demo page and uploads go live.</p>

            <h2 id="commands">Commands</h2>
            <CodeBlock title="cli" lines={[
              { k: 'cmt', s: '# heart rate from a face video' },
              { k: 'cmd', s: 'trubeat hr --video clip.mp4' },
              { k: 'cmt', s: '# real / fake verdict with the features behind it' },
              { k: 'cmd', s: 'trubeat predict --video clip.mp4 --model models/detector.joblib' },
              { k: 'cmt', s: '# evaluate a labelled dataset (manifest CSV)' },
              { k: 'cmd', s: 'trubeat eval --dataset data/manifests/ffpp_c23.csv --task hr' },
              { k: 'cmt', s: '# train the detector on cached traces' },
              { k: 'cmd', s: 'trubeat train --dataset data/manifests/ffpp_c23_qc.csv' }
            ]} />
            <p>Every command works offline. If <code>models/detector.joblib</code> is missing, the app and <code>predict</code> fall back to a pulse/HR analysis and say plainly that no real/fake call is possible.</p>

            <h2 id="verdicts">The three verdicts</h2>
            <p>TrueBeat never prints a bare REAL or FAKE. Each result is one of three states, and the quality gates run <i>before</i> the detector — a bad video is inconclusive no matter what the classifier says.</p>
            <div className="table-card" style={{ margin: '18px 0' }}>
              <table>
                <thead><tr><th>Verdict</th><th>Meaning</th></tr></thead>
                <tbody>
                  <tr><td><b style={{ color: 'var(--grn)' }}>Pulse consistent</b></td><td>Regions agree on one pulse and the detector score is on the real side. Consistent with a living face.</td></tr>
                  <tr><td><b style={{ color: 'var(--red)' }}>Pulse inconsistent</b></td><td>The pixel-replacement pattern: part of the face lost a pulse the rest kept. The face-swap signature.</td></tr>
                  <tr><td><b style={{ color: 'var(--amb)' }}>Inconclusive</b></td><td>Under 10 s, no trackable face, face visible in under 70% of frames, or no measurable pulse. No guess is made.</td></tr>
                </tbody>
              </table>
            </div>

            <h2 id="thresholds">Thresholds — calibrated, not guessed</h2>
            <div className="table-card" style={{ margin: '18px 0' }}>
              <table>
                <thead><tr><th>Gate</th><th>Value</th><th>Why</th></tr></thead>
                <tbody>
                  <tr><td>Region agreement</td><td className="num">≤ 5 bpm</td><td>On UBFC, clean subjects agree to ~0.03 bpm; a corrupted region sits at ~21 bpm. Bimodal — 5 separates cleanly.</td></tr>
                  <tr><td>Minimum SNR</td><td className="num">≥ 10</td><td>No-signal measures 0; a real pulse measures 33–75. Ten is an order of magnitude above noise.</td></tr>
                  <tr><td>Face visible</td><td className="num">≥ 70% of frames</td><td>Below this, the trace is mostly interpolation, not measurement.</td></tr>
                  <tr><td>Detector threshold</td><td className="num">−0.0128</td><td>Tuned on the validation split (Youden’s J) during the G2 study; shipped in the model bundle.</td></tr>
                </tbody>
              </table>
            </div>

            <h2 id="videos">What videos work</h2>
            <ul>
              <li><b>Length:</b> 10–120 seconds. Shorter than 10 s is rejected — there isn’t enough signal to measure.</li>
              <li><b>Face:</b> one face, reasonably large and front-facing. Wide broadcast shots with a small off-centre subject often return “inconclusive”.</li>
              <li><b>Quality:</b> the less compressed, the better. Heavily compressed social-media video frequently has no recoverable pulse at all — that is a finding of the research, not a bug.</li>
              <li><b>Lighting:</b> steady light beats dramatic light. Flicker and hard motion corrupt every region at once.</li>
            </ul>

            <h2 id="extension">Browser extension — in development</h2>
            <p>The extension brings the check to wherever the video already is. Click it on any tab and it captures the video currently playing on screen, sends it to a TrueBeat backend <b>you</b> choose (your local app by default), and overlays the verdict on the page — pulse-consistent, pixel-replacement pattern, or inconclusive, with the evidence one click deeper.</p>
            <ul>
              <li><b>Capture:</b> works on standard web video (news sites, YouTube, social feeds). DRM-protected streams return black frames — the extension will say “can’t capture this” rather than guess.</li>
              <li><b>Privacy:</b> the capture goes only to your configured backend. Nothing is sent to any third party, ever.</li>
              <li><b>Engine:</b> it calls the same <code>analyze_video()</code> API the web app exposes — no second implementation to drift.</li>
              <li><b>Status:</b> in development (Phase 4b). Watch the <a href={REPO} target="_blank" rel="noreferrer" style={{ color: 'var(--grn)' }}>repository</a> for the first release.</li>
            </ul>

            <h2 id="contribute">Contribute</h2>
            <p>Contributions are welcome — especially motion-robust trace conditioning, the known open problem from the G1 failure table. The workflow:</p>
            <CodeBlock title="contribute" lines={[
              { k: 'cmt', s: '# 1 · fork the repo on GitHub, then clone your fork' },
              { k: 'cmd', s: 'git clone https://github.com/<your-username>/trubeat && cd trubeat' },
              { k: 'cmd', s: 'git checkout -b feat/my-change' },
              { k: 'cmd', s: 'python -m venv .venv && source .venv/bin/activate && pip install -e .' },
              { k: 'cmt', s: '# 2 · make the change, then prove it' },
              { k: 'cmd', s: 'pytest -q' },
              { k: 'cmd', s: 'ruff check .' },
              { k: 'cmt', s: '# 3 · push and open a pull request against main' },
              { k: 'cmd', s: 'git push -u origin feat/my-change' }
            ]} />
            <p>House rules, learned the hard way: every bug fix lands with a regression test; claims are measured, not asserted; never present a native-resolution FaceForensics++ number as a physics result (the resolution shortcut, R-14); report detection per manipulation family, never pooled-only (R-17).</p>

            <h2 id="privacy">Privacy</h2>
            <p>Face video is biometric data, so TrueBeat is offline by architecture, not by policy: no uploads, no accounts, no analytics, no network calls in the inference path. If you host the app for others (e.g. on Hugging Face Spaces), uploads reach that host — the local app never sends anything anywhere.</p>

            <h2 id="faq">FAQ</h2>
            <h3>Can it detect Face2Face or NeuralTextures fakes?</h3>
            <p>No — and it will tell you so. Those methods re-enact a real performance and keep the original pulse (pulse inheritance), so a blood-flow check has nothing to catch. TrueBeat detects the face-swap family. The full evidence is in the <a href={`${REPO}/blob/main/reports/g2_detector.md`} target="_blank" rel="noreferrer" style={{ color: 'var(--grn)' }}>research report</a>.</p>
            <h3>Why did my video come back “inconclusive”?</h3>
            <p>One of the quality gates failed: too short, no trackable face, low face coverage, or no measurable pulse. On heavily compressed footage this is common and expected — the honest answer is that the signal isn’t there.</p>
            <h3>Does a “pulse consistent” verdict guarantee a video is real?</h3>
            <p>No. It means the pulse evidence is consistent with a real face. It is one signal, strongest against face-swaps, and blind to reenactment by design. Treat it as evidence, not proof.</p>
            <h3>What hardware do I need?</h3>
            <p>Any modern laptop CPU. Expect roughly 20 seconds of processing per minute of video.</p>
          </div>
        </div>
      </section>
    </>
  )
}
