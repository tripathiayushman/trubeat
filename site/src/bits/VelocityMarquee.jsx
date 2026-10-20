import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

// Infinite marquee that leans into scroll velocity: fling the page and the
// band skews and speeds up, then settles. Pure GSAP-abuse garnish.
export default function VelocityMarquee({ children }) {
  const bandRef = useRef(null)
  const trackRef = useRef(null)
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const tween = gsap.to(track, { xPercent: -50, repeat: -1, duration: 22, ease: 'none' })
    const skewSet = gsap.quickTo(bandRef.current, 'skewX', { duration: 0.35, ease: 'power3' })
    let current = 0
    const st = ScrollTrigger.create({
      onUpdate: (self) => {
        const v = gsap.utils.clamp(-14, 14, self.getVelocity() / -260)
        if (Math.abs(v) > Math.abs(current)) {
          current = v
          skewSet(v * 0.55)
          tween.timeScale(gsap.utils.clamp(1, 5.5, 1 + Math.abs(v) * 0.32))
          gsap.delayedCall(0.25, () => { current = 0; skewSet(0); gsap.to(tween, { timeScale: 1, duration: 0.7, ease: 'power2.out', overwrite: true }) })
        }
      }
    })
    return () => { st.kill(); tween.kill() }
  }, [])
  return (
    <div className="vmarquee" ref={bandRef}>
      <div className="vmarquee-track" ref={trackRef}>{children}{children}</div>
    </div>
  )
}
