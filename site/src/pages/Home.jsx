import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import SplitText from '../bits/SplitText.jsx'
import BlurText from '../bits/BlurText.jsx'
import CountUp from '../bits/CountUp.jsx'
import WordReveal from '../bits/WordReveal.jsx'
import Magnetic from '../bits/Magnetic.jsx'
import EcgLine from '../bits/EcgLine.jsx'
import RotatingBadge from '../bits/RotatingBadge.jsx'
import VelocityMarquee from '../bits/VelocityMarquee.jsx'
import CodeBlock from '../components/CodeBlock.jsx'
import { REPO } from '../components/Nav.jsx'

gsap.registerPlugin(ScrollTrigger)

const STEPS = [
  { n: '01', t: 'Decode & track', d: 'The video is decoded and a face landmarker tracks the face in every frame — no cloud, no upload, just your CPU.', pos: { left: '1%', top: '2%' } },
  { n: '02', t: 'Read three regions', d: 'Forehead and both cheeks are averaged frame by frame into colour traces — the raw material of the pulse.', pos: { left: '26%', bottom: '0%' } },
  { n: '03', t: 'Extract the pulse', d: 'POS signal processing separates the blood-volume waveform from lighting and motion noise, region by region.', pos: { left: '51%', top: '2%' } },
  { n: '04', t: 'Check consistency', d: 'Coherence, correlation and spectral features feed the verdict. A swapped face breaks the sync.', pos: { left: '75%', bottom: '0%' } }
]

function HowStage() {
  const stageRef = useRef(null)
  const pathRef = useRef(null)
  useEffect(() => {
    const mm = gsap.matchMedia()
    mm.add('(min-width: 821px)', () => {
      const path = pathRef.current
      const len = path.getTotalLength()
      gsap.set(path, { strokeDasharray: len, strokeDashoffset: len })
      const tl = gsap.timeline({
        scrollTrigger: { trigger: stageRef.current, start: 'top top+=84', end: '+=1500', pin: true, scrub: 1, anticipatePin: 1 }
      })
      tl.to(path, { strokeDashoffset: 0, duration: 4, ease: 'none' }, 0)
        .from(stageRef.current.querySelectorAll('.hstep'),
          { scale: 0.5, opacity: 0, y: 30, stagger: 0.85, duration: 0.7, ease: 'back.out(2.2)' }, 0.2)
      return () => { tl.scrollTrigger && tl.scrollTrigger.kill(); tl.kill() }
    })
    return () => mm.revert()
  }, [])
  return (
    <div className="how-stage" ref={stageRef}>
      <svg className="how-svg" viewBox="0 0 1200 230" preserveAspectRatio="none" aria-hidden="true">
        <path ref={pathRef} fill="none" strokeWidth="3"
          d="M0 115 h180 l14-34 l18 92 l14-58 h220 l12-26 l16 66 l12-40 h228 l14-34 l18 92 l14-58 h218 l12-26 l16 66 l12-40 h172" />
        <circle cx="190" cy="115" r="8" /><circle cx="452" cy="115" r="8" />
        <circle cx="722" cy="115" r="8" /><circle cx="984" cy="115" r="8" />
      </svg>
      {STEPS.map((s) => (
        <article className="hstep" key={s.n} style={s.pos}>
          <div className="n">{s.n}</div>
          <h3>{s.t}</h3>
          <p>{s.d}</p>
        </article>
      ))}
    </div>
  )
}

function AucCounter() {
  const numRef = useRef(null)
  useEffect(() => {
    const obj = { v: 0 }
    const tween = gsap.to(obj, {
      v: 0.5434, ease: 'none',
      scrollTrigger: { trigger: numRef.current, start: 'top 82%', end: 'top 30%', scrub: 0.5 },
      onUpdate: () => { if (numRef.current) numRef.current.textContent = obj.v.toFixed(4) }
    })
    return () => { tween.scrollTrigger && tween.scrollTrigger.kill(); tween.kill() }
  }, [])
  return <span ref={numRef}>0.0000</span>
}

const AUC = [
  { name: 'Deepfakes', note: 'face-swap · autoencoder', auc: 0.730, color: 'repeating-linear-gradient(45deg,var(--ok) 0 14px,#27a566 14px 28px)' },
  { name: 'FaceSwap', note: 'face-swap · 3D graphics', auc: 0.595, color: 'repeating-linear-gradient(45deg,var(--amb) 0 14px,#cf8f00 14px 28px)' },
  { name: 'Face2Face', note: 'reenactment · expression transfer', auc: 0.459, color: 'repeating-linear-gradient(45deg,var(--red) 0 14px,#c23342 14px 28px)', o: 0.75 },
  { name: 'NeuralTextures', note: 'reenactment · mouth region only', auc: 0.394, color: 'repeating-linear-gradient(45deg,var(--red) 0 14px,#c23342 14px 28px)' }
]

const STACK = [
  { cls: 's-ink', tag: 'Private by physics', big: 'Nothing leaves your machine', p: 'Face video is biometric data. Run TrueBeat locally and the analysis happens where the video already lives — no uploads, no API keys, no telemetry. The hosted demo is the one exception, and it says so before you upload.' },
  { cls: 's-org', tag: 'Evidence, not labels', big: 'Every verdict shows its work', p: 'Waveforms, heart rates, region agreement, quality scores — the full measurement ships with every answer, so anyone can argue with it on the merits.' },
  { cls: 's-paper', tag: 'Honesty', big: '“Inconclusive” is an answer', p: 'Under 10 seconds, no trackable face, no measurable pulse — the tool says so instead of inventing a verdict. A detector that never abstains is a detector that lies on schedule.' },
  { cls: 's-ink', tag: 'Open', big: 'Free forever. MIT. No paid services.', p: 'Every phase of this project runs on free and open-source tooling only. Clone it, fork it, ship it — the license is the business model: there isn’t one.' },
  { cls: 's-org', tag: 'Accessible', big: 'One function. Every door.', p: 'The whole analysis is a single pure function — analyze_video() — already exposed as an API. This website, the CLI, and the browser extension in development are just doors into it.' }
]

export default function Home({ go }) {
  const rootRef = useRef(null)
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo('.bgword', { xPercent: 6 }, {
        xPercent: -20, ease: 'none',
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 0.6 }
      })
      gsap.utils.toArray('.strip-fill').forEach((el) => {
        gsap.fromTo(el, { width: '0%' }, {
          width: el.dataset.w + '%', ease: 'none',
          scrollTrigger: { trigger: el, start: 'top 92%', end: 'top 45%', scrub: 0.5 }
        })
      })
      gsap.utils.toArray('[data-px]').forEach((el) => {
        const amt = parseFloat(el.dataset.px)
        gsap.fromTo(el, { x: amt }, {
          x: -amt, ease: 'none',
          scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: 0.7 }
        })
      })
    }, rootRef)
    return () => ctx.revert()
  }, [])

  return (
    <div ref={rootRef}>
      {/* HERO */}
      <div className="hero">
        <div className="bgword" style={{ top: '16%', right: '-2%', fontSize: '23vw' }}>PULSE</div>
        <div className="wrap" style={{ position: 'relative' }}>
          <span className="sticker">Open-source rPPG research — MIT</span>
          <RotatingBadge />
          <h1>
            <SplitText text="Deepfakes fake the face." /><br />
            <span className="acc"><SplitText text="Not the pulse." delay={0.35} /></span>
          </h1>
          <p className="sub">
            <BlurText as="span" delay={0.55} text="TrueBeat reads the blood-flow signal hidden in face video and checks whether every region pulses as one — catching face-swap fakes, and telling you plainly which fakes it can't see." />
          </p>
          <div className="hero-cta">
            <Magnetic><button className="btn btn-grn" onClick={() => go('demo')}>Check a video →</button></Magnetic>
            <Magnetic><button className="btn btn-ghost" onClick={() => go('research')}>Read the research</button></Magnetic>
          </div>
          <div className="ecg-box"><EcgLine /></div>
          <div className="stats">
            <div className="stat"><div className="num"><CountUp end={0.73} decimals={2} /></div><div className="lbl">AUC on Deepfakes — the fake family this method can see</div></div>
            <div className="stat"><div className="num"><CountUp end={565} /></div><div className="lbl">videos in the fully audited evaluation set</div></div>
            <div className="stat"><div className="num"><CountUp end={3} /></div><div className="lbl">verdict states — never a bare real / fake stamp</div></div>
            <div className="stat"><div className="num"><CountUp end={0} /></div><div className="lbl">uploads when you run it locally — your machine, your video</div></div>
          </div>
          <div className="scroll-hint">Scroll — everything moves</div>
        </div>
      </div>

      <VelocityMarquee>
        {[0, 1].map((k) => (
          <span key={k}>Deepfake detection <i>✦</i> Pulse-consistency <i>✦</i> Inter-ROI coherence <i>✦</i> Offline by design <i>✦</i> Open source <i>✦</i> Evidence, not labels <i>✦</i> </span>
        ))}
      </VelocityMarquee>

      {/* MANIFESTO */}
      <section>
        <div className="wrap">
          <div className="kicker" data-reveal>01 — The idea</div>
          <WordReveal className="manifesto" text="A real face is not a picture. It is _one heart,_ _one rhythm,_ shared by every millimetre of skin. A face-swap pastes in pixels that _never had a pulse._ TrueBeat measures the rhythm, region against region, and asks the one question a fake cannot rehearse: _does this face pulse as one?_" />
        </div>
      </section>

      {/* HOW */}
      <section style={{ paddingTop: 10 }}>
        <div className="wrap">
          <div className="sec-head" data-reveal>
            <div className="kicker">02 — How it works</div>
            <h2>One signal, checked <span className="acc">four ways</span></h2>
            <p>Scroll slowly — the pulse draws itself across the screen and each stage pops as the beat reaches it.</p>
          </div>
          <HowStage />
        </div>
      </section>

      {/* RESULTS */}
      <section>
        <div className="wrap">
          <div className="sec-head" data-reveal>
            <div className="kicker">03 — The honest results</div>
            <h2>We failed the gate. <span className="acc">In public.</span></h2>
            <p>Pooled across every fake type, TrueBeat scored below against a 0.70 gate — a decisive failure. But the failure has a shape, and the shape is the science. Watch it count:</p>
          </div>
          <div className="giant-num" data-reveal><AucCounter /></div>
          <p style={{ color: 'var(--mut)', maxWidth: 520, lineHeight: 1.65, fontSize: 15.5, margin: '18px 0 40px' }} data-reveal>
            The pooled AUC we publish — not hide. Split by manipulation family, it resolves into one clear detection and three principled blind spots:
          </p>
          {AUC.map((r) => (
            <div className="astrip" key={r.name}>
              <div className="astrip-top">
                <div className="name">{r.name}<small>{r.note}</small></div>
                <div className="val">{r.auc.toFixed(2)}</div>
              </div>
              <div className="strip-track">
                <div className="chance-mark" /><span className="chance-lab">CHANCE 0.50</span>
                <div className="strip-fill" data-w={r.auc * 100} style={{ background: r.color, opacity: r.o || 1 }} />
              </div>
            </div>
          ))}
          <div className="chance-note">FaceForensics++ c23 · n = 250 test videos · per-method AUC vs the same 135 real videos</div>

          <div className="vbands">
            <div data-reveal><div className="vband vb-real">
              <span className="pill">● PULSE CONSISTENT</span>
              <h3>Likely real</h3>
              <p>Quality gates pass and the regions agree on one pulse. The face is behaving like living tissue.</p>
            </div></div>
            <div data-reveal><div className="vband vb-fake">
              <span className="pill">● PULSE INCONSISTENT</span>
              <h3>Pixel-replacement pattern</h3>
              <p>The signature of a face-swap: the swapped region lost the pulse the rest of the face still has.</p>
            </div></div>
            <div data-reveal><div className="vband vb-inc">
              <span className="pill">● INCONCLUSIVE</span>
              <h3>We won’t guess</h3>
              <p>No face, too short, or quality too low to read a pulse. The tool says so instead of inventing a verdict.</p>
            </div></div>
          </div>
        </div>
      </section>

      {/* WAYS */}
      <section style={{ paddingTop: 20 }}>
        <div className="wrap">
          <div className="sec-head" data-reveal>
            <div className="kicker">04 — Use it your way</div>
            <h2>Three doors, <span className="acc">same pulse</span></h2>
          </div>
          <div className="wayrow" data-px="-34">
            <div className="idx">01</div>
            <div>
              <h3>Check online</h3>
              <p>Upload a video right here in your browser and get the three-state verdict with the evidence attached. Nothing to install — the hosted demo runs the same pipeline.</p>
            </div>
            <div className="side">
              <span className="sticker org">● Live</span>
              <button className="btn btn-grn btn-sm" onClick={() => go('demo')}>Open the live demo</button>
            </div>
          </div>
          <div className="wayrow" data-px="34">
            <div className="idx">02</div>
            <div>
              <h3>Run it locally</h3>
              <p>The private route: clone, install, and the full app runs on your machine. Your videos never leave it. Web UI and CLI included, MIT licensed, free forever.</p>
            </div>
            <div className="side">
              <span className="sticker org">● Live</span>
              <button className="btn btn-ghost btn-sm" onClick={() => go('docs')}>Install commands</button>
            </div>
          </div>
          <div className="wayrow" data-px="-34">
            <div className="idx">03</div>
            <div>
              <h3>Browser extension</h3>
              <p>One click on any tab: it captures the video playing on your screen, runs the pulse check, and overlays the verdict on the page. It talks only to a TrueBeat backend you choose — your own, by default.</p>
            </div>
            <div className="side">
              <span className="sticker">In development</span>
              <button className="btn btn-ghost btn-sm" onClick={() => go('docs')}>How it will work</button>
            </div>
          </div>
        </div>
      </section>

      {/* BENEFITS — sticky stacking fields */}
      <section style={{ padding: 0 }}>
        {STACK.map((s, i) => (
          <div className={`stack-item ${s.cls}`} key={s.tag} style={{ top: `calc(66px + ${i * 10}px)`, zIndex: i + 1 }}>
            <div className="wrap" style={{ width: '100%' }}>
              <div className="tag">{String(i + 1).padStart(2, '0')} — {s.tag}</div>
              <div className="big">{s.big}</div>
              <p>{s.p}</p>
            </div>
          </div>
        ))}
      </section>

      {/* TRY IT */}
      <section>
        <div className="wrap">
          <div className="sec-head center" data-reveal>
            <div className="kicker">05 — Try it now</div>
            <h2>Running in <span className="acc">two minutes</span></h2>
            <p>No accounts, no keys. Clone, install, and the web app opens in your browser — or skip installing entirely and use the live demo.</p>
          </div>
          <div className="term-tilt" style={{ maxWidth: 760, margin: '0 auto' }} data-reveal>
            <CodeBlock lines={[
              { k: 'cmd', s: 'git clone https://github.com/tripathiayushman/trubeat && cd trubeat' },
              { k: 'cmd', s: 'pip install -e .' },
              { k: 'cmd', s: 'trubeat serve' },
              { k: 'out', s: '→ web app at http://localhost:7860 — drop in a video, get a verdict' }
            ]} />
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="cta-final">
        <div className="wrap">
          <div className="kicker" style={{ color: '#0d0d0d' }} data-reveal>The bottom line</div>
          <h2 data-reveal>The pulse doesn’t lie.<br />Neither do we.</h2>
          <p data-reveal>Read the full research — both failed gates, the refuted compression hypothesis, and every bug we caught along the way. Or just check a video.</p>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }} data-reveal>
            <Magnetic><button className="btn btn-ink" onClick={() => go('demo')}>Check a video</button></Magnetic>
            <a href={REPO} target="_blank" rel="noreferrer" className="mono" style={{ fontWeight: 700, fontSize: 14, textDecoration: 'underline', textUnderlineOffset: 4 }}>github.com/tripathiayushman/trubeat ↗</a>
          </div>
        </div>
      </section>
    </div>
  )
}
