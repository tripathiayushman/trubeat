import { useRef, useState } from 'react'
import CodeBlock from '../components/CodeBlock.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// LIVE BACKEND: after deploying the Gradio app to Hugging Face Spaces
// (see Docs → "Deploy the hosted demo"), paste the Space URL here, e.g.
//   'https://tripathiayushman-trubeat.hf.space'
// The page then embeds the real, working tool. Until then it runs honest
// client-side checks and shows exactly how to get a verdict.
// ─────────────────────────────────────────────────────────────────────────────
const DEMO_EMBED_URL = ''

const PIPELINE = [
  { t: 'Decode & track the face', d: 'Frames are decoded (height-capped for memory) and a face landmarker tracks every frame.' },
  { t: 'Extract regional traces', d: 'Forehead and both cheeks are averaged per frame into RGB colour traces.' },
  { t: 'Recover the pulse (POS)', d: 'Signal processing separates the blood-volume waveform from lighting and motion.' },
  { t: 'Consistency verdict', d: 'Coherence, correlation and spectral features produce the three-state verdict — with the evidence shown.' }
]

export default function Demo({ go }) {
  const [file, setFile] = useState(null)
  const [meta, setMeta] = useState(null)
  const [drag, setDrag] = useState(false)
  const videoRef = useRef(null)
  const inputRef = useRef(null)

  const pick = (f) => {
    if (!f) return
    setFile(f)
    setMeta(null)
  }
  const onLoaded = () => {
    const v = videoRef.current
    if (v) setMeta({ duration: v.duration, w: v.videoWidth, h: v.videoHeight })
  }

  return (
    <>
      <div className="page-hero">
        <div className="wrap" style={{ position: 'relative' }}>
          <div className="kicker">Live demo</div>
          <h1>Check a video.<br /><span className="acc">Right here.</span></h1>
          <p>Upload a face video and TrueBeat reads its pulse — region against region — and returns the three-state verdict with the evidence attached. 10–120 seconds, one visible face works best.</p>
        </div>
      </div>

      <section style={{ paddingTop: 6 }}>
        <div className="wrap">
          {DEMO_EMBED_URL ? (
            <div className="embed-frame" data-reveal>
              <iframe src={DEMO_EMBED_URL} title="TrueBeat live demo" allow="camera; microphone" />
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1.15fr .85fr', gap: 22 }} className="demo-grid">
              <div data-reveal>
                <div
                  className={`dropzone ${drag ? 'drag' : ''}`}
                  onClick={() => inputRef.current && inputRef.current.click()}
                  onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]) }}
                >
                  <input ref={inputRef} type="file" accept="video/*" hidden onChange={(e) => pick(e.target.files[0])} />
                  <div className="dic">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
                  </div>
                  <h3 style={{ fontFamily: 'var(--disp)', fontSize: 22, marginBottom: 8 }}>{file ? file.name : 'Drop a video, or click to choose'}</h3>
                  <p style={{ color: 'var(--mut)', fontSize: 14.5 }}>MP4 / WebM / AVI · 10–120 s · one visible face<br />Your file is inspected locally in this browser first — nothing is uploaded by this page.</p>
                </div>

                {file && (
                  <div style={{ marginTop: 18 }}>
                    <video ref={videoRef} src={URL.createObjectURL(file)} controls onLoadedMetadata={onLoaded}
                      style={{ width: '100%', borderRadius: 16, border: '1px solid var(--line2)', background: '#000' }} />
                    <div className="chips" style={{ marginTop: 12 }}>
                      <span className="chip">{(file.size / 1048576).toFixed(1)} MB</span>
                      {meta && <span className="chip">{meta.duration.toFixed(1)} s</span>}
                      {meta && <span className="chip">{meta.w} × {meta.h}</span>}
                      {meta && (meta.duration >= 10
                        ? <span className="chip g">✓ length OK for analysis</span>
                        : <span className="chip" style={{ color: 'var(--amb)', borderColor: 'rgba(255,180,84,.4)' }}>⚠ under 10 s — the pipeline returns “Inconclusive”</span>)}
                    </div>
                  </div>
                )}

                <div className="callout" style={{ marginTop: 22 }}>
                  <b>Hosted analysis is one step away.</b> This website’s upload is wired and ready; the analysis backend (the Gradio app) just needs its free Hugging Face Space — a 3-command deploy from the repo, listed in the Docs under “Deploy the hosted demo”. The moment that URL exists, this page runs the full tool with no other change. Until then, the identical analysis runs locally with the commands on the right.
                </div>
              </div>

              <div className="framed" data-reveal>
                <div className="kicker" style={{ marginBottom: 8 }}>What analysis does</div>
                <div className="steps">
                  {PIPELINE.map((s, i) => (
                    <div className="step-row" key={s.t}>
                      <span className="step-dot">{i + 1}</span>
                      <div><div className="st-t">{s.t}</div><div className="st-d">{s.d}</div></div>
                    </div>
                  ))}
                </div>
                <h3 style={{ fontSize: 17, fontWeight: 700, margin: '26px 0 10px' }}>Run it locally, right now</h3>
                <CodeBlock title="local app — same pipeline" lines={[
                  { k: 'cmd', s: 'git clone https://github.com/tripathiayushman/trubeat && cd trubeat' },
                  { k: 'cmd', s: 'pip install -e .' },
                  { k: 'cmd', s: 'trubeat serve' },
                  { k: 'out', s: '→ http://localhost:7860 — fully private, nothing uploads' }
                ]} />
                <p style={{ color: 'var(--mut)', fontSize: 14, lineHeight: 1.65, marginTop: 14 }}>
                  Privacy note: the hosted demo (once connected) processes your upload on the hosting provider’s machine — use the local app for anything sensitive. The browser extension, now in development, will split the difference: it captures the video playing in your tab and sends it only to a TrueBeat backend <i>you</i> choose.
                </p>
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => go('docs')}>Read the docs</button>
              </div>
            </div>
          )}
          <style>{`@media(max-width:960px){.demo-grid{grid-template-columns:1fr!important}}`}</style>
        </div>
      </section>
    </>
  )
}
