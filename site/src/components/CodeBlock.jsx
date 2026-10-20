import { useState } from 'react'

// Terminal-style code block with copy button.
// lines: [{ k: 'cmd' | 'cmt' | 'out' | 'raw', s: string }]
export default function CodeBlock({ title = 'terminal', lines = [], plain = null }) {
  const [copied, setCopied] = useState(false)
  const text = plain ?? lines.filter((l) => l.k !== 'out').map((l) => l.s.replace(/^\$\s*/, '')).join('\n')
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch {}
  }
  return (
    <div className="term">
      <div className="term-bar">
        <i style={{ background: '#ff5f57' }} /><i style={{ background: '#febc2e' }} /><i style={{ background: '#28c840' }} />
        <span className="t">{title}</span>
        <button className="copy-btn" style={{ position: 'static', marginLeft: 'auto' }} onClick={copy}>{copied ? 'copied ✓' : 'copy'}</button>
      </div>
      <div className="term-body">
        {plain != null
          ? plain.split('\n').map((s, i) => <div key={i}>{s || '\u00A0'}</div>)
          : lines.map((l, i) => (
              <div key={i} className={l.k === 'cmt' ? 'c' : l.k === 'out' ? 'o' : ''}>
                {l.k === 'cmd' ? <><span className="p">$ </span>{l.s}</> : l.s}
              </div>
            ))}
      </div>
    </div>
  )
}
