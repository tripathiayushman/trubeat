import { useState } from 'react'

export const REPO = 'https://github.com/tripathiayushman/trubeat'

export function PulseMark({ size = 16 }) {
  return (
    <svg width={size + 6} height={size} viewBox="0 0 32 24" fill="none" aria-hidden="true">
      <path d="M1 12h7l3-8 4 16 3-8h13" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function GhIcon({ size = 19 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 1.28 1.06.75.57 1.08 2.2 0 1.07-.01 1.93-.01 2.19 0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}

const LINKS = [
  { id: 'home', label: 'Home' },
  { id: 'demo', label: 'Live Demo' },
  { id: 'docs', label: 'Docs' },
  { id: 'research', label: 'Research' },
  { id: 'github', label: 'GitHub' }
]

export default function Nav({ page, go }) {
  const [open, setOpen] = useState(false)
  const jump = (id) => { setOpen(false); go(id) }
  return (
    <header className="nav">
      <div className="wrap nav-in">
        <a className="logo" href="#/home" onClick={(e) => { e.preventDefault(); jump('home') }}>
          <span className="pulse-mark"><PulseMark /></span>TrueBeat
        </a>
        <nav className={`nav-links ${open ? 'open' : ''}`}>
          {LINKS.map((l) => (
            <a key={l.id} href={`#/${l.id}`} className={page === l.id ? 'on' : ''}
              onClick={(e) => { e.preventDefault(); jump(l.id) }}>{l.label}</a>
          ))}
        </nav>
        <div className="nav-right">
          <a className="gh-link" href={REPO} target="_blank" rel="noreferrer"><GhIcon /> tripathiayushman/trubeat</a>
          <button className="btn btn-grn btn-sm" onClick={() => jump('demo')}>Check a video</button>
          <button className="burger" aria-label="Menu" onClick={() => setOpen(!open)}>☰</button>
        </div>
      </div>
    </header>
  )
}
