import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

// React Bits-style CountUp: GSAP-powered number tween on scroll into view.
export default function CountUp({ end, decimals = 0, prefix = '', suffix = '', duration = 1.6 }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obj = { v: 0 }
    const tween = gsap.to(obj, {
      v: end, duration, ease: 'power2.out',
      scrollTrigger: { trigger: el, start: 'top 92%', once: true },
      onUpdate: () => { el.textContent = prefix + obj.v.toFixed(decimals) + suffix }
    })
    return () => { tween.scrollTrigger && tween.scrollTrigger.kill(); tween.kill() }
  }, [end, decimals, prefix, suffix, duration])
  return <span ref={ref}>{prefix + (0).toFixed(decimals) + suffix}</span>
}
