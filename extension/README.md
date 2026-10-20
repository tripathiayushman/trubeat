# TrueBeat browser extension (Phase 4b)

A Chrome extension that checks the video playing in the current tab for a
face-swap-style deepfake, using **your own TrueBeat backend**.

The extension captures and uploads. It never decides anything itself: the
verdict, the thresholds and the evidence numbers all come from the backend
(`trubeat serve`), so there is exactly one implementation of the physics
and one set of thresholds.

---

## What it does

1. You click **"Check this tab"**.
2. The extension records ~20 s of the tab's video (WebM, max width 1280) in
   an offscreen document.
3. It uploads that clip to your backend and reads back the verdict.
4. A small panel appears in the bottom-right of the page with the verdict,
   the evidence numbers and the standing caveat.

**Verdicts are exactly three states** (same wording as the web app and the
website):

| Verdict | Meaning | Colour |
|---------|---------|--------|
| `Pulse consistent — likely real` | the face regions agree on one pulse and the detector scores the clip on the real side | green |
| `Pulse inconsistent — pixel-replacement pattern` | the regions disagree and the detector scores the clip on the fake side — the Deepfakes-family signature | red |
| `Inconclusive` | the QC gates refused the clip: under 10 s, no face, the face visible in under 70% of frames, or no measurable pulse | amber |

The caveat is always on screen:

> Detects face-swaps. Reenactment fakes — Face2Face, NeuralTextures — keep
> the original pulse and are out of scope.

## Install (load unpacked)

1. Start the backend on this machine:

   ```bash
   cd <trubeat-repo>
   uv pip install -e ".[serving]"
   trubeat serve          # http://127.0.0.1:7860
   ```

2. Load the extension:
   - open `chrome://extensions`
   - turn on **Developer mode** (top right)
   - click **Load unpacked**
   - pick the `extension/` folder of this repository

3. Click the TrueBeat icon in the toolbar. The dot next to the title turns
   green when the backend is reachable. Use **Options** to change the
   backend URL or the capture length.

> Chrome will ask for permission to capture the tab when you press the
> button — that is the `tabCapture` permission doing its job.

## Options

| Setting | Default | Notes |
|---------|---------|-------|
| Backend URL | `http://127.0.0.1:7860` | any TrueBeat backend that exposes the `analyze_video` endpoint |
| Capture length | 20 s | 12–60 s. Longer captures find the pulse better; analysis takes roughly 20 s per minute of video on a CPU |

For a **hosted** backend (e.g. an `https://*.hf.space` URL) the extension asks
Chrome for permission to reach that origin when you save. Local addresses
need no extra permission.

## Privacy

- **No telemetry, no analytics, no other network traffic.** The only host
  the extension ever talks to is the backend URL you set.
- **Captures are not stored.** The recording exists in memory for the few
  seconds it takes to upload it, then it is dropped.
- A local backend keeps everything on your machine.
- Only your settings are persisted (`chrome.storage.local`).

## How it works

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. Default `host_permissions` are localhost only; other origins are *optional* (requested at save time). |
| `background.js` | Service worker: owns the capture lifecycle and the backend call. The only file that talks to the network. |
| `offscreen.html` / `offscreen.js` | The recorder. `getUserMedia` + `MediaRecorder` are unavailable in a service worker, so the recording happens here. It also runs the **black-frame guard**. |
| `overlay.js` | Injected content script: the bottom-right panel, rendered in a shadow DOM so the page cannot restyle it. |
| `popup.html` / `popup.js` | "Check this tab" button + backend status dot. |
| `options.html` / `options.js` | Backend URL, capture length, "Test connection". |
| `icons/` | 16/32/48/128 PNGs (regenerate with `python scripts/make_icons.py`). |

**Why tab capture, not `<video>` scraping:** it works on any site — YouTube,
news, social — without depending on the page's markup, and it captures what
is actually playing. The extension also refuses to fake a result: if the
captured frames are uniformly black (a DRM-protected stream, or a player
that hands the capturer black frames), it stops and says so instead of
uploading a meaningless clip.

### The backend contract

The extension speaks the Gradio API:

```
GET  {backend}/gradio_api/info                    -> discover "analyze_video"
POST {backend}/gradio_api/upload  (multipart)     -> ["<path>"]
POST {backend}/gradio_api/call/analyze_video      -> {"event_id": "..."}
GET  {backend}/gradio_api/call/analyze_video/<id> -> SSE, "complete" carries the JSON
```

The JSON carries `verdict`, `headline`, `detail`, `score`, `hr_bpm`,
`region_agreement_bpm`, `snr`, `face_valid_frac`, `qc` and `caveat`. It is
produced by `src/trubeat/app.py` from the *same* `analyze_video()` the web
app uses — no thresholds are duplicated or recalibrated on the client.

## Manual QA checklist

Run through this after loading the extension.

**A. Happy path**
- [ ] `trubeat serve` is running; the popup dot is green.
- [ ] Open a page with a real face (a talking-head video).
- [ ] Press **Check this tab**. The overlay shows "Capturing… Ns" counting up.
- [ ] The overlay then shows one of the three verdicts with HR, region
      agreement, SNR and the caveat.
- [ ] The same clip uploaded to the web app gives the **same verdict and the
      same numbers** (the extension and the app are the same pipeline).
      To check this without a browser, run the extension's own client
      against the backend and diff it against the app's analysis:

      ```bash
      node tests/js/extension_print_result.mjs http://127.0.0.1:7860 clip.mp4
      python -c "from trubeat.app import analyze_video; print(analyze_video('clip.mp4').to_json())"
      ```

**B. Error states (all must be honest, none may invent a verdict)**
- [ ] **Backend stopped** → the overlay says the backend is unreachable
      ("Start it with: `trubeat serve` — or set the backend URL in Options").
- [ ] **Capture denied** (click Cancel on Chrome's capture bar) → an honest
      "can't capture" message, no verdict.
- [ ] **Too-short capture** (tab switched away / stream ended) → an honest
      message, no verdict.
- [ ] **DRM stream** (a Netflix/DRM-protected player) → "Can't capture this
      video — protected stream (DRM) or black frames", and **nothing is
      uploaded**.
- [ ] **Backend error** (kill the backend mid-analysis) → the backend's own
      message is shown.

**C. Privacy**
- [ ] DevTools → Network: while checking a tab, the **only** requests are to
      the configured backend. No third-party hosts, no analytics.
- [ ] `chrome://extensions` → service worker → Console: no errors.
- [ ] Reload the extension: no captured video appears anywhere on disk
      (`chrome.storage.local` holds only the two settings).

**D. Settings**
- [ ] Options → change the backend URL to a wrong one → "Test connection"
      reports it is unreachable; the popup dot turns red.
- [ ] Set a hosted backend URL → Chrome asks for permission for that origin;
      declining keeps the extension working but unable to reach it.

## Automated tests

```bash
node tests/js/extension_test.mjs --backend http://127.0.0.1:7860
```

This loads the shipped extension files and drives the real code paths: the
Gradio API client against a live backend (skipped when none is running),
the verdict→colour mapping, the black-frame heuristic, and a static audit
for remote code, inline scripts, telemetry hosts and stray network
destinations. It also runs under `pytest` (`tests/test_extension.py`).
