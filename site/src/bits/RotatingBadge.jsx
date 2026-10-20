import { useEffect, useRef } from 'react'

// Circular rotating text badge (SVG textPath), spins forever.
export default function RotatingBadge({ text = 'PULSE-CONSISTENCY • DEEPFAKE DETECTION • OPEN RESEARCH • ', size = 132 }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 16000, iterations: Infinity, easing: 'linear' })
  }, [])
  return (
    <div className="rot-badge" style={{ width: size, height: size }}>
      <svg ref={ref} viewBox="0 0 120 120" width={size} height={size}>
        <defs><path id="circPath" d="M60,60 m-46,0 a46,46 0 1,1 92,0 a46,46 0 1,1 -92,0" /></defs>
        <text className="rot-text"><textPath href="#circPath">{text}</textPath></text>
      </svg>
      <svg className="rot-core" width="34" height="34" viewBox="0 0 32 24" fill="none">
        <path d="M1 12h7l3-8 4 16 3-8h13" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}
