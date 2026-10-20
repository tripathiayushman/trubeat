import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

// Manifesto-style word reveal: words start dim and light up one by one,
// scrubbed to scroll position (the Awwwards manifesto pattern).
export default function WordReveal({ text, className = '' }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const words = el.querySelectorAll('.wr-word')
    const tween = gsap.fromTo(words, { opacity: 0.13 }, {
      opacity: 1, stagger: 0.06, ease: 'none',
      scrollTrigger: { trigger: el, start: 'top 78%', end: 'bottom 45%', scrub: 0.6 }
    })
    return () => { tween.scrollTrigger && tween.scrollTrigger.kill(); tween.kill() }
  }, [text])
  return (
    <p ref={ref} className={className}>
      {text.split(' ').map((w, i, arr) => {
        const hl = w.startsWith('_')
        const clean = hl ? w.replace(/_/g, '') : w
        return <span key={i} className={`wr-word${hl ? ' wr-hl' : ''}`}>{clean}{i < arr.length - 1 ? ' ' : ''}</span>
      })}
    </p>
  )
}
