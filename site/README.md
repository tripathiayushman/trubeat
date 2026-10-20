# TrueBeat website

The project site (trubeat.vercel.app) — React 18 + Vite, GSAP + Lenis motion
system, no backend. Pages: Home, Live Demo, Docs, Research, GitHub.

## Develop

```bash
npm install
npm run dev        # local dev server
npm run build      # production bundle (all deps inlined) → dist/
npm run preview
```

## Deploy

Production is a static deploy of the built site to Vercel (project
`trubeat`). `vite.config.deploy.js` is a variant that externalizes
react / gsap / lenis to CDN (esm.sh importmap in the built index.html)
for lightweight file-based deployments; a git-linked Vercel deploy can
use the standard `npm run build` output instead.

## Live demo backend

The Demo page embeds the hosted Gradio app when `DEMO_EMBED_URL` in
`src/pages/Demo.jsx` is set to the Hugging Face Space URL
(see Docs → "Deploy the hosted demo"). Empty = honest local-checks mode.
