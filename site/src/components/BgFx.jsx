import { useEffect, useRef } from 'react'

// Fixed backdrop, per theme:
//  a — notebook rules (CSS)          b — blueprint grid (CSS)
//  c — slow warm gradient drift (CSS)
// Shared: one ECG trace fixed across the viewport that DRAWS itself as you
// scroll (stroke-dashoffset follows damped scroll progress) and drifts
// slightly — the background moves with the reading, by design, not particles.
export default function BgFx() {
  const pathRef = useRef(null)
  const wrapRef = useRef(null)

  useEffect(() => {
    const path = pathRef.current
    if (!path) return
    const len = path.getTotalLength()
    path.style.strokeDasharray = String(len)
    path.style.strokeDashoffset = String(len)
    let smooth = 0
    let raf = 0
    const loop = () => {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
      const target = Math.min(1, Math.max(0, window.scrollY / max))
      smooth += (target - smooth) * 0.06
      path.style.strokeDashoffset = String(len * (1 - smooth * 0.92))
      if (wrapRef.current) wrapRef.current.style.transform = `translateY(${-smooth * 46}px)`
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // one pulse complex, tiled across a wide viewBox
  const beat = 'h70 l10 -14 l12 40 l10 -26 h90 l8 -10 l10 22 l8 -12 h110'
  const d = `M0 60 ${Array(6).fill(beat).join(' ')}`
  return (
    <div className="bgfx" aria-hidden="true">
      <div className="bgfx-layer" />
      <div className="bgfx-ecg" ref={wrapRef}>
        <svg viewBox="0 0 1900 120" preserveAspectRatio="none">
          <path ref={pathRef} d={d} fill="none" strokeWidth="1.6" />
        </svg>
      </div>
    </div>
  )
}
