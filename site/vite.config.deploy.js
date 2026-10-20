import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deploy variant: React/GSAP are externalized and loaded from esm.sh via an
// importmap (injected into the built index.html), keeping the uploaded
// bundle small. Local dev/build (vite.config.js) bundles everything.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-deploy',
    assetsDir: 'assets',
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'gsap', 'gsap/ScrollTrigger', 'lenis'],
      output: { format: 'es' }
    }
  }
})
