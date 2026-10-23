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
 *     runtime message (it would arrive in the worker as {}), and hands
 *     background.js the server-side path or an honest error.
 *
 * It never stores the recording: the bytes live only long enough for the
 * upload POST.
 */

const MAX_WIDTH = 1280;
const SAMPLE_INTERVAL_MS = 700;
// A frame counts as "black" when it is both very dark and very flat.
const BLACK_LUMA_MAX = 12;
const BLACK_STD_MAX = 6;
// Consecutive black samples before we give up on the capture.
const BLACK_STRIKES = 3;

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
  if (!msg || msg.type !== "OFFSCREEN_START") return;
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
