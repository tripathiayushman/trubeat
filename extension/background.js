/**
 * TrueBeat extension — service worker.
 *
 * Responsibilities (and nothing else):
 *   1. own the capture lifecycle: popup -> tabCapture stream id -> offscreen
 *      recorder -> uploaded server path -> analysis result;
 *   2. relay the analysis to the offscreen document: both the upload POST
 *      and the long network waits live there, because a Blob cannot survive
 *      a chrome.runtime message (it serialises to {}) and a service worker
 *      is idle-killed after ~30 s, which is exactly what an in-flight
 *      analysis stream looks like while the model computes;
 *   3. push state into the in-page overlay (shadow DOM panel).
 *
 * No detection logic lives here. The extension never computes a verdict:
 * it analyses the server-side copy and renders whatever the backend
 * answers. Thresholds are never recalibrated client-side.
 *
 * Privacy: the only network destination is the backend URL the user set in
 * Options. Captures are never persisted; the offscreen document uploads
 * them straight to the backend and drops them.
 */

const DEFAULTS = {
  backend: "http://127.0.0.1:7860",
  captureSeconds: 20,
};

const OFFSCREEN_PATH = "offscreen.html";

/** In-memory state of the one capture in flight (never persisted). */
let current = {
  tabId: null,
  startedAt: 0,
  active: false,
};

// ---------------------------------------------------------------- helpers

function normaliseBackend(url) {
  let u = (url || "").trim();
  if (!u) return DEFAULTS.backend;
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u.replace(/\/+$/, "");
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    backend: normaliseBackend(stored.backend),
    captureSeconds: Math.min(
      60,
      Math.max(12, Number(stored.captureSeconds) || DEFAULTS.captureSeconds)
    ),
  };
}

function log(...args) {
  console.log("[TrueBeat]", ...args);
}

// -------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "CHECK_TAB":
        await checkTab(msg.tabId);
        sendResponse({ ok: true });
        return;
      case "GET_STATUS":
        sendResponse(await status());
        return;
      case "PROGRESS":
        await pushOverlay(msg.tabId, { state: "capturing", ...msg.payload });
        sendResponse({ ok: true });
        return;
      case "CAPTURE_UPLOADED":
        await handleCaptureUploaded(msg);
        sendResponse({ ok: true });
        return;
      case "ANALYSIS_RESULT":
        if (msg.result && typeof msg.result === "object") {
          await pushOverlay(msg.tabId, { state: "result", result: msg.result });
        } else {
          await pushOverlay(msg.tabId, {
            state: "error",
            title: "Backend error",
            message: "The backend stream returned an unreadable result.",
          });
        }
        sendResponse({ ok: true });
        return;
      case "CAPTURE_ERROR":
        await pushOverlay(msg.tabId, {
          state: "error",
          title: msg.title || "Capture failed",
          message: msg.message || "Unknown capture error",
        });
        sendResponse({ ok: true });
        return;
      case "PING_BACKEND":
        sendResponse(await pingBackend(msg.backend));
        return;
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // keep the channel open for the async response
});

async function status() {
  const s = await getSettings();
  const ping = await pingBackend(s.backend);
  return { backend: s.backend, captureSeconds: s.captureSeconds, ...ping };
}

/** Ping the backend's API-info endpoint (used by the popup status dot). */
async function pingBackend(base) {
  const url = normaliseBackend(base) + "/gradio_api/info";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const info = await res.json();
    const names = Object.keys((info && info.named_endpoints) || {});
    return {
      reachable: true,
      hasAnalyze: names.includes("/analyze_video"),
      endpoints: names,
    };
  } catch (err) {
    return { reachable: false, error: String((err && err.message) || err) };
  }
}

// --------------------------------------------------------------- capture

async function checkTab(tabId) {
  if (current.active) {
    await pushOverlay(tabId, {
      state: "error",
      title: "Already running",
      message: "A check is already in progress. Wait for it to finish.",
    });
    return;
  }
  const settings = await getSettings();
  current = { tabId, startedAt: Date.now(), active: true };

  // The overlay goes in first so it can show live capture progress.
  await pushOverlay(tabId, {
    state: "capturing",
    elapsed: 0,
    total: settings.captureSeconds,
    message: "Starting capture…",
  });

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    current.active = false;
    await pushOverlay(tabId, {
      state: "error",
      title: "Can't capture this tab",
      message:
        "The browser refused tab capture (" +
        String((err && err.message) || err) +
        "). Reload the page and try again.",
    });
    return;
  }

  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START",
      streamId,
      tabId,
      seconds: settings.captureSeconds,
      backend: settings.backend,
    });
  } catch (err) {
    current.active = false;
    await pushOverlay(tabId, {
      state: "error",
      title: "Can't capture this tab",
      message: "Could not start the recorder: " + String((err && err.message) || err),
    });
  }
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification:
        "Record the current tab's video so it can be analysed for face-swap deepfakes.",
    });
  } catch (err) {
    // "Only a single offscreen document may be created" — already there.
    if (!String(err).includes("single offscreen document")) throw err;
  }
}

/**
 * The offscreen document uploaded the recording itself (a Blob cannot
 * cross a runtime message, so the message carries the server-side path,
 * never the clip). Validate that path, then run the analysis flow on it.
 */
async function handleCaptureUploaded(msg) {
  const tabId = msg.tabId;
  current.active = false;

  if (typeof msg.serverPath !== "string" || !msg.serverPath) {
    await pushOverlay(tabId, {
      state: "error",
      title: "Backend error",
      message: "The backend accepted the recording but returned no usable path.",
    });
    return;
  }

  const settings = await getSettings();
  await pushOverlay(tabId, {
    state: "analyzing",
    message: "Analysing on your backend…",
  });

  // The analysis wait must not live in the service worker: a stream that
  // sits idle while the model computes looks like idleness to the ~30 s
  // worker idle leash, and a mid-analysis drop surfaced Chrome's raw
  // "network error". Hand the server-side copy to the offscreen document,
  // which owns the connection and reconnect-resume; the verdict comes
  // back as an ANALYSIS_RESULT message.
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      type: "ANALYZE",
      tabId,
      serverPath: msg.serverPath,
      backend: settings.backend,
    });
  } catch (err) {
    await pushOverlay(tabId, {
      state: "error",
      title: "Backend error",
      message:
        "Could not hand the clip over for analysis: " +
        String((err && err.message) || err),
    });
  }
}

// ---------------------------------------------------------------- overlay

/** Inject the overlay (if needed) and post a state update to it. */
async function pushOverlay(tabId, payload) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TRUEBEAT_STATE", payload });
  } catch (_) {
    // No content script in that tab (e.g. a chrome:// page): inject it.
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: [],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["overlay.js"],
      });
      await chrome.tabs.sendMessage(tabId, { type: "TRUEBEAT_STATE", payload });
    } catch (_) {
      // The tab cannot be scripted (chrome://, Web Store, PDF viewer…).
      // Nothing to do: the popup shows the error.
    }
  }
}
