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
 *   - hands the finished blob back (or an honest error).
 *
 * It never uploads anything itself and never stores the recording.
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

function startCapture({ streamId, tabId, seconds }) {
  return new Promise((resolve, reject) => {
    chrome.mediaStream.getUserMedia({
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
          post({
            type: "CAPTURE_DONE",
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
