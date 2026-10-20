import { useEffect, useRef } from 'react'
import gsap from 'gsap'

// React Bits-style SplitText: per-character masked rise, GSAP stagger.
export default function SplitText({ text, delay = 0, stagger = 0.022, className = '' }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chars = el.querySelectorAll('.st-char')
    const tween = gsap.fromTo(
      chars,
      { yPercent: 115, rotate: 4 },
      { yPercent: 0, rotate: 0, duration: 0.9, ease: 'power4.out', stagger, delay, overwrite: true }
    )
    return () => tween.kill()
  }, [text, delay, stagger])

  const words = text.split(' ')
  return (
    <span ref={ref} className={className} aria-label={text} style={{ display: 'inline-block' }}>
      {words.map((w, wi) => (
        <span key={wi} style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>
          {w.split('').map((c, ci) => (
            <span key={ci} style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top' }}>
              <span className="st-char" style={{ display: 'inline-block', willChange: 'transform' }}>{c}</span>
            </span>
          ))}
          {wi < words.length - 1 ? '\u00A0' : ''}
        </span>
      ))}
    </span>
  )
}
