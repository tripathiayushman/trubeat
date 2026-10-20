import { useMemo } from 'react'

// Animated ECG trace: a faint full waveform + a bright pulse segment that
// travels along it (SVG dash animation), with a soft glow.
export default function EcgLine({ height = 64 }) {
  const d = useMemo(() => {
    const beat = (x) =>
      `H${x + 52} l7 -9 7 9 h12 l9 -25 11 38 7 -13 H${x + 176}`
    let path = 'M0 34 '
    for (let x = 0; x < 760; x += 190) path += beat(x) + ' '
    return path + 'H760'
  }, [])
  return (
    <svg viewBox="0 0 760 68" width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <filter id="ecg-glow" x="-20%" y="-80%" width="140%" height="260%">
          <feGaussianBlur stdDeviation="3.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <path d={d} fill="none" stroke="rgba(46,230,168,.20)" strokeWidth="2" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2.4"
        strokeDasharray="130 2400" className="ecg-pulse" />
      <style>{`.ecg-pulse{animation:ecgmove 4.6s linear infinite}@keyframes ecgmove{from{stroke-dashoffset:2530}to{stroke-dashoffset:0}}`}</style>
    </svg>
  )
}
