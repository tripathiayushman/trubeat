/**
 * TrueBeat extension — options page.
 *
 * Two settings: the backend URL and the capture length. When the backend
 * is not a local address, saving asks Chrome for permission to reach that
 * origin (optional_host_permissions) — nothing is contacted until the user
 * grants it.
 */

const DEFAULTS = { backend: "http://127.0.0.1:7860", captureSeconds: 20 };

const backendInput = document.getElementById("backend");
const secondsInput = document.getElementById("seconds");
const saveBtn = document.getElementById("save");
const testBtn = document.getElementById("test");
const status = document.getElementById("status");
const permHint = document.getElementById("permHint");

function isLocal(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "[::1]"
    );
  } catch (_) {
    return true; // unparsable -> treat as local, the connection test decides
  }
}

function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  backendInput.value = s.backend || DEFAULTS.backend;
  secondsInput.value = s.captureSeconds || DEFAULTS.captureSeconds;
  if (isLocal(backendInput.value)) {
    permHint.textContent =
      "A local backend needs no extra permission — the extension already " +
      "has access to http://127.0.0.1/* and http://localhost/*.";
  }
}

async function ensurePermission(url) {
  if (isLocal(url)) return true;
  const pattern = originPattern(url);
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  if (granted) return true;
  return await chrome.permissions.request({ origins: [pattern] });
}

saveBtn.addEventListener("click", async () => {
  const backend = backendInput.value.trim().replace(/\/+$/, "") || DEFAULTS.backend;
  const seconds = Math.min(
    60,
    Math.max(12, Number(secondsInput.value) || DEFAULTS.captureSeconds)
  );
  try {
    const ok = await ensurePermission(backend);
    if (!ok) {
      status.textContent =
        "Permission to reach that backend was declined — the extension " +
        "cannot talk to it.";
      status.className = "status err";
      return;
    }
    await chrome.storage.local.set({ backend, captureSeconds: seconds });
    backendInput.value = backend;
    secondsInput.value = seconds;
    status.textContent = "Saved.";
    status.className = "status ok";
  } catch (err) {
    status.textContent = "Could not save: " + String((err && err.message) || err);
    status.className = "status err";
  }
});

testBtn.addEventListener("click", async () => {
  const backend = backendInput.value.trim().replace(/\/+$/, "");
  status.textContent = "Testing…";
  status.className = "status";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "PING_BACKEND",
      backend,
    });
    if (res && res.reachable) {
      status.textContent = res.hasAnalyze
        ? "Backend reachable and ready (analyze_video found)."
        : "Backend reachable, but it has no analyze_video endpoint.";
      status.className = res.hasAnalyze ? "status ok" : "status err";
    } else {
      status.textContent =
        "Backend unreachable — start it with: trubeat serve — or set the " +
        "backend URL in Options.";
      status.className = "status err";
    }
  } catch (err) {
    status.textContent =
      "Backend unreachable — start it with: trubeat serve — or set the " +
      "backend URL in Options.";
    status.className = "status err";
  }
});

load();
