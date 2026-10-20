import { useCallback, useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import Nav from './components/Nav.jsx'
import Footer from './components/Footer.jsx'
import BgFx from './components/BgFx.jsx'
import { THEME } from './theme.js'
import Home from './pages/Home.jsx'
import Demo from './pages/Demo.jsx'
import Docs from './pages/Docs.jsx'
import Research from './pages/Research.jsx'
import Github from './pages/Github.jsx'

gsap.registerPlugin(ScrollTrigger)

const PAGES = { home: Home, demo: Demo, docs: Docs, research: Research, github: Github }

function Loader() {
  const ref = useRef(null)
  const cntRef = useRef(null)
  const barRef = useRef(null)
  useEffect(() => {
    const obj = { v: 0 }
    const tl = gsap.timeline()
    tl.to(obj, {
      v: 100, duration: 1.05, ease: 'power2.inOut',
      onUpdate: () => {
        if (cntRef.current) cntRef.current.innerHTML = Math.round(obj.v) + '<em>%</em>'
        if (barRef.current) barRef.current.style.transform = `scaleX(${obj.v / 100})`
      }
    })
      .to(ref.current, { yPercent: -100, duration: 0.7, ease: 'expo.inOut' }, '+=0.12')
      .set(ref.current, { display: 'none' })
    const safety = setTimeout(() => { if (ref.current) ref.current.style.display = 'none' }, 3400)
    return () => { clearTimeout(safety); tl.kill() }
  }, [])
  return (
    <div className="loader" ref={ref}>
      <div className="cnt" ref={cntRef}>0<em>%</em></div>
      <div className="bar"><i ref={barRef} /></div>
      <div className="lbl">TrueBeat — loading the pulse</div>
    </div>
  )
}

function ProgressRail() {
  const fillRef = useRef(null)
  const dotRef = useRef(null)
  const pctRef = useRef(null)
  useEffect(() => {
    let s = 0, raf = 0
    const loop = () => {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
      const t = Math.min(1, Math.max(0, window.scrollY / max))
      s += (t - s) * 0.12
      if (fillRef.current) fillRef.current.style.height = (s * 100) + '%'
      if (dotRef.current) dotRef.current.style.top = (s * 100) + '%'
      if (pctRef.current) pctRef.current.textContent = String(Math.round(s * 100)).padStart(3, '0')
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="prail" aria-hidden="true">
      <div className="ptrack"><div className="pfill" ref={fillRef} /><div className="pdot" ref={dotRef} /></div>
      <div className="ppct" ref={pctRef}>000</div>
    </div>
  )
}

function pageFromHash() {
  const h = window.location.hash.replace('#/', '').replace('#', '')
  return PAGES[h] ? h : 'home'
}

export default function App() {
  const [page, setPage] = useState(pageFromHash)

  useEffect(() => { document.documentElement.dataset.theme = THEME }, [])

  const go = useCallback((id) => {
    if (pageFromHash() !== id) window.location.hash = '#/' + id
    setPage(id)
  }, [])

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Lenis buttery smooth scroll, driven by GSAP's ticker (the award-site stack).
  useEffect(() => {
    const lenis = new Lenis({ lerp: 0.09, smoothWheel: true })
    window.__lenis = lenis
    lenis.on('scroll', ScrollTrigger.update)
    const tick = (time) => lenis.raf(time * 1000)
    gsap.ticker.add(tick)
    gsap.ticker.lagSmoothing(0)
    return () => { gsap.ticker.remove(tick); lenis.destroy(); window.__lenis = null }
  }, [])

  // Per-page: reset scroll + GSAP scroll-reveal system for [data-reveal].
  useEffect(() => {
    if (window.__lenis) window.__lenis.scrollTo(0, { immediate: true })
    window.scrollTo(0, 0)
    const ctx = gsap.context(() => {
      gsap.utils.toArray('[data-reveal]').forEach((el) => {
        gsap.fromTo(el, { opacity: 0, y: 36 }, {
          opacity: 1, y: 0, duration: 1, ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 90%', once: true }
        })
      })
    })
    const t = setTimeout(() => ScrollTrigger.refresh(), 150)
    return () => { clearTimeout(t); ctx.revert() }
  }, [page])

  const Page = PAGES[page]
  const wipeRef = useRef(null)
  const firstRef = useRef(true)

  // Orange wipe on page change.
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return }
    const w = wipeRef.current
    if (!w) return
    gsap.timeline()
      .set(w, { transformOrigin: 'bottom', scaleY: 0 })
      .to(w, { scaleY: 1, duration: 0.3, ease: 'power3.in' })
      .set(w, { transformOrigin: 'top' })
      .to(w, { scaleY: 0, duration: 0.36, ease: 'power3.out' }, '+=0.05')
  }, [page])

  return (
    <>
      <Loader />
      <div className="wipe" ref={wipeRef} />
      <ProgressRail />
      <BgFx />
      <Nav page={page} go={go} />
      <main key={page}>
        <Page go={go} />
      </main>
      <Footer go={go} />
    </>
  )
}
