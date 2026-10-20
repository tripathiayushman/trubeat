/**
 * TrueBeat extension — service worker.
 *
 * Responsibilities (and nothing else):
 *   1. own the capture lifecycle: popup -> tabCapture stream id -> offscreen
 *      recorder -> blob;
 *   2. talk to the user's configured backend (Gradio API);
 *   3. push state into the in-page overlay (shadow DOM panel).
 *
 * No detection logic lives here. The extension never computes a verdict:
 * it uploads the captured clip to the backend and renders whatever the
 * backend answers. Thresholds are never recalibrated client-side.
 *
 * Privacy: the only network destination is the backend URL the user set in
 * Options. Captures are never persisted; they are handed straight to the
 * backend and dropped.
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
      case "CAPTURE_DONE":
        await handleCaptureDone(msg);
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

/** The recorder finished: upload to the backend and render the answer. */
async function handleCaptureDone(msg) {
  const tabId = msg.tabId;
  current.active = false;

  if (!msg.blob || msg.blob.size === 0) {
    await pushOverlay(tabId, {
      state: "error",
      title: "Nothing was captured",
      message: "The recorder produced no data.",
    });
    return;
  }

  const settings = await getSettings();
  await pushOverlay(tabId, {
    state: "analyzing",
    message: "Analysing on your backend…",
  });

  let result;
  try {
    result = await analyseOnBackend(settings.backend, msg.blob, msg.filename);
  } catch (err) {
    await pushOverlay(tabId, {
      state: "error",
      title: "Backend error",
      message: String((err && err.message) || err),
    });
    return;
  }
  await pushOverlay(tabId, { state: "result", result });
}

/**
 * Upload the clip and read the verdict back.
 * Mirrors the flow verified against a local `trubeat serve`:
 *   POST /gradio_api/upload            -> ["<path>"]
 *   POST /gradio_api/call/<api_name>   -> {"event_id": "..."}
 *   GET  /gradio_api/call/<api_name>/<event_id>  (SSE) -> data: ["<json>"]
 */
async function analyseOnBackend(base, blob, filename) {
  const backend = normaliseBackend(base);

  // 1. discover the endpoint (the user may point at any TrueBeat backend)
  const infoRes = await fetch(backend + "/gradio_api/info", { cache: "no-store" });
  if (!infoRes.ok) {
    throw new Error(
      `The backend at ${backend} answered HTTP ${infoRes.status}. ` +
        "Is `trubeat serve` running?"
    );
  }
  const info = await infoRes.json();
  const endpoints = Object.keys((info && info.named_endpoints) || {});
  const apiName = endpoints.includes("/analyze_video")
    ? "/analyze_video"
    : endpoints.find((e) => e.endsWith("analyze_video"));
  if (!apiName) {
    throw new Error(
      "This backend does not expose the analyze_video endpoint " +
        `(found: ${endpoints.join(", ") || "none"}).`
    );
  }

  // 2. upload
  const form = new FormData();
  form.append("files", blob, filename || "capture.webm");
  const upRes = await fetch(backend + "/gradio_api/upload", {
    method: "POST",
    body: form,
  });
  if (!upRes.ok) {
    throw new Error(`Upload failed (HTTP ${upRes.status}).`);
  }
  const uploaded = await upRes.json();
  const path = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  if (!path) throw new Error("The backend accepted the upload but returned no path.");

  // 3. start the analysis
  const callRes = await fetch(backend + "/gradio_api/call" + apiName, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [{ path: path, meta: { _type: "gradio.FileData" } }],
    }),
  });
  if (!callRes.ok) {
    throw new Error(`The backend rejected the request (HTTP ${callRes.status}).`);
  }
  const { event_id: eventId } = await callRes.json();
  if (!eventId) throw new Error("The backend returned no event id.");

  // 4. read the SSE stream until the "complete" event
  const sseRes = await fetch(
    backend + "/gradio_api/call" + apiName + "/" + eventId
  );
  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`Could not read the result stream (HTTP ${sseRes.status}).`);
  }
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
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
            return JSON.parse(inner);
          } catch (_) {
            return { verdict: "inconclusive", headline: "Unreadable backend reply" };
          }
        }
        return inner;
      }
      if (parsed && parsed.error) {
        throw new Error("Backend error: " + JSON.stringify(parsed.error));
      }
    }
  }
  throw new Error("The backend stream ended without a result.");
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
