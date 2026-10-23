/**
 * TrueBeat extension — offscreen recorder.
 *
 * Runs in the offscreen document because getUserMedia/MediaRecorder are
 * unavailable in an MV3 service worker. It:
 *   - opens the tab-capture stream (chromeMediaSource: 'tab'),
 *   - records it to WebM (max width 1280),
 *   - samples frames to a canvas to detect a uniformly black capture
 *     (protected/DRM streams and some players produce black frames),
 *   - reports live progress to the service worker,
 *   - uploads the finished clip itself, because a Blob cannot cross a
 *     runtime message (it would arrive in the worker as {}),
 *   - runs the whole backend conversation afterwards too: endpoint
 *     discovery, the analysis call, and the SSE wait with
 *     reconnect-resume (a service worker would be idle-killed mid-stream),
 *     reporting ANALYSIS_RESULT with the verdict or an honest CAPTURE_ERROR.
 *
 * It never stores the recording: the bytes live only until the upload POST
 * finishes and the analysis reads the server-side copy.
 */

const MAX_WIDTH = 1280;
const SAMPLE_INTERVAL_MS = 700;
// A frame counts as "black" when it is both very dark and very flat.
const BLACK_LUMA_MAX = 12;
const BLACK_STD_MAX = 6;
// Consecutive black samples before we give up on the capture.
const BLACK_STRIKES = 3;

// The analysis wait lives here, not in the service worker: a stream that
// sits idle while the model computes looks like idleness to the ~30 s
// worker idle leash, and a mid-analysis drop must never surface Chrome's
// raw "network error". Gradio replays the event stream for a completed
// event, so a dropped wait can simply re-GET the same event URL.
const SSE_RETRIES = 12;
const SSE_RETRY_DELAY_MS = 1500;
const ANALYZE_DEADLINE_MS = 6 * 60 * 1000;

// Exposed for the automated tests (tests/js/extension_test.mjs).
globalThis.__trueBeatIsBlackFrame = (mean, std) =>
  mean < BLACK_LUMA_MAX && std < BLACK_STD_MAX;

let recorder = null;
let stream = null;
let backend = null;
let canvas = null;
let ctx = null;
let sampleTimer = null;
let progressTimer = null;
let blackStrikes = 0;
let samples = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "OFFSCREEN_START") {
    startCapture(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        chrome.runtime.sendMessage({
          type: "CAPTURE_ERROR",
          tabId: msg.tabId,
          title: "Can't capture this tab",
          message: String((err && err.message) || err),
        });
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }
  if (msg.type === "ANALYZE") {
    // Settle at once: the result (or an honest error) is posted as a
    // runtime message when the long analysis wait really ends.
    analyzeClip(msg).catch((err) => {
      post({
        type: "CAPTURE_ERROR",
        tabId: msg.tabId,
        title: "Backend error",
        message:
          "The analysis failed inside the extension (" +
          String((err && err.message) || err) +
          ").",
      });
    });
    sendResponse({ ok: true });
    return true;
  }
});

function post(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function startCapture({ streamId, tabId, seconds, backend: backendUrl }) {
  backend = backendUrl || null;
  return new Promise((resolve, reject) => {
    // The offscreen page opens capture through the standard Web API.
    // (There is no chrome-side wrapper for it in MV3.) Fail with a
    // readable message when the API is missing instead of a raw TypeError.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Tab capture is unavailable in this browser context.");
    }
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    })
      .then((mediaStream) => {
        stream = mediaStream;
        const track = mediaStream.getVideoTracks()[0];
        if (!track) throw new Error("The tab produced no video track.");
        track.addEventListener("ended", () => {
          fail("The tab's video track ended before the capture finished.");
        });

        const settings = pickMimeType();
        const chunks = [];
        recorder = new MediaRecorder(mediaStream, settings);
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onerror = (e) => {
          fail("Recorder error: " + String((e && e.error) || "unknown"));
        };
        recorder.onstop = () => {
          cleanup();
          if (blackStrikes >= BLACK_STRIKES) {
            post({
              type: "CAPTURE_ERROR",
              tabId,
              title: "Can't capture this video",
              message:
                "Can't capture this video: protected stream (DRM) or black frames.",
            });
            return;
          }
          const blob = new Blob(chunks, { type: settings.mimeType });
          if (!blob.size) {
            post({
              type: "CAPTURE_ERROR",
              tabId,
              title: "Nothing was captured",
              message: "The recorder produced no data.",
            });
            return;
          }
          // The Blob cannot cross a runtime message (it serialises to {}),
          // so this document uploads the recording and reports the path.
          uploadCapture({
            tabId,
            blob,
            filename: "truebeat-capture.webm",
          });
        };

        // Live progress + black-frame sampling.
        const started = Date.now();
        progressTimer = setInterval(() => {
          const elapsed = Math.min(seconds, (Date.now() - started) / 1000);
          post({
            type: "PROGRESS",
            tabId,
            payload: { elapsed, total: seconds },
          });
        }, 500);

        sampleTimer = setInterval(sampleFrame, SAMPLE_INTERVAL_MS);

        recorder.start(1000);
        setTimeout(() => {
          if (recorder && recorder.state === "recording") recorder.stop();
        }, seconds * 1000);

        // The start request must settle: background.js awaits the
        // OFFSCREEN_START answer, so a capture that actually begins
        // responds ok. (Failures settle through reject + CAPTURE_ERROR.)
        resolve({ started: true });
      })
      .catch((err) => {
        cleanup();
        reject(
          new Error(
            "The browser refused the tab stream (" +
              String((err && err.message) || err) +
              ")."
          )
        );
      });
  });
}

/**
 * Upload the finished recording and report the server-side path.
 * This runs here because the Blob lives here: a runtime message is
 * JSON-serialised, so a Blob would arrive in the service worker as {}.
 */
async function uploadCapture({ tabId, blob, filename }) {
  if (!backend) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message: "No backend URL was given to the recorder.",
    });
    return;
  }
  const form = new FormData();
  form.append("files", blob, filename);
  let res;
  try {
    res = await fetch(backend + "/gradio_api/upload", {
      method: "POST",
      body: form,
    });
  } catch (err) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message:
        "The backend was unreachable while storing the recording (" +
        String((err && err.message) || err) +
        ").",
    });
    return;
  }
  if (!res.ok) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message: `The backend refused the recording (HTTP ${res.status}). Is \`trubeat serve\` running?`,
    });
    return;
  }
  let uploaded = null;
  try {
    uploaded = await res.json();
  } catch (_) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message: "The backend answered the upload with unreadable JSON.",
    });
    return;
  }
  const serverPath = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  if (typeof serverPath !== "string" || !serverPath) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message: "The backend accepted the upload but returned no file path.",
    });
    return;
  }
  post({ type: "CAPTURE_UPLOADED", tabId, serverPath, filename });
}

/**
 * Analyse the uploaded copy of the clip and wait for the verdict.
 * This runs here because the wait itself lives here: a service worker is
 * idle-killed after ~30 s, and an in-flight analysis stream looks exactly
 * like idleness — the model is computing, so no bytes arrive. The stream
 * reader also never surfaces Chrome's raw "network error": a dropped or
 * ended stream is retried by re-GET of the same event URL (Gradio replays
 * the output of a completed event), and only a readable summary ever
 * reaches the overlay.
 */
async function analyzeClip({ tabId, serverPath, backend: backendUrl }) {
  const base = backendUrl || backend;
  if (!base || typeof serverPath !== "string" || !serverPath) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message: "The analysis request was incomplete.",
    });
    return;
  }

  // 1. discover the endpoint (the user may point at any TrueBeat backend)
  let infoRes;
  try {
    infoRes = await fetch(base + "/gradio_api/info", { cache: "no-store" });
  } catch (_) {
    postAnalyzeUnreachable(tabId, base);
    return;
  }
  if (!infoRes.ok) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message:
        `The backend at ${base} answered HTTP ${infoRes.status}. ` +
        "Is \`trubeat serve\` running?",
    });
    return;
  }
  let info = null;
  try {
    info = await infoRes.json();
  } catch (_) {
    info = null;
  }
  const endpoints = Object.keys((info && info.named_endpoints) || {});
  const apiName = endpoints.includes("/analyze_video")
    ? "/analyze_video"
    : endpoints.find((e) => e.endsWith("analyze_video"));
  if (!apiName) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message:
        "This backend does not expose the analyze_video endpoint " +
        `(found: ${endpoints.join(", ") || "none"}).`,
    });
    return;
  }

  // 2. start the analysis on the server-side copy
  let callRes;
  try {
    callRes = await fetch(base + "/gradio_api/call" + apiName, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [{ path: serverPath, meta: { _type: "gradio.FileData" } }],
      }),
    });
  } catch (_) {
    postAnalyzeUnreachable(tabId, base);
    return;
  }
  if (!callRes.ok) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message: `The backend rejected the request (HTTP ${callRes.status}).`,
    });
    return;
  }
  let eventId = null;
  try {
    eventId = (await callRes.json()).event_id;
  } catch (_) {
    eventId = null;
  }
  if (!eventId) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message: "The backend returned no event id.",
    });
    return;
  }

  // 3. wait for the result, reconnecting when the stream drops
  const deadline = Date.now() + ANALYZE_DEADLINE_MS;
  let attempts = 0;
  let immediate = null;
  while (attempts < SSE_RETRIES && Date.now() < deadline) {
    attempts += 1;
    const attempt = await readEventStream(base, apiName, eventId);
    if (attempt.outcome === "result") {
      post({ type: "ANALYSIS_RESULT", tabId, result: attempt.verdict });
      return;
    }
    if (attempt.outcome === "error") {
      immediate = attempt.message;
      break;
    }
    // outcome "drop": the stream errored or ended without a result —
    // worth re-GETting the event (Gradio replays a completed event).
    if (attempts < SSE_RETRIES && Date.now() + SSE_RETRY_DELAY_MS <= deadline) {
      await delay(SSE_RETRY_DELAY_MS);
    }
  }
  if (immediate !== null) {
    post({
      type: "CAPTURE_ERROR",
      tabId,
      title: "Backend error",
      message: immediate,
    });
    return;
  }
  post({
    type: "CAPTURE_ERROR",
    tabId,
    title: "Backend error",
    message:
      "The connection to your backend dropped while analysing (retried " +
      attempts +
      " times). Is `trubeat serve` still running?",
  });
}

/**
 * One read of the SSE stream the backend opened for this analysis.
 *   { outcome: "result", verdict }  the verdict arrived;
 *   { outcome: "drop" }             the stream errored or ended without
 *                                   one (retryable: re-GET the same URL);
 *   { outcome: "error", message }   the backend reported an explicit error
 *                                   on the stream itself (not retryable).
 */
async function readEventStream(base, apiName, eventId) {
  let res;
  try {
    res = await fetch(base + "/gradio_api/call" + apiName + "/" + eventId);
  } catch (_) {
    return { outcome: "drop" };
  }
  if (!res.ok || !res.body || !res.body.getReader) {
    return { outcome: "drop" };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (_) {
      return { outcome: "drop" };
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch (_) {
        continue;
      }
      if (Array.isArray(parsed)) {
        // Gradio wraps the return value: ["<json string>"] -> parse the inner one
        const inner = parsed[0];
        if (typeof inner === "string") {
          try {
            return { outcome: "result", verdict: JSON.parse(inner) };
          } catch (_) {
            return {
              outcome: "result",
              verdict: {
                verdict: "inconclusive",
                headline: "Unreadable backend reply",
              },
            };
          }
        }
        return { outcome: "result", verdict: inner };
      }
      if (parsed && parsed.error) {
        return {
          outcome: "error",
          message: "Backend error: " + JSON.stringify(parsed.error),
        };
      }
    }
  }
  return { outcome: "drop" };
}

/** Wait out the reconnect delay; the budget is bounded by SSE_RETRIES. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Honest "cannot reach the backend" message for the analysis chain. */
function postAnalyzeUnreachable(tabId, base) {
  post({
    type: "CAPTURE_ERROR",
    tabId,
    title: "Backend error",
    message: `The backend at ${base} was unreachable. Is \`trubeat serve\` running?`,
  });
}

function fail(message) {
  cleanup();
  post({
    type: "CAPTURE_ERROR",
    tabId: currentTabId,
    title: "Can't capture this tab",
    message,
  });
}

let currentTabId = null;

function cleanup() {
  if (sampleTimer) clearInterval(sampleTimer);
  if (progressTimer) clearInterval(progressTimer);
  sampleTimer = null;
  progressTimer = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  recorder = null;
}

/** Prefer a WebM container with VP8/VP9 so MediaRecorder works everywhere. */
function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
      return { mimeType: type };
    }
  }
  return {};
}

/**
 * Sample the current frame and look for a uniformly black image.
 * DRM-protected streams and a few players hand the capturer black frames;
 * uploading those would produce a meaningless "no face" answer, so we stop
 * and say so honestly instead.
 */
function sampleFrame() {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  if (!canvas) {
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  const settings = track.getSettings ? track.getSettings() : {};
  const w = Math.min(MAX_WIDTH, settings.width || 640);
  const h = Math.round(w * ((settings.height || 360) / (settings.width || 640)));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  try {
    ctx.drawImage(track, 0, 0, w, h);
  } catch (_) {
    return;
  }
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (_) {
    return; // tainted canvas (should not happen for a tab capture)
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luma
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += y;
    sumSq += y * y;
    n += 1;
  }
  if (!n) return;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  samples += 1;
  if (mean < BLACK_LUMA_MAX && std < BLACK_STD_MAX) {
    blackStrikes += 1;
  } else {
    blackStrikes = 0;
  }  if (blackStrikes >= BLACK_STRIKES && recorder && recorder.state === "recording") {
    recorder.stop();
  }
}
