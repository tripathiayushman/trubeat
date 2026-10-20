import { PulseMark, REPO } from './Nav.jsx'

export default function Footer({ go }) {
  const jump = (id) => (e) => { e.preventDefault(); go(id) }
  return (
    <footer>
      <div className="wrap">
        <div className="foot-giant">True<span className="outl">Beat</span></div>
        <div className="foot-grid">
          <div>
            <a className="logo" href="#/home" onClick={jump('home')} style={{ marginBottom: 16 }}>
              <span className="pulse-mark"><PulseMark /></span>TrueBeat
            </a>
            <p style={{ color: 'var(--mut)', fontSize: 14.5, lineHeight: 1.7, maxWidth: 300, marginTop: 14 }}>
              Pulse-consistency deepfake detection. Open-source research that publishes its blind spots next to its wins.
            </p>
          </div>
          <div>
            <h4>Product</h4>
            <a href="#/demo" onClick={jump('demo')}>Live demo — check a video</a>
            <a href="#/docs" onClick={jump('docs')}>Documentation</a>
            <a href="#/docs" onClick={jump('docs')}>Quickstart</a>
            <a href="#/research" onClick={jump('research')}>Research results</a>
          </div>
          <div>
            <h4>Project</h4>
            <a href={REPO} target="_blank" rel="noreferrer">GitHub repository</a>
            <a href={`${REPO}/blob/main/reports/g2_detector.md`} target="_blank" rel="noreferrer">Full G2 report</a>
            <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">Issues</a>
          </div>
          <div>
            <h4>Principles</h4>
            <a href="#/research" onClick={jump('research')}>Failed gates, published</a>
            <a href="#/research" onClick={jump('research')}>Per-method honesty</a>
            <a href="#/docs" onClick={jump('docs')}>Offline &amp; private</a>
          </div>
        </div>
        <div className="foot-note">
          <span>TrueBeat — MIT licensed. Built with OpenCV, MediaPipe &amp; scikit-learn.</span>
          <span className="mono">no servers · no uploads · no tracking</span>
        </div>
      </div>
    </footer>
  )
}
