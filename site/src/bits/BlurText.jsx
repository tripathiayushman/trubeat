import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

// React Bits-style BlurText: words de-blur + rise, staggered, on scroll into view.
export default function BlurText({ text, className = '', delay = 0, as: Tag = 'span' }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const words = el.querySelectorAll('.bt-word')
    gsap.set(words, { opacity: 0, y: 14, filter: 'blur(10px)' })
    const tween = gsap.to(words, {
      opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.8, ease: 'power3.out',
      stagger: 0.055, delay,
      scrollTrigger: { trigger: el, start: 'top 88%', once: true }
    })
    return () => { tween.scrollTrigger && tween.scrollTrigger.kill(); tween.kill() }
  }, [text, delay])
  return (
    <Tag ref={ref} className={className}>
      {text.split(' ').map((w, i) => (
        <span key={i} className="bt-word" style={{ display: 'inline-block', willChange: 'transform,filter' }}>
          {w}{i < text.split(' ').length - 1 ? '\u00A0' : ''}
        </span>
      ))}
    </Tag>
  )
}
