import { useRef } from 'react'

// React Bits-style Magnet: the element leans toward the cursor while hovered.
export default function Magnetic({ children, strength = 0.35, className = '' }) {
  const ref = useRef(null)
  const onMove = (e) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = e.clientX - (r.left + r.width / 2)
    const y = e.clientY - (r.top + r.height / 2)
    el.style.transform = `translate(${x * strength}px, ${y * strength}px)`
  }
  const onLeave = () => { if (ref.current) ref.current.style.transform = 'translate(0,0)' }
  return (
    <span ref={ref} className={className} onMouseMove={onMove} onMouseLeave={onLeave}
      style={{ display: 'inline-block', transition: 'transform .35s cubic-bezier(.2,.8,.3,1.2)', willChange: 'transform' }}>
      {children}
    </span>
  )
}
